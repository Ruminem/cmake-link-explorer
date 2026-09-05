'use strict';

// Reads CMake's File API (https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html).
//
// The point of using the File API instead of parsing CMakeLists.txt: CMake already
// knows the fully resolved target graph and will hand it over as JSON. We only ask
// for it once (a query file) and then read the reply.

const fs = require('fs');
const path = require('path');

const CLIENT_NAME = 'cmake-link-explorer';

// Target types that participate in the link graph. UTILITY is excluded by default
// because custom targets and generator bookkeeping (ALL_BUILD, ZERO_CHECK) drown
// out the real structure.
const LINKABLE_TYPES = new Set([
  'EXECUTABLE',
  'STATIC_LIBRARY',
  'SHARED_LIBRARY',
  'MODULE_LIBRARY',
  'OBJECT_LIBRARY',
  'INTERFACE_LIBRARY'
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function apiRoot(buildDir) {
  return path.join(buildDir, '.cmake', 'api', 'v1');
}

function isBuildDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'CMakeCache.txt')).isFile();
  } catch (e) {
    return false;
  }
}

// Walks a few levels down looking for CMakeCache.txt. Stops descending as soon as
// it finds one, so we never wander into a build tree's internals.
function findBuildDirs(roots, maxDepth) {
  if (maxDepth === undefined) maxDepth = 3;
  const skip = new Set(['node_modules', 'CMakeFiles', 'Testing', '_deps', '__pycache__']);
  const found = [];

  const walk = (dir, depth) => {
    if (isBuildDir(dir)) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      // isDirectory() is false for symlinks, which conveniently avoids cycles.
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  for (const root of roots) walk(root, 0);
  return found;
}

// Creates the query file that asks CMake for a codemodel. CMake only writes the
// reply on its next configure run, so this alone is not enough.
function ensureQuery(buildDir) {
  const dir = path.join(apiRoot(buildDir), 'query', 'client-' + CLIENT_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'codemodel-v2');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  return file;
}

function hasReply(buildDir) {
  return findCodemodelFile(buildDir) !== null;
}

// The reply directory holds an index plus one file per object. Prefer our own
// client entry; fall back to any codemodel file, since another client (CMake Tools,
// for instance) may already have asked for one and we can reuse it.
function findCodemodelFile(buildDir) {
  const replyDir = path.join(apiRoot(buildDir), 'reply');
  let names;
  try {
    names = fs.readdirSync(replyDir);
  } catch (e) {
    return null;
  }

  const indexes = names.filter((n) => /^index-.*\.json$/.test(n)).sort();
  const newestIndex = indexes[indexes.length - 1];
  if (newestIndex) {
    try {
      const index = readJson(path.join(replyDir, newestIndex));
      const mine = index.reply && index.reply['client-' + CLIENT_NAME];
      const entry = mine && mine['codemodel-v2'];
      if (entry && entry.jsonFile) {
        return path.join(replyDir, entry.jsonFile);
      }
    } catch (e) {
      // Malformed index: fall through to the filename scan below.
    }
  }

  const direct = names.filter((n) => /^codemodel-v2-.*\.json$/.test(n)).sort();
  return direct.length ? path.join(replyDir, direct[direct.length - 1]) : null;
}

// CMake files linker options under the "libraries" role as well, most visibly
// -Wl,-rpath,... on macOS. Anything that starts with a dash and is not -l or
// -framework is an option, not a library.
function isLibraryFragment(text) {
  if (text.charAt(0) !== '-') return true; // a path to a library file
  return /^-l/.test(text) || /^-framework\b/.test(text);
}

// Pulls library names off the link line. Static libraries have no link step at all,
// so they legitimately return nothing here.
function linkLibraryFragments(target) {
  const link = target.link;
  if (!link || !Array.isArray(link.commandFragments)) return [];
  const out = [];
  for (const fragment of link.commandFragments) {
    if (fragment.role !== 'libraries' && fragment.role !== 'frameworks') continue;
    const text = (fragment.fragment || '').trim();
    if (text && isLibraryFragment(text)) out.push(text);
  }
  return out;
}

// CMake reports `dependencies` as the full build-order closure: an executable
// lists every library it ends up linking, not the handful named in its own
// target_link_libraries call. Reducing the graph to its minimal equivalent
// recovers the structure that was actually written, which is the whole point of
// the view -- otherwise every executable looks like it links everything.
function computeDirectDependencies(targets) {
  const reachableCache = new Map();

  const reachableFrom = (id, visiting) => {
    if (reachableCache.has(id)) return reachableCache.get(id);
    if (visiting.has(id)) return new Set(); // defensive: dependency cycles
    visiting.add(id);
    const out = new Set();
    for (const next of targets.get(id).dependencyIds) {
      out.add(next);
      for (const deep of reachableFrom(next, visiting)) out.add(deep);
    }
    visiting.delete(id);
    reachableCache.set(id, out);
    return out;
  };

  for (const target of targets.values()) {
    const deps = target.dependencyIds;
    target.directDependencyIds = deps.filter((candidate) =>
      !deps.some((other) => other !== candidate && reachableFrom(other, new Set()).has(candidate))
    );
  }
}

// A link fragment can point at a library this project builds, in which case it
// duplicates an entry we already have from `dependencies`. Match on the file name
// CMake said it would produce.
function makeInternalArtifactMatcher(targets) {
  const artifacts = new Set();
  for (const target of targets.values()) {
    if (target.nameOnDisk) artifacts.add(target.nameOnDisk);
  }
  return (fragment) => {
    const cleaned = fragment.replace(/^["']|["']$/g, '');
    return artifacts.has(path.basename(cleaned));
  };
}

/**
 * Loads the target graph for one configuration.
 *
 * @returns {{
 *   buildDir: string, sourceDir: string, configuration: string,
 *   configurations: string[], targets: Map<string, object>,
 *   linkedBy: Map<string, string[]>
 * }}
 */
function loadModel(buildDir, wantedConfiguration) {
  const codemodelFile = findCodemodelFile(buildDir);
  if (!codemodelFile) {
    throw new Error(
      'No CMake File API reply found in ' + buildDir + '. Run a CMake configure once so it can be generated.'
    );
  }

  const replyDir = path.dirname(codemodelFile);
  const codemodel = readJson(codemodelFile);
  const configurations = codemodel.configurations || [];
  if (!configurations.length) {
    throw new Error('The CMake codemodel contains no configurations.');
  }

  let configuration = configurations[0];
  if (wantedConfiguration) {
    const match = configurations.find((c) => c.name === wantedConfiguration);
    if (match) configuration = match;
  }

  const targets = new Map();
  for (const ref of configuration.targets || []) {
    let target;
    try {
      target = readJson(path.join(replyDir, ref.jsonFile));
    } catch (e) {
      continue; // A single unreadable target should not sink the whole view.
    }
    targets.set(target.id, {
      id: target.id,
      name: target.name,
      type: target.type,
      nameOnDisk: target.nameOnDisk || null,
      // Relative to the source root, e.g. "libs/map_engine".
      sourceDir: (target.paths && target.paths.source) || '',
      dependencyIds: (target.dependencies || []).map((d) => d.id),
      linkFragments: linkLibraryFragments(target),
      sourceCount: (target.sources || []).length
    });
  }

  const isInternalArtifact = makeInternalArtifactMatcher(targets);
  for (const target of targets.values()) {
    target.externalLibraries = dedupe(target.linkFragments.filter((f) => !isInternalArtifact(f)));
    delete target.linkFragments;
  }

  // `dependencies` can name targets that are not in this configuration (or utility
  // targets we later hide), so drop ids we cannot resolve.
  for (const target of targets.values()) {
    target.dependencyIds = target.dependencyIds.filter((id) => targets.has(id));
  }

  computeDirectDependencies(targets);

  // Built from direct edges so "linked by" names the targets that actually
  // declare the dependency, not every executable downstream of it.
  const linkedBy = new Map();
  for (const id of targets.keys()) linkedBy.set(id, []);
  for (const target of targets.values()) {
    for (const depId of target.directDependencyIds) {
      linkedBy.get(depId).push(target.id);
    }
  }

  return {
    buildDir: buildDir,
    sourceDir: (codemodel.paths && codemodel.paths.source) || '',
    configuration: configuration.name,
    configurations: configurations.map((c) => c.name),
    targets: targets,
    linkedBy: linkedBy
  };
}

function dedupe(items) {
  return Array.from(new Set(items));
}

function isLinkable(target) {
  return LINKABLE_TYPES.has(target.type);
}

/**
 * Shortest dependency path from one target to another, following "links" edges.
 * Answers "why does A end up pulling in Z?".
 *
 * @returns {string[]|null} target ids from `fromId` to `toId`, or null if unrelated.
 */
function findLinkPath(model, fromId, toId) {
  if (!model.targets.has(fromId) || !model.targets.has(toId)) return null;
  if (fromId === toId) return [fromId];

  const cameFrom = new Map([[fromId, null]]);
  const queue = [fromId];

  while (queue.length) {
    const current = queue.shift();
    for (const next of model.targets.get(current).directDependencyIds) {
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, current);
      if (next === toId) {
        const path = [];
        for (let at = next; at !== null; at = cameFrom.get(at)) path.push(at);
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

module.exports = {
  CLIENT_NAME,
  LINKABLE_TYPES,
  isBuildDir,
  findBuildDirs,
  ensureQuery,
  hasReply,
  findCodemodelFile,
  loadModel,
  isLinkable,
  isLibraryFragment,
  findLinkPath
};

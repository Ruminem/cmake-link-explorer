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

// Everything above except the entry points. An executable that nothing links is
// the normal case, not a finding. MODULE_LIBRARY is a plugin: it is dlopened
// rather than linked, so nothing naming it is equally normal.
const LIBRARY_TYPES = new Set([
  'STATIC_LIBRARY',
  'SHARED_LIBRARY',
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
//
// An edge i -> j is dropped when j is also reachable through another of i's
// dependencies. Because the sets CMake hands over are already closed, that test
// needs nothing more than the dependency sets themselves; no graph walk.
//
// The sets are bitmaps over target indices. A large project carries hundreds of
// thousands of edges, and comparing them as JavaScript Sets means one lookup per
// pair of dependencies, which runs into seconds. Word-wise ORs make it linear in
// the number of edges.
//
// If a project ever produced sets that were not closed, the union below would be
// too small and a few redundant edges would survive. That errs the safe way: an
// edge is only ever dropped when a real path to the same target exists, so
// nothing becomes unreachable.
function computeDirectDependencies(targets) {
  const ids = [...targets.keys()];
  const count = ids.length;
  if (!count) return;

  const indexOf = new Map();
  ids.forEach((id, index) => indexOf.set(id, index));

  const words = (count + 31) >> 5;
  const dependencyBits = new Array(count);
  for (let i = 0; i < count; i++) {
    const bits = new Uint32Array(words);
    for (const depId of targets.get(ids[i]).dependencyIds) {
      const j = indexOf.get(depId);
      if (j !== undefined) bits[j >> 5] |= 1 << (j & 31);
    }
    dependencyBits[i] = bits;
  }

  const covered = new Uint32Array(words);
  for (let i = 0; i < count; i++) {
    covered.fill(0);
    const own = dependencyBits[i];
    for (let w = 0; w < words; w++) {
      let bits = own[w];
      while (bits) {
        const lowest = bits & -bits;
        const j = (w << 5) + (31 - Math.clz32(lowest));
        bits ^= lowest;
        const other = dependencyBits[j];
        for (let k = 0; k < words; k++) covered[k] |= other[k];
      }
    }

    const target = targets.get(ids[i]);
    target.directDependencyIds = target.dependencyIds.filter((depId) => {
      const j = indexOf.get(depId);
      return j !== undefined && (covered[j >> 5] & (1 << (j & 31))) === 0;
    });
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
// CMake records where every target and every dependency came from, and hands it
// over as a graph of nodes each pointing at a file, a line and the command that
// ran there. Reading it beats searching the text for "add_library(<name>",
// which finds nothing as soon as the name is a variable or the call sits inside
// a helper function -- both of which are ordinary in a real project.
//
// Returns the chain innermost-first: the add_library() itself, then whatever
// called it. The top of each directory carries no line and is not a site, and
// CMake starts a fresh chain per directory, so the last entry is always the
// line somebody actually wrote.
function backtraceChain(graph, index) {
  if (!graph || !Array.isArray(graph.nodes) || typeof index !== 'number') return [];
  const files = graph.files || [];
  const commands = graph.commands || [];
  const chain = [];
  const seen = new Set();

  for (let at = index; typeof at === 'number' && !seen.has(at); at = graph.nodes[at].parent) {
    seen.add(at);
    const node = graph.nodes[at];
    if (!node) break;
    const file = files[node.file];
    if (typeof node.line === 'number' && typeof node.command === 'number' &&
        typeof file === 'string') {
      chain.push({ file, line: node.line, command: commands[node.command] || null });
    }
  }
  return chain;
}

// What a file is actually compiled with. CMake resolves generator expressions,
// inherited PUBLIC/INTERFACE settings and directory-level properties before
// writing this, so it is the effective set rather than what any one command in
// the CMakeLists said. Targets with mixed languages get one group each, and the
// sourceIndexes point back into the target's own source list.
function compileGroupsOf(target) {
  const groups = [];
  for (const group of target.compileGroups || []) {
    groups.push({
      language: group.language || null,
      standard: group.languageStandard ? group.languageStandard.standard || null : null,
      defines: (group.defines || []).map((d) => d.define).filter(Boolean),
      includes: (group.includes || []).filter((i) => typeof i.path === 'string').map((i) => ({
        // target_include_directories(x PUBLIC .) reaches the codemodel as
        // "<dir>/.", which is the same directory with a wart on the end.
        path: i.path.replace(/[\\/]\.$/, ''),
        isSystem: !!i.isSystem
      })),
      sourceIndexes: (group.sourceIndexes || []).filter((n) => typeof n === 'number')
    });
  }
  return groups;
}

function dependencySites(target, graph) {
  const sites = new Map();
  // linkLibraries first: it is the link line as written, so it carries the edge
  // that closes a cycle, which `dependencies` drops to keep a build order.
  for (const list of [target.linkLibraries, target.dependencies]) {
    for (const entry of list || []) {
      if (!entry || !entry.id || sites.has(entry.id)) continue;
      const chain = backtraceChain(graph, entry.backtrace);
      if (chain.length) sites.set(entry.id, chain[chain.length - 1]);
    }
  }
  return sites;
}

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
    const chain = backtraceChain(target.backtraceGraph, target.backtrace);
    targets.set(target.id, {
      id: target.id,
      name: target.name,
      type: target.type,
      nameOnDisk: target.nameOnDisk || null,
      // Where to jump when this target is clicked: the line somebody wrote,
      // and -- when a helper function stands between that and the actual
      // add_library() -- where the command really ran.
      declaration: chain.length ? chain[chain.length - 1] : null,
      declaredVia: chain.length > 1 ? chain[0] : null,
      // depId -> the target_link_libraries() that pulled it in.
      dependencySites: dependencySites(target, target.backtraceGraph),
      // Effective macros and include paths, per language group.
      compileGroups: compileGroupsOf(target),
      // The link edges as written. `dependencies` is a build order, so CMake
      // drops whichever edge closes a cycle -- c linking a comes back empty
      // there while it is still here. Older codemodels omit the field, which is
      // why the model records whether it saw one at all.
      linkTargetIds: Array.isArray(target.linkLibraries)
        ? target.linkLibraries.map((l) => l && l.id).filter(Boolean) : null,
      // An installed library is the deliverable; nothing linking it is normal.
      isInstalled: !!(target.install && (target.install.destinations || []).length),
      // Relative to the source root, e.g. "libs/engine".
      sourceDir: (target.paths && target.paths.source) || '',
      dependencyIds: (target.dependencies || []).map((d) => d.id),
      linkFragments: linkLibraryFragments(target),
      // Relative to the source root. Needed to work out which target compiles a
      // given file, and which one provides a given header.
      sources: (target.sources || []).map((s) => s.path),
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

  // A target that links nothing omits the field entirely, so "every target has
  // one" is never true. One target having it is what says the codemodel is new
  // enough to be carrying them at all; an older reply has none anywhere, and
  // the cycle check then reports that it cannot tell rather than "no cycles".
  const hasLinkGraph = Array.from(targets.values())
    .some((t) => Array.isArray(t.linkTargetIds));
  for (const target of targets.values()) {
    target.linkTargetIds = Array.isArray(target.linkTargetIds)
      ? target.linkTargetIds.filter((id) => targets.has(id)) : [];
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
    linkedBy: linkedBy,
    hasLinkGraph: hasLinkGraph
  };
}

/**
 * Cycles in the link graph.
 *
 * Has to read `linkTargetIds` rather than the dependency graph: CMake builds
 * `dependencies` as a build order, so the edge that closes a cycle is simply
 * absent there. CMake allows cycles between static libraries and resolves them
 * by repeating the archives on the link line, so they configure and build --
 * they just make the structure much harder to reason about than it looks.
 *
 * Tarjan, with an explicit stack: a project with a few thousand targets would
 * otherwise recurse as deep as it has targets.
 *
 * @returns {Array<string[]>|null} one entry per cycle, or null when this
 *          codemodel does not carry the link lists to tell either way
 */
function findCycles(model) {
  if (!model.hasLinkGraph) {
    // Without the link lists the edge that closes a cycle is invisible, so the
    // honest answer is "cannot tell" rather than "none". The exception is a
    // project with no edges at all, where there is nothing to close.
    const anyEdges = Array.from(model.targets.values())
      .some((t) => t.directDependencyIds.length || t.dependencyIds.length);
    return anyEdges ? null : [];
  }

  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  for (const root of model.targets.keys()) {
    if (index.has(root)) continue;
    const work = [{ id: root, next: 0 }];

    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.next === 0) {
        index.set(frame.id, counter);
        low.set(frame.id, counter);
        counter++;
        stack.push(frame.id);
        onStack.add(frame.id);
      }

      const edges = model.targets.get(frame.id).linkTargetIds;
      if (frame.next < edges.length) {
        const next = edges[frame.next++];
        if (!index.has(next)) work.push({ id: next, next: 0 });
        else if (onStack.has(next)) low.set(frame.id, Math.min(low.get(frame.id), index.get(next)));
        continue;
      }

      if (low.get(frame.id) === index.get(frame.id)) {
        const component = [];
        for (;;) {
          const id = stack.pop();
          onStack.delete(id);
          component.push(id);
          if (id === frame.id) break;
        }
        // A component of one is a cycle only if the target links itself.
        if (component.length > 1 ||
            model.targets.get(frame.id).linkTargetIds.indexOf(frame.id) !== -1) {
          components.push(component);
        }
      }

      work.pop();
      if (work.length) {
        const parent = work[work.length - 1];
        low.set(parent.id, Math.min(low.get(parent.id), low.get(frame.id)));
      }
    }
  }

  return components.map((component) => orderCycle(model, component));
}

// Tarjan hands back a set. Walking it into a path makes the report readable as
// "a links b links c links a" rather than a bag of three names.
function orderCycle(model, component) {
  const members = new Set(component);
  const start = component[component.length - 1];
  const cameFrom = new Map([[start, null]]);
  const queue = [start];

  while (queue.length) {
    const id = queue.shift();
    for (const next of model.targets.get(id).linkTargetIds) {
      if (!members.has(next)) continue;
      if (next === start) {
        const path = [id];
        for (let at = cameFrom.get(id); at; at = cameFrom.get(at)) path.push(at);
        path.reverse();
        return path;
      }
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, id);
      queue.push(next);
    }
  }
  return component;
}

/**
 * Libraries nothing links.
 *
 * Executables and utility targets are entry points, and an installed library is
 * the deliverable, so none of those count. Incoming edges are taken from both
 * the dependency graph and the link lists, because each misses something the
 * other has.
 */
function findUnusedTargets(model) {
  const linked = new Set();
  for (const [id, sources] of model.linkedBy) {
    if (sources.length) linked.add(id);
  }
  for (const target of model.targets.values()) {
    for (const id of target.linkTargetIds || []) linked.add(id);
  }

  const unused = [];
  for (const target of model.targets.values()) {
    if (!LIBRARY_TYPES.has(target.type)) continue;
    if (target.isInstalled || linked.has(target.id)) continue;
    unused.push(target);
  }
  return unused;
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
  backtraceChain,
  findCycles,
  findUnusedTargets,
  isLinkable,
  isLibraryFragment,
  reduceDependencies: computeDirectDependencies,
  findLinkPath
};

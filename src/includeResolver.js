'use strict';

// Answers the question that actually stops people mid-edit:
//
//   "I want to #include this header and call something in it. Which library do I
//    have to link, and does my CMakeLists.txt already do it?"
//
// Everything here works off the File API model that fileApi.js already builds.

const fs = require('fs');
const path = require('path');

// One collator reused everywhere: String.prototype.localeCompare builds a new
// one on every call, which is most of the cost of sorting a large target list.
const byName = new Intl.Collator(undefined, { sensitivity: 'variant' });

const HEADER_EXTENSIONS = ['.h', '.hpp', '.hh', '.hxx', '.inl', '.ipp'];

/** Pulls the quoted or angled path out of an #include line, if that is what it is. */
function parseIncludeLine(line) {
  const match = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(line || '');
  return match ? match[1].trim() : null;
}

function isHeader(file) {
  return HEADER_EXTENSIONS.indexOf(path.extname(file).toLowerCase()) !== -1;
}

// Takes anything: a target's source list is whatever the codemodel held, and a
// caller can reach here with a path the editor never filled in. Comparing an
// absent path against nothing is the honest answer; throwing out of a lookup
// is not.
function normalise(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : '';
}

// Windows and the default macOS volume are case-insensitive, and VS Code does
// not always hand back the same casing CMake recorded -- a drive letter alone is
// enough to differ. Comparing paths literally there silently matches nothing.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function pathKey(p) {
  const text = normalise(p);
  return CASE_INSENSITIVE ? text.toLowerCase() : text;
}

/**
 * Which target compiles this file.
 *
 * CMake lists every source it was given, so this is exact for .cpp files. A
 * header only appears when the project bothered to list it, which is why the
 * directory fallback exists.
 *
 * @returns {object|null} the target, or null when the file belongs to none
 */
function targetOwningFile(model, absoluteFile) {
  const file = pathKey(absoluteFile);
  const root = pathKey(model.sourceDir);

  for (const target of model.targets.values()) {
    for (const source of target.sources || []) {
      const full = path.isAbsolute(source) ? pathKey(source) : root + '/' + pathKey(source);
      if (full === file) return target;
    }
  }

  // Fall back to the target whose own source directory is the closest ancestor.
  let best = null;
  for (const target of model.targets.values()) {
    if (!target.sourceDir) continue;
    const dir = root + '/' + pathKey(target.sourceDir) + '/';
    if (file.startsWith(dir) && (!best || target.sourceDir.length > best.sourceDir.length)) {
      best = target;
    }
  }
  return best;
}

/**
 * The macros and include paths a file is actually compiled with.
 *
 * CMake attaches these to a compile group rather than to a file, and lists which
 * of the target's sources belong to each. Headers are not compiled, so they are
 * in no group at all; when the target has exactly one, that is what including
 * them ends up meaning, and the answer is marked as inferred rather than read.
 *
 * @returns {{target: object, group: object|null, exact: boolean}|null}
 */
function compileSettingsForFile(model, absoluteFile) {
  const target = targetOwningFile(model, absoluteFile);
  if (!target) return null;

  const groups = target.compileGroups || [];
  const file = pathKey(absoluteFile);
  const root = pathKey(model.sourceDir);
  const index = (target.sources || []).findIndex((source) => {
    const full = path.isAbsolute(source) ? pathKey(source) : root + '/' + pathKey(source);
    return full === file;
  });

  const owning = index === -1 ? null
    : groups.find((group) => group.sourceIndexes.indexOf(index) !== -1) || null;
  if (owning) return { target, group: owning, exact: true };
  return { target, group: groups.length === 1 ? groups[0] : null, exact: false };
}

/**
 * Every header under the source tree, indexed by file name.
 *
 * Built once per model and kept on a WeakMap, because the alternative -- asking
 * the filesystem about each target in turn -- costs one directory walk per
 * target. On a two thousand target project that was two thousand readdir calls
 * for a single unresolved include, on a path the editor hits whenever the cursor
 * moves onto one.
 */
const headerIndexes = new WeakMap();
const MAX_INDEX_DEPTH = 12;
const MAX_INDEX_FILES = 200000;

function headerIndex(model) {
  const cached = headerIndexes.get(model);
  if (cached) return cached;

  // Headers CMake was told about, and the directory each target owns. Both are
  // looked at for every #include the cursor lands on, so scanning every target's
  // source list each time showed up as milliseconds per keystroke.
  const declared = new Map();
  const directories = [];
  for (const target of model.targets.values()) {
    for (const source of target.sources || []) {
      if (!isHeader(source)) continue;
      const key = pathKey(path.basename(source));
      const entry = { target, path: normalise(source), key: pathKey(source) };
      const list = declared.get(key);
      if (list) list.push(entry);
      else declared.set(key, [entry]);
    }
    if (target.sourceDir) directories.push({ key: pathKey(target.sourceDir) + '/', target });
  }
  // Longest first, so the closest enclosing target wins.
  directories.sort((a, b) => b.key.length - a.key.length);

  const root = normalise(model.sourceDir);
  const byName = new Map();
  const skip = new Set(['node_modules', 'CMakeFiles', '_deps', 'build', 'out', 'Testing']);
  let seen = 0;

  const walk = (dir, relative, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (seen >= MAX_INDEX_FILES) return;
      if (entry.isFile()) {
        if (!isHeader(entry.name)) continue;
        seen++;
        const key = CASE_INSENSITIVE ? entry.name.toLowerCase() : entry.name;
        const list = byName.get(key);
        const value = relative ? relative + '/' + entry.name : entry.name;
        if (list) list.push(value);
        else byName.set(key, [value]);
      } else if (entry.isDirectory() && depth < MAX_INDEX_DEPTH &&
                 !entry.name.startsWith('.') && !skip.has(entry.name)) {
        walk(path.join(dir, entry.name), relative ? relative + '/' + entry.name : entry.name, depth + 1);
      }
    }
  };

  walk(root, '', 0);
  const index = {
    byName, declared, directories,
    truncated: seen >= MAX_INDEX_FILES,
    builtAt: Date.now()
  };
  headerIndexes.set(model, index);
  return index;
}

// Writing a header and immediately including it is the ordinary way this comes
// up, and the index would not know about the new file until CMake was run again.
// Rebuilding on a miss keeps hits free and costs one walk at most this often.
const INDEX_REFRESH_MS = 5000;

function refreshedIndex(model, index) {
  if (Date.now() - index.builtAt < INDEX_REFRESH_MS) return index;
  headerIndexes.delete(model);
  return headerIndex(model);
}

// The target whose own source directory is the closest ancestor of a path.
function targetOwningPath(directories, relativePath) {
  const file = pathKey(relativePath);
  for (const entry of directories) {
    if (file.startsWith(entry.key)) return entry.target;
  }
  return null;
}

/**
 * Which targets could provide a header, best first.
 *
 * Three signals, in descending order of trust:
 *   listed   the header is in the target's source list, so CMake knows it
 *   owned    the header sits inside the target's own source directory
 *   nearby   a file of that name exists somewhere under the target's directory
 *
 * @returns {Array<{target: object, file: string, how: string}>}
 */
function providersOfHeader(model, includePath, isLinkable) {
  const wanted = normalise(includePath);
  const wantedKey = pathKey(includePath);
  const base = path.basename(wanted);
  const bareName = wanted.indexOf('/') === -1;
  const found = new Map();

  const add = (target, file, how, rank) => {
    const existing = found.get(target.id);
    if (!existing || rank < existing.rank) found.set(target.id, { target, file, how, rank });
  };

  const index = headerIndex(model);
  // Only targets you could actually link. A UTILITY target cannot provide a
  // header, and in a project like abseil one of them is declared at the repo
  // root, which would otherwise make it claim every header in the tree.
  const usable = (target) => !isLinkable || isLinkable(target);
  const baseKey = pathKey(base);

  for (const entry of index.declared.get(baseKey) || []) {
    if (!usable(entry.target)) continue;
    if (entry.key === wantedKey || entry.key.endsWith('/' + wantedKey)) {
      add(entry.target, entry.path, 'listed', 0);
    } else if (bareName) {
      // Only trust a bare file name when that is all the #include gave us;
      // "absl/base/config.h" must not match "absl/flags/config.h".
      add(entry.target, entry.path, 'listed', 1);
    }
  }

  // A target that lists the header is authoritative, so stop before the weaker
  // location-based guesses can add noise.
  if ([...found.values()].some((row) => row.rank === 0)) return sorted(found);

  let filesystem = index;
  if (!(filesystem.byName.get(baseKey) || []).length) {
    filesystem = refreshedIndex(model, index);
  }

  const directories = filesystem.directories.filter((d) => usable(d.target));
  for (const relative of filesystem.byName.get(baseKey) || []) {
    const key = pathKey(relative);
    const target = targetOwningPath(directories, relative);
    if (!target) continue;

    if (key === wantedKey || key.endsWith('/' + wantedKey)) {
      // The include path resolves inside this target's directory.
      add(target, relative, 'owned', 1);
    } else if (!bareName && key === pathKey(target.sourceDir + '/' + wanted)) {
      add(target, relative, 'owned', 2);
    } else if (bareName) {
      add(target, relative, 'nearby', 3);
    }
  }

  return sorted(found);
}

// Deepest source directory first among equals: a target in absl/strings is a
// better answer than one in absl for a header under absl/strings.
function sorted(found) {
  return [...found.values()]
    .sort((a, b) =>
      a.rank - b.rank ||
      (b.target.sourceDir || '').length - (a.target.sourceDir || '').length ||
      byName.compare(a.target.name, b.target.name))
    .map(({ target, file, how }) => ({ target, file, how }));
}

/**
 * Works out what, if anything, needs to change for `fromTarget` to use a header.
 *
 * @returns {{
 *   status: 'already-linked'|'transitive'|'needs-link'|'same-target'|'not-found'|'unknown-target',
 *   provider?: object, via?: object, candidates: Array, suggestion?: string
 * }}
 */
function resolve(model, absoluteFile, includePath, isLinkable) {
  const fromTarget = targetOwningFile(model, absoluteFile);
  const candidates = providersOfHeader(model, includePath, isLinkable);

  if (!fromTarget) return { status: 'unknown-target', candidates };
  if (!candidates.length) return { status: 'not-found', candidates, from: fromTarget };

  const provider = candidates[0].target;
  const result = { from: fromTarget, provider, candidates, header: candidates[0].file };

  if (provider.id === fromTarget.id) {
    return Object.assign(result, { status: 'same-target' });
  }
  if (fromTarget.directDependencyIds.indexOf(provider.id) !== -1) {
    return Object.assign(result, { status: 'already-linked' });
  }
  if (fromTarget.dependencyIds.indexOf(provider.id) !== -1) {
    // Reachable, but only because something else drags it in. That works today
    // and silently breaks the day the middle library stops using it.
    return Object.assign(result, {
      status: 'transitive',
      keyword: scopeFor(fromTarget, absoluteFile)
    });
  }
  return Object.assign(result, {
    status: 'needs-link',
    keyword: scopeFor(fromTarget, absoluteFile),
    suggestion: 'target_link_libraries(' + fromTarget.name + ' ' +
                scopeFor(fromTarget, absoluteFile) + ' ' + provider.name + ')'
  });
}

/**
 * Which keyword the new dependency needs.
 *
 * PRIVATE is right for an include in a .cpp: nobody else sees it. An include in
 * a header is part of this target's own interface, so anything consuming the
 * target sees it too and the dependency has to travel with it.
 */
function scopeFor(target, includingFile) {
  if (target.type === 'INTERFACE_LIBRARY') return 'INTERFACE';
  return isHeader(includingFile) ? 'PUBLIC' : 'PRIVATE';
}

module.exports = {
  parseIncludeLine,
  isHeader,
  targetOwningFile,
  compileSettingsForFile,
  providersOfHeader,
  scopeFor,
  __headerIndexForTests: headerIndex,
  resolve
};

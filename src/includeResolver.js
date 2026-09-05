'use strict';

// Answers the question that actually stops people mid-edit:
//
//   "I want to #include this header and call something in it. Which library do I
//    have to link, and does my CMakeLists.txt already do it?"
//
// Everything here works off the File API model that fileApi.js already builds.

const fs = require('fs');
const path = require('path');

const HEADER_EXTENSIONS = ['.h', '.hpp', '.hh', '.hxx', '.inl', '.ipp'];

/** Pulls the quoted or angled path out of an #include line, if that is what it is. */
function parseIncludeLine(line) {
  const match = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(line || '');
  return match ? match[1].trim() : null;
}

function isHeader(file) {
  return HEADER_EXTENSIONS.indexOf(path.extname(file).toLowerCase()) !== -1;
}

function normalise(p) {
  return p.replace(/\\/g, '/');
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
  const file = normalise(absoluteFile);
  const root = normalise(model.sourceDir);

  let best = null;
  for (const target of model.targets.values()) {
    for (const source of target.sources || []) {
      const full = path.isAbsolute(source) ? normalise(source) : root + '/' + normalise(source);
      if (full === file) return target;
    }
  }

  // Fall back to the target whose own source directory is the closest ancestor.
  for (const target of model.targets.values()) {
    if (!target.sourceDir) continue;
    const dir = root + '/' + normalise(target.sourceDir) + '/';
    if (file.startsWith(dir) && (!best || target.sourceDir.length > best.sourceDir.length)) {
      best = target;
    }
  }
  return best;
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
  const base = path.basename(wanted);
  const bareName = wanted.indexOf('/') === -1;
  const root = normalise(model.sourceDir);
  const found = new Map();

  const add = (target, file, how, rank) => {
    const existing = found.get(target.id);
    if (!existing || rank < existing.rank) found.set(target.id, { target, file, how, rank });
  };

  // Only targets you could actually link. A UTILITY target cannot provide a
  // header, and in a project like abseil one of them is declared at the repo
  // root, which would otherwise make it claim every header in the tree.
  const targets = [...model.targets.values()].filter((t) => !isLinkable || isLinkable(t));

  for (const target of targets) {
    for (const source of target.sources || []) {
      const normalised = normalise(source);
      if (!isHeader(normalised)) continue;
      if (normalised === wanted || normalised.endsWith('/' + wanted)) {
        add(target, normalised, 'listed', 0);
      } else if (bareName && path.basename(normalised) === base) {
        // Only trust a bare file name when that is all the #include gave us;
        // "absl/base/config.h" must not match "absl/flags/config.h".
        add(target, normalised, 'listed', 1);
      }
    }
  }

  // A target that lists the header is authoritative, so stop before the weaker
  // directory-based guesses can add noise.
  if ([...found.values()].some((row) => row.rank === 0)) return sorted(found);

  for (const target of targets) {
    // A target declared at the source root owns nothing in particular.
    if (!target.sourceDir) continue;
    const dir = root + '/' + normalise(target.sourceDir);

    // The include path often starts with the directory the target lives in,
    // e.g. "absl/strings/str_join.h" for the target in absl/strings.
    if (wanted.startsWith(normalise(target.sourceDir) + '/') && fileExists(root + '/' + wanted)) {
      add(target, wanted, 'owned', 1);
      continue;
    }
    if (fileExists(dir + '/' + wanted)) {
      add(target, path.relative(root, dir + '/' + wanted), 'owned', 2);
      continue;
    }
    if (bareName) {
      const nearby = findByName(dir, base, 3);
      if (nearby) add(target, path.relative(root, nearby), 'nearby', 3);
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
      a.target.name.localeCompare(b.target.name))
    .map(({ target, file, how }) => ({ target, file, how }));
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

// Shallow search so a wide source tree does not turn this into a crawl.
function findByName(dir, name, maxDepth) {
  const skip = new Set(['build', 'node_modules', 'CMakeFiles', '.git', '_deps']);
  const walk = (current, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === name) return path.join(current, entry.name);
    }
    if (depth >= maxDepth) return null;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const hit = walk(path.join(current, entry.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(dir, 0);
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
  providersOfHeader,
  scopeFor,
  resolve
};

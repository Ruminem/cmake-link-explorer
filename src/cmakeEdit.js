'use strict';

// Works out the smallest edit that adds a library to a target, and where in the
// CMakeLists.txt it goes. Deliberately conservative: it only ever appends to an
// existing target_link_libraries() call or adds one right after the target is
// declared, and it reports what it could not do rather than guessing.

const fs = require('fs');
const path = require('path');

/**
 * Records where every unescaped double quote sits, so that "is this position
 * inside a string?" is a binary search instead of a rescan from the start of the
 * file. A large CMakeLists.txt turns the naive version into an O(n^2) walk.
 */
function quoteIndex(text) {
  const positions = [];
  let inside = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inside) {
      if (c === '\\') { i++; continue; }
      if (c === '"') { positions.push(i); inside = false; }
      continue;
    }
    // Outside a string a '#' comments out the rest of the line, quotes and all.
    // Counting one of those flipped the parity for everything after it, so a
    // lone quote in a comment -- `# a 24" monitor` -- made the rest of the file
    // look like one long string and no command in it could be found.
    if (c === '#') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (c === '"') { positions.push(i); inside = true; }
  }
  const quotes = Int32Array.from(positions);

  return {
    // Odd number of quotes before the position means it is inside one.
    inString(index) {
      let low = 0;
      let high = quotes.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (quotes[mid] < index) low = mid + 1;
        else high = mid;
      }
      return (low & 1) === 1;
    }
  };
}

/**
 * Finds a CMake command invocation whose first argument is `firstArgument`.
 *
 * @returns {{start:number, open:number, close:number, args:string}|null}
 *          character offsets into `text`
 */
function findCommand(text, names, firstArgument) {
  const wanted = Array.isArray(names) ? names : [names];
  const pattern = new RegExp('(^|[\\s)])(' + wanted.join('|') + ')\\s*\\(', 'gi');
  const quotes = quoteIndex(text);

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const nameStart = match.index + match[1].length;
    const open = match.index + match[0].length - 1;
    if (inCommentOrString(text, nameStart, quotes)) continue;

    const close = matchParen(text, open);
    if (close === -1) continue;

    const args = text.slice(open + 1, close);
    const first = args.trim().split(/\s+/)[0];
    if (first === firstArgument) {
      return { start: nameStart, open, close, args, name: match[2] };
    }
  }
  return null;
}

function matchParen(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    // Strings are stepped over below, so a '#' reached here starts a comment.
    if (c === '#') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) return -1;
      i = newline;
      continue;
    }
    if (c === '"') {
      i = skipString(text, i);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipString(text, quoteIndexAt) {
  for (let i = quoteIndexAt + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') return i;
  }
  return text.length;
}

function inCommentOrString(text, index, quotes) {
  if (quotes.inString(index)) return true;
  // A '#' earlier on the same line starts a comment, unless it is quoted.
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  for (let i = text.indexOf('#', lineStart); i !== -1 && i < index; i = text.indexOf('#', i + 1)) {
    if (!quotes.inString(i)) return true;
  }
  return false;
}

// Commands that open a block. A target_link_libraries() inside one only runs
// some of the time, so appending to it links the library only some of the time
// -- on one platform, in one configuration -- and the preview shows none of
// that. Reproduced against an `if(WIN32)` guard that came before the real call.
const BLOCK_OPENERS = ['if', 'foreach', 'while', 'function', 'macro', 'block'];
const BLOCK_CLOSERS = BLOCK_OPENERS.map((name) => 'end' + name);

// `else` and `elseif` are left out on purpose: they do not change the depth.
// The leading (^|[\\s)]) is what keeps `endif(` from reading as an `if(`.
function blockDepthAt(text, offset, quotes) {
  const pattern = new RegExp(
    '(^|[\\s)])(' + BLOCK_OPENERS.concat(BLOCK_CLOSERS).join('|') + ')\\s*\\(', 'gi');
  let depth = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const nameStart = match.index + match[1].length;
    if (nameStart >= offset) break;
    if (inCommentOrString(text, nameStart, quotes)) continue;
    if (match[2].toLowerCase().indexOf('end') === 0) depth = Math.max(0, depth - 1);
    else depth++;
  }
  return depth;
}

const LINK_SCOPES = ['PUBLIC', 'PRIVATE', 'INTERFACE'];

// The scope keywords a call is written with, in order. A library appended after
// the last one joins that section, so adding to a call ending in INTERFACE
// gives the target something it does not itself link -- which is the exact
// problem the suggestion was raised to fix. An empty list means the plain
// signature, which takes no keyword at all.
function scopeSections(args) {
  return args.replace(/#[^\n]*/g, ' ')
    .split(/\s+/)
    .map((word) => word.toUpperCase())
    .filter((word) => LINK_SCOPES.indexOf(word) !== -1);
}

// Where CMake says the target was declared, which is not always the
// CMakeLists.txt of its source directory -- a target created inside an
// include()d .cmake is declared somewhere else entirely.
function cmakeListsFor(model, target) {
  if (target.declaration && target.declaration.file) {
    return path.join(model.sourceDir, target.declaration.file);
  }
  return path.join(model.sourceDir, target.sourceDir || '', 'CMakeLists.txt');
}

function offsetToPosition(text, offset) {
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) || []).length;
  const character = offset - (before.lastIndexOf('\n') + 1);
  return { line, character };
}

/**
 * Plans the edit that makes `library` available to `target`.
 *
 * @returns {{
 *   file: string, kind: 'append'|'create', offset: number, insert: string,
 *   position: {line:number, character:number}, preview: string
 * } | {file: string|null, kind: 'manual', reason: string}}
 */
function planLinkEdit(model, target, library, keyword) {
  const scope = (keyword || 'PRIVATE').toUpperCase();
  const file = cmakeListsFor(model, target);

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { file: null, kind: 'manual', reason: 'Could not read ' + file };
  }

  // CMakeLists.txt on Windows is usually CRLF. Writing a bare \n into it leaves
  // one mixed line that every diff and line-ending lint then picks up.
  const eol = text.indexOf('\r\n') === -1 ? '\n' : '\r\n';
  const quotes = quoteIndex(text);

  const existing = findCommand(text, ['target_link_libraries'], target.name);
  const sections = existing ? scopeSections(existing.args) : [];
  const lastSection = sections.length ? sections[sections.length - 1] : null;

  // Why the existing call cannot simply be extended. Kept as a sentence so it
  // can be handed to the user rather than silently changing what gets written.
  let cannotAppend = null;
  if (existing) {
    if (blockDepthAt(text, existing.start, quotes) > 0) {
      cannotAppend = 'the target_link_libraries(' + target.name + ') already in ' +
        path.basename(file) + ' sits inside an if()/foreach() block, so adding ' +
        library + ' to it would link it only when that block runs';
    } else if (lastSection && lastSection !== scope) {
      cannotAppend = 'the target_link_libraries(' + target.name + ') already in ' +
        path.basename(file) + ' ends in an ' + lastSection + ' section, and ' +
        library + ' has to be ' + scope;
    }
  }

  if (existing && !cannotAppend) {
    // Match the indentation the call already uses so the edit is invisible in a
    // diff apart from the new line.
    const lines = text.slice(existing.open + 1, existing.close).split('\n');
    const indented = lines.slice(1).find((l) => /^\s+\S/.test(l));
    const indent = indented ? /^(\s+)/.exec(indented)[1] : '    ';
    const multiline = lines.length > 1;

    const insert = multiline ? eol + indent + library : ' ' + library;
    const offset = trimBackFrom(text, existing.close);
    return {
      file,
      kind: 'append',
      offset,
      insert,
      position: offsetToPosition(text, offset),
      // Naming the section it lands in, because that is the part that decides
      // whether the target actually links the library.
      preview: 'target_link_libraries(' + target.name + ' ... ' +
               (lastSection ? lastSection + ' ... ' : '') + library + ')'
    };
  }

  // A second call is valid CMake and unambiguous, which is why declining to
  // append is not the end of the road -- but only when a keyword call is legal
  // here at all. Mixing the plain and keyword signatures on one target is an
  // error CMake refuses outright, so that case is handed back.
  if (existing && !sections.length) {
    return {
      file,
      kind: 'manual',
      reason: cannotAppend + ', and the call uses the plain signature, which ' +
              'cannot be mixed with a ' + scope + ' one. Add it by hand.'
    };
  }

  const declaration = findCommand(text, ['add_executable', 'add_library'], target.name);
  if (!declaration) {
    return {
      file,
      kind: 'manual',
      reason: target.name + ' is not declared in ' + path.basename(file) +
              '; add target_link_libraries(' + target.name + ' ' + scope + ' ' + library + ') by hand.'
    };
  }
  if (blockDepthAt(text, declaration.start, quotes) > 0) {
    return {
      file,
      kind: 'manual',
      reason: target.name + ' is declared inside an if()/foreach() block in ' +
              path.basename(file) + ', so there is no unconditional place to put ' +
              'target_link_libraries(' + target.name + ' ' + scope + ' ' + library + '). Add it by hand.'
    };
  }

  const lineEnd = text.indexOf('\n', declaration.close);
  const offset = lineEnd === -1 ? text.length : lineEnd + 1;
  const statement = 'target_link_libraries(' + target.name + ' ' + scope + ' ' + library + ')' + eol;
  const needsBlankLine = !/\n\s*\n$/.test(text.slice(0, offset));

  return {
    file,
    kind: 'create',
    offset,
    insert: (needsBlankLine ? eol : '') + statement,
    position: offsetToPosition(text, offset),
    preview: statement.trim(),
    // Set when a call was there but could not be extended, so the caller can
    // say why a second one is appearing instead.
    insteadOfAppending: cannotAppend || undefined
  };
}

// Steps back over whitespace before the closing paren so the new entry lands
// after the last real argument rather than after a trailing newline.
function trimBackFrom(text, closeIndex) {
  let i = closeIndex;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  return i;
}

module.exports = { findCommand, planLinkEdit, offsetToPosition };

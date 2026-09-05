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
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') positions.push(i);
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
  const scope = keyword || 'PRIVATE';
  const file = path.join(model.sourceDir, target.sourceDir || '', 'CMakeLists.txt');

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { file: null, kind: 'manual', reason: 'Could not read ' + file };
  }

  // CMakeLists.txt on Windows is usually CRLF. Writing a bare \n into it leaves
  // one mixed line that every diff and line-ending lint then picks up.
  const eol = text.indexOf('\r\n') === -1 ? '\n' : '\r\n';

  const existing = findCommand(text, ['target_link_libraries'], target.name);
  if (existing) {
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
      preview: 'target_link_libraries(' + target.name + ' ... ' + library + ')'
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
    preview: statement.trim()
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

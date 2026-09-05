'use strict';

// Parses linker map files into one shape the views can render.
//
// Two formats are supported, both verified against real linker output:
//   gnu-ld  binutils ld, -Wl,-Map=out.map   (the usual embedded case)
//   ld64    Apple's linker, -Wl,-map,out.map
//
// LLVM lld writes a third format. It is deliberately not guessed at here; add it
// when there is a real sample to check against.

const fs = require('fs');
const path = require('path');

const HEX = '0x[0-9a-fA-F]+';

function detectFormat(text) {
  const head = text.slice(0, 4000);
  if (/^# Path:/m.test(head) && /^# Object files:/m.test(head)) return 'ld64';
  if (/^Linker script and memory map$/m.test(text) || /^Memory Configuration$/m.test(text)) {
    return 'gnu-ld';
  }
  return null;
}

// ---------------------------------------------------------------- shared

// GNU ld writes archive members as "libfoo.a(bar.o)"; everything else is a plain
// path. "linker stubs" and similar pseudo-files have no extension at all.
function splitOrigin(raw) {
  const text = raw.trim();
  const archiveMatch = /^(.*\.a)\(([^)]+)\)$/.exec(text);
  if (archiveMatch) {
    return { archive: archiveMatch[1], object: archiveMatch[2] };
  }
  return { archive: null, object: text };
}

function originKey(origin) {
  return origin.archive ? origin.archive + '(' + origin.object + ')' : origin.object;
}

// The part of a section name before the symbol-specific suffix: ".text.foo" and
// ".text.bar" both roll up into ".text".
function sectionGroup(name) {
  const match = /^(\.[A-Za-z_][A-Za-z0-9_]*)/.exec(name);
  return match ? match[1] : name;
}

function emptyModel(format, filePath) {
  return {
    format,
    path: filePath,
    regions: [],
    outputSections: [],
    entries: [],
    symbols: [],
    archiveReasons: [],
    discarded: []
  };
}

// ---------------------------------------------------------------- GNU ld

function parseGnuLd(text, filePath) {
  const model = emptyModel('gnu-ld', filePath);
  const lines = text.split(/\r?\n/);

  let mode = 'preamble';
  let pendingSection = null; // a section name whose address/size wrapped to the next line
  let pendingMember = null;  // an archive member whose requester wrapped to the next line
  // The input section a symbol belongs to is the one listed just above it. It is
  // cleared at every output section, because a linker script can define symbols
  // there that belong to no object at all; without that they would be credited
  // to whichever object happened to come last.
  let currentEntry = null;

  const outputSectionRe = new RegExp('^(\\.[^\\s]+)\\s+(' + HEX + ')\\s+(' + HEX + ')');
  const inputSectionRe = new RegExp('^ (\\.[^\\s]+)\\s+(' + HEX + ')\\s+(' + HEX + ')\\s+(.+)$');
  const wrappedNameRe = /^ (\.[^\s]+)\s*$/;
  const wrappedBodyRe = new RegExp('^\\s+(' + HEX + ')\\s+(' + HEX + ')\\s+(.+)$');
  const symbolRe = new RegExp('^\\s+(' + HEX + ')\\s{2,}(\\S.*)$');
  const fillRe = new RegExp('^ \\*fill\\*\\s+(' + HEX + ')\\s+(' + HEX + ')');
  const regionRe = new RegExp('^(\\S+)\\s+(' + HEX + ')\\s+(' + HEX + ')\\s*(\\S*)$');
  const archiveReasonRe = /^(\S+)\s+(\S+)\s+\((\S+)\)\s*$/;
  // Long member names push the requester onto the next line, which is the norm
  // once the archive has any path in front of it.
  const archiveMemberOnlyRe = /^(\S+\([^)]*\))\s*$/;
  const archiveRequesterRe = /^\s+(\S+)\s+\((\S+)\)\s*$/;

  const addEntry = (section, address, size, origin, discarded) => {
    const parsed = splitOrigin(origin);
    const entry = {
      section,
      group: sectionGroup(section),
      address: parseInt(address, 16),
      size: parseInt(size, 16),
      object: parsed.object,
      archive: parsed.archive,
      key: originKey(parsed)
    };
    (discarded ? model.discarded : model.entries).push(entry);
    if (!discarded) currentEntry = entry;
    return entry;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^Archive member included/.test(line)) { mode = 'archive'; continue; }
    if (/^Allocating common symbols/.test(line)) { mode = 'common'; continue; }
    if (/^Discarded input sections/.test(line)) {
      mode = 'discarded'; pendingSection = null; pendingMember = null; currentEntry = null; continue;
    }
    if (/^Memory Configuration/.test(line)) { mode = 'memory'; pendingMember = null; continue; }
    if (/^Linker script and memory map/.test(line)) {
      mode = 'map'; pendingSection = null; currentEntry = null; continue;
    }
    if (/^(Merging object attributes|Cross Reference Table)/.test(line)) {
      mode = 'other'; pendingMember = null; continue;
    }

    if (mode === 'archive') {
      const addReason = (member, requiredBy, symbol) => {
        const origin = splitOrigin(member);
        model.archiveReasons.push({
          key: originKey(origin),
          object: origin.object,
          archive: origin.archive,
          requiredBy: requiredBy,
          symbol: symbol
        });
      };

      if (pendingMember) {
        const wrapped = archiveRequesterRe.exec(line);
        if (wrapped) {
          addReason(pendingMember, wrapped[1], wrapped[2]);
          pendingMember = null;
          continue;
        }
        pendingMember = null;
      }

      const match = archiveReasonRe.exec(line);
      if (match) {
        addReason(match[1], match[2], match[3]);
        continue;
      }
      const memberOnly = archiveMemberOnlyRe.exec(line);
      if (memberOnly) pendingMember = memberOnly[1];
      continue;
    }

    if (mode === 'memory') {
      if (/^Name\s+Origin/.test(line)) continue;
      const match = regionRe.exec(line);
      if (match && match[1] !== '*default*') {
        model.regions.push({
          name: match[1],
          origin: parseInt(match[2], 16),
          length: parseInt(match[3], 16),
          attributes: match[4] || ''
        });
      }
      continue;
    }

    if (mode !== 'map' && mode !== 'discarded') continue;
    const discarding = mode === 'discarded';

    // A wrapped section name is followed by its address/size/origin.
    if (pendingSection) {
      const body = wrappedBodyRe.exec(line);
      if (body) {
        addEntry(pendingSection, body[1], body[2], body[3], discarding);
        pendingSection = null;
        continue;
      }
      pendingSection = null; // no body followed; drop it
    }

    if (/^ \*\(/.test(line) || /^\s*LOAD /.test(line) || /^\s*START GROUP/.test(line)) continue;

    const fill = fillRe.exec(line);
    if (fill) {
      addEntry('*fill*', fill[1], fill[2], '*fill*', discarding);
      continue;
    }

    const input = inputSectionRe.exec(line);
    if (input) {
      addEntry(input[1], input[2], input[3], input[4], discarding);
      continue;
    }

    if (wrappedNameRe.test(line)) {
      pendingSection = wrappedNameRe.exec(line)[1];
      continue;
    }

    if (!discarding) {
      const output = outputSectionRe.exec(line);
      if (output && line.charAt(0) !== ' ') {
        model.outputSections.push({
          name: output[1],
          address: parseInt(output[2], 16),
          size: parseInt(output[3], 16)
        });
        currentEntry = null;
        continue;
      }

      // Symbol lines carry one address and a name, with no size column.
      const symbol = symbolRe.exec(line);
      if (symbol && !/^0x/.test(symbol[2])) {
        const name = symbol[2].trim();
        // Assignments such as ". = ALIGN (4)" are not symbols.
        if (name && !/^[.*]/.test(name) && !/=/.test(name)) {
          model.symbols.push({
            name,
            address: parseInt(symbol[1], 16),
            key: currentEntry ? currentEntry.key : null,
            section: currentEntry ? currentEntry.section : null
          });
        }
      }
    }
  }

  return model;
}

// ---------------------------------------------------------------- Apple ld64

function parseLd64(text, filePath) {
  const model = emptyModel('ld64', filePath);
  const lines = text.split(/\r?\n/);

  const objects = new Map(); // index -> origin
  const sectionAt = []; // [{start, end, name}] for mapping symbol addresses
  let mode = '';

  const objectRe = /^\[\s*(\d+)\]\s+(.*)$/;
  const sectionRe = new RegExp('^(' + HEX + ')\\s+(' + HEX + ')\\s+(\\S+)\\s+(\\S+)\\s*$');
  const symbolRe = new RegExp('^(' + HEX + ')\\s+(' + HEX + ')\\s+\\[\\s*(\\d+)\\]\\s+(.*)$');

  for (const line of lines) {
    if (/^# Object files:/.test(line)) { mode = 'objects'; continue; }
    if (/^# Sections:/.test(line)) { mode = 'sections'; continue; }
    if (/^# Symbols:/.test(line)) { mode = 'symbols'; continue; }
    if (/^# Dead Stripped Symbols:/.test(line)) { mode = 'dead'; continue; }
    if (/^#/.test(line)) continue;

    if (mode === 'objects') {
      const match = objectRe.exec(line);
      if (match) objects.set(match[1].trim(), splitOrigin(match[2]));
      continue;
    }

    if (mode === 'sections') {
      const match = sectionRe.exec(line);
      if (match) {
        const name = match[3] + ',' + match[4];
        const address = parseInt(match[1], 16);
        const size = parseInt(match[2], 16);
        model.outputSections.push({ name, address, size });
        sectionAt.push({ start: address, end: address + size, name });
      }
      continue;
    }

    if (mode === 'symbols' || mode === 'dead') {
      const match = symbolRe.exec(line);
      if (!match) continue;
      const origin = objects.get(match[3].trim()) || { archive: null, object: '(unknown)' };
      const address = parseInt(match[1], 16);
      const size = parseInt(match[2], 16);
      const owning = sectionAt.find((s) => address >= s.start && address < s.end);
      const section = owning ? owning.name : '(none)';

      // ld64 reports a size per symbol rather than per input section, so each
      // symbol becomes its own entry and the aggregation below still works.
      const entry = {
        section,
        group: sectionGroup(section.split(',')[1] || section),
        address,
        size,
        object: origin.object,
        archive: origin.archive,
        key: originKey(origin)
      };
      (mode === 'dead' ? model.discarded : model.entries).push(entry);
      model.symbols.push({ name: match[4].trim(), address, key: entry.key, section });
    }
  }

  return model;
}

// ---------------------------------------------------------------- aggregation

function summarise(model) {
  const byObject = new Map();
  const byArchive = new Map();
  const bySection = new Map();
  let total = 0;

  for (const entry of model.entries) {
    if (!entry.size) continue;
    total += entry.size;

    let object = byObject.get(entry.key);
    if (!object) {
      object = { key: entry.key, object: entry.object, archive: entry.archive, size: 0, sections: new Map() };
      byObject.set(entry.key, object);
    }
    object.size += entry.size;
    object.sections.set(entry.group, (object.sections.get(entry.group) || 0) + entry.size);

    const archiveName = entry.archive || '(no archive)';
    byArchive.set(archiveName, (byArchive.get(archiveName) || 0) + entry.size);
    bySection.set(entry.group, (bySection.get(entry.group) || 0) + entry.size);
  }

  model.totals = { total, byObject, byArchive, bySection };

  for (const region of model.regions) {
    region.used = model.entries
      .filter((e) => e.address >= region.origin && e.address < region.origin + region.length)
      .reduce((sum, e) => sum + e.size, 0);
  }

  return model;
}

// ---------------------------------------------------------------- demangling

// C++ symbols in a map file are mangled, which makes the symbol list unreadable
// for exactly the projects this is most useful on. Pipe them through c++filt in
// one go; if it is not installed, the names simply stay as they are.
//
// A real map can carry hundreds of thousands of symbols, and demangling all of
// them blocks for about a second. Only the largest ones are ever shown, so
// `limit` keeps the work proportional to what is on screen.
function demangle(model, command, limit) {
  const chosen = limit ? largestSymbols(model, limit) : model.symbols;
  const names = chosen.map((s) => s.name);
  if (!names.length) return model;

  let result;
  try {
    result = require('child_process').spawnSync(command || 'c++filt', ['--no-strip-underscore'], {
      input: names.join('\n'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10000
    });
  } catch (e) {
    return model;
  }
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return model;
  }

  const out = result.stdout.split('\n');
  if (out.length < names.length) return model;
  chosen.forEach((symbol, index) => {
    const value = (out[index] || '').trim();
    // Mach-O prefixes every symbol with an underscore, which c++filt leaves in
    // place; strip it only when demangling did not already happen.
    const cleaned = value === symbol.name && /^_[A-Za-z]/.test(value) ? value.slice(1) : value;
    if (cleaned && cleaned !== symbol.name) symbol.display = cleaned;
  });
  return model;
}

/**
 * The symbols worth showing: biggest first, sized by the input section they sit
 * in, since GNU ld gives symbols an address but no size of their own.
 *
 * @returns {Array<object>} entries from `model.symbols`
 */
function largestSymbols(model, limit) {
  const sizeByKeySection = new Map();
  for (const entry of model.entries) {
    sizeByKeySection.set(entry.key + ' ' + entry.section, entry.size);
  }
  return model.symbols
    .map((symbol) => ({ symbol, size: sizeByKeySection.get(symbol.key + ' ' + symbol.section) || 0 }))
    .filter((row) => row.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map((row) => row.symbol);
}

function parse(text, filePath) {
  const format = detectFormat(text);
  if (!format) {
    throw new Error('Unrecognised linker map format. Supported: GNU ld, Apple ld64.');
  }
  const model = format === 'ld64' ? parseLd64(text, filePath) : parseGnuLd(text, filePath);
  return summarise(model);
}

// V8 cannot hold a string much beyond half a gigabyte, and a map that large
// would exhaust memory long before it finished parsing. Say so plainly instead
// of surfacing a RangeError from deep inside the runtime.
const MAX_MAP_BYTES = 256 * 1024 * 1024;

function parseFile(filePath) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (e) {
    // Let readFileSync produce the real error.
  }
  if (size > MAX_MAP_BYTES) {
    throw new Error(
      path.basename(filePath) + ' is ' + formatBytes(size) +
      '; this reads map files up to ' + formatBytes(MAX_MAP_BYTES) + '.');
  }
  return parse(fs.readFileSync(filePath, 'utf8'), filePath);
}

// Looks for map files a build produced. Kept shallow so it stays instant even on
// a large build tree.
function findMapFiles(root, maxDepth) {
  if (maxDepth === undefined) maxDepth = 4;
  const skip = new Set(['CMakeFiles', '.cmake', '_deps', 'node_modules', '.git']);
  const found = [];

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /\.map$/i.test(entry.name)) {
        found.push(full);
      } else if (entry.isDirectory() && depth < maxDepth &&
                 !entry.name.startsWith('.') && !skip.has(entry.name)) {
        walk(full, depth + 1);
      }
    }
  };

  walk(root, 0);
  return found.sort();
}

// ---------------------------------------------------------- join with targets

/**
 * Works out how much of the linked image each CMake target accounts for.
 *
 * The two halves of this extension describe the same thing from different
 * sides: CMake knows target "engine" produces libengine.a, and the map
 * file knows libengine.a(engine.cpp.o) takes 17.5 KB. Three things let
 * them be matched up:
 *
 *   1. an archive named after the target's nameOnDisk
 *   2. an object file that is the target's own artifact (a shared library shows
 *      up this way and contributes nothing, because it is not in the image)
 *   3. CMake's own layout, which puts a target's objects in <target>.dir/
 *
 * @returns {Map<string, {size: number, objects: string[], dynamic: boolean}>}
 *          keyed by target id; targets absent from the map are simply missing.
 */
// The map and the build tree do not have to come from the same machine. The
// product is linked on Linux while day-to-day builds happen on Windows, so the
// same target is libfoo.a in the map and foo.lib in the tree at hand, and an
// exact comparison finds nothing at all - no error, just an empty size column.
// Reducing both sides to a stem bridges that.
const LIBRARY_EXT = /\.(?:a|lib|so|dll|dylib|elf|exe)$/i;

function artifactStem(name) {
  // libfoo.so.1.2.3 is still libfoo.so as far as the target is concerned.
  const text = String(name || '').replace(/\.so(?:\.\d+)+$/i, '.so');
  return text.replace(LIBRARY_EXT, '').replace(/^lib/, '').toLowerCase();
}

function matchTargets(targetModel, mapModel) {
  const byArtifact = new Map();
  const byObjectDir = new Map();
  for (const target of targetModel.targets.values()) {
    if (target.nameOnDisk) byArtifact.set(target.nameOnDisk, target);
    byObjectDir.set(target.name + '.dir', target);
  }

  // Two targets can reduce to the same stem (foo.lib next to libfoo.a in one
  // tree). Attributing sizes to whichever came first would be a guess, so drop
  // the stem instead and leave those to the exact match.
  const byStem = new Map();
  const ambiguous = new Set();
  for (const target of targetModel.targets.values()) {
    if (!target.nameOnDisk) continue;
    const stem = artifactStem(target.nameOnDisk);
    if (!stem) continue;
    if (byStem.has(stem)) ambiguous.add(stem);
    else byStem.set(stem, target);
  }
  for (const stem of ambiguous) byStem.delete(stem);

  const DYNAMIC_TYPES = new Set(['SHARED_LIBRARY', 'MODULE_LIBRARY']);
  const matched = new Map();

  for (const object of mapModel.totals.byObject.values()) {
    let target = null;

    if (object.archive) target = byArtifact.get(path.basename(object.archive));
    if (!target) target = byArtifact.get(path.basename(object.object));
    if (!target) {
      const dir = /(?:^|\/)([^/]+)\.dir(?:\/|$)/.exec(object.object);
      if (dir) target = byObjectDir.get(dir[1] + '.dir');
    }
    // Only after every exact route has missed, and only for things that name a
    // library: object files keep their own names across platforms, so stemming
    // them would attribute app.o to a target called app rather than to the
    // directory it was compiled in.
    if (!target) {
      const base = path.basename(String(object.archive || object.object || ''));
      if (LIBRARY_EXT.test(base) || /\.so(?:\.\d+)+$/i.test(base)) {
        target = byStem.get(artifactStem(base));
      }
    }
    if (!target) continue;

    let row = matched.get(target.id);
    if (!row) {
      row = { size: 0, objects: [], dynamic: DYNAMIC_TYPES.has(target.type) };
      matched.set(target.id, row);
    }
    row.size += object.size;
    row.objects.push(object.key);
  }

  return matched;
}

// ---------------------------------------------------------------- diff

/**
 * Compares two parsed maps object by object.
 *
 * @returns {{
 *   total: {before: number, after: number, delta: number},
 *   objects: Array<{key, object, archive, before, after, delta, status}>,
 *   sections: Array<{name, before, after, delta}>
 * }}
 */
function diff(before, after) {
  const compare = (beforeMap, afterMap, decorate) => {
    const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    const rows = [];
    for (const key of keys) {
      const b = beforeMap.get(key);
      const a = afterMap.get(key);
      const beforeSize = typeof b === 'number' ? b : (b ? b.size : 0);
      const afterSize = typeof a === 'number' ? a : (a ? a.size : 0);
      if (beforeSize === afterSize) continue;
      rows.push(Object.assign(
        {
          key,
          before: beforeSize,
          after: afterSize,
          delta: afterSize - beforeSize,
          status: !b ? 'added' : !a ? 'removed' : 'changed'
        },
        decorate ? decorate(a || b, key) : {}
      ));
    }
    return rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  };

  return {
    total: {
      before: before.totals.total,
      after: after.totals.total,
      delta: after.totals.total - before.totals.total
    },
    objects: compare(before.totals.byObject, after.totals.byObject,
                     (value) => ({ object: value.object, archive: value.archive })),
    sections: compare(before.totals.bySection, after.totals.bySection,
                      (_value, key) => ({ name: key }))
  };
}

function formatBytes(value) {
  const sign = value < 0 ? '-' : '';
  const size = Math.abs(value);
  if (size < 1024) return sign + size + ' B';
  // Always keep one decimal: in a size tool the difference between 17.5 KB and
  // 18 KB is exactly the kind of thing being looked for.
  if (size < 1024 * 1024) return sign + (size / 1024).toFixed(1) + ' KB';
  return sign + (size / (1024 * 1024)).toFixed(2) + ' MB';
}

module.exports = {
  detectFormat,
  parse,
  parseFile,
  findMapFiles,
  demangle,
  largestSymbols,
  matchTargets,
  artifactStem,
  diff,
  summarise,
  splitOrigin,
  sectionGroup,
  formatBytes
};

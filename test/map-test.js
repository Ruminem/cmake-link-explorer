'use strict';

// Checks src/mapFile.js and src/mapTree.js against the map fixtures in test/maps,
// which are real output from GNU ld and Apple ld64 (see test/mapgen/generate.sh).
//
//   node test/map-test.js                  the checked-in fixtures
//   node test/map-test.js /path/to/x.map   just parse and describe one file

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return require('./vscode-stub');
  return originalLoad.call(this, request, parent, isMain);
};

const path = require('path');
const assert = require('assert');
const mapFile = require('../src/mapFile');
const { MapTreeProvider } = require('../src/mapTree');

const MAPS = path.join(__dirname, 'maps');
const fixture = (name) => path.join(MAPS, name + '.map');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log('  ok    ' + label);
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + label);
    console.log('        ' + String(e.message || e).split('\n')[0]);
  }
}

// ------------------------------------------------------------ describe mode

if (process.argv[2]) {
  const model = mapFile.parseFile(process.argv[2]);
  mapFile.demangle(model);
  console.log('format:  ' + model.format);
  console.log('total:   ' + mapFile.formatBytes(model.totals.total));
  console.log('objects: ' + model.totals.byObject.size);
  for (const region of model.regions) {
    console.log('  region ' + region.name + '  ' + mapFile.formatBytes(region.used) +
                ' / ' + mapFile.formatBytes(region.length));
  }
  console.log('');
  for (const object of [...model.totals.byObject.values()].sort((a, b) => b.size - a.size).slice(0, 25)) {
    console.log('  ' + mapFile.formatBytes(object.size).padStart(10) + '  ' + object.key);
  }
  process.exit(0);
}

// ------------------------------------------------------------ detection

console.log('--- format detection ---');

const gnu = mapFile.parseFile(fixture('gnu-ld-full'));
const gnuGc = mapFile.parseFile(fixture('gnu-ld-gc'));
const ld64 = mapFile.parseFile(fixture('ld64-O0'));
const ld64O2 = mapFile.parseFile(fixture('ld64-O2'));

check('GNU ld maps are recognised', () => {
  assert.strictEqual(gnu.format, 'gnu-ld');
  assert.strictEqual(gnuGc.format, 'gnu-ld');
});

check('ld64 maps are recognised', () => {
  assert.strictEqual(ld64.format, 'ld64');
});

check('an unrelated file is rejected rather than mis-parsed', () => {
  assert.strictEqual(mapFile.detectFormat('hello\nworld\n'), null);
  assert.throws(() => mapFile.parse('hello\nworld\n', 'x'), /Unrecognised/);
});

console.log('');
console.log('--- GNU ld ---');

check('memory regions are read from the configuration table', () => {
  assert.deepStrictEqual(gnu.regions.map((r) => r.name), ['FLASH', 'RAM']);
  const flash = gnu.regions[0];
  assert.strictEqual(flash.origin, 0x08000000);
  assert.strictEqual(flash.length, 512 * 1024);
  assert.strictEqual(flash.attributes, 'xr');
});

check('region usage counts only what is placed in that region', () => {
  const [flash, ram] = gnu.regions;
  // .text 0xc1a + .rodata 0x279; .data lives at a RAM address, .ARM is non-alloc.
  assert.strictEqual(flash.used, 3098 + 633);
  assert.strictEqual(ram.used, 18432 + 4);
});

check('output section sizes match the map', () => {
  const byName = new Map(gnu.outputSections.map((s) => [s.name, s.size]));
  assert.strictEqual(byName.get('.text'), 0xc1a);
  assert.strictEqual(byName.get('.rodata'), 0x279);
});

check('section names that wrap onto the next line are still parsed', () => {
  // ".text.map_engine_load" is too long for the name column, so GNU ld puts the
  // address and size on the following line.
  const wrapped = gnu.entries.find((e) => e.section === '.text.map_engine_load');
  assert.ok(wrapped, 'the wrapped section was not parsed at all');
  assert.strictEqual(wrapped.size, 0x38a);
  assert.strictEqual(wrapped.object, 'map_engine.o');
});

check('archive members are split from their archive', () => {
  const entry = gnu.entries.find((e) => e.section === '.text.nds_open');
  assert.strictEqual(entry.archive, 'libnavicore.a');
  assert.strictEqual(entry.object, 'nds_reader.o');
  assert.strictEqual(entry.key, 'libnavicore.a(nds_reader.o)');
});

check('sizes aggregate per object file', () => {
  const objects = new Map([...gnu.totals.byObject].map(([k, v]) => [k, v.size]));
  assert.strictEqual(objects.get('libnavicore.a(nds_reader.o)'), 17923);
  assert.strictEqual(objects.get('app.o'), 2416);
  assert.strictEqual(objects.get('startup.o'), 175);
});

check('sizes aggregate per section group', () => {
  const sections = Object.fromEntries(gnu.totals.bySection);
  assert.strictEqual(sections['.text'], 3098);
  assert.strictEqual(sections['.bss'], 18432);
  assert.strictEqual(sections['.rodata'], 633);
  assert.strictEqual(sections['.data'], 4);
});

check('the total is the sum of every input section', () => {
  const sum = gnu.entries.reduce((total, e) => total + e.size, 0);
  assert.strictEqual(gnu.totals.total, sum);
  assert.strictEqual(gnu.totals.total, 22352);
});

check('archive members record why they were pulled in', () => {
  assert.deepStrictEqual(
    gnu.archiveReasons.map((r) => r.key + ' <- ' + r.requiredBy + ' (' + r.symbol + ')'),
    ['libnavicore.a(geo_utils.o) <- app.o (geo_project)',
     'libnavicore.a(nds_reader.o) <- app.o (nds_open)']);
});

check('an unreferenced archive member never enters the image', () => {
  // unused.o is in libnavicore.a but nothing calls never_called.
  assert.ok(![...gnu.totals.byObject.keys()].some((k) => k.indexOf('unused.o') !== -1));
});

check('symbols are attached to the section they sit in', () => {
  const symbol = gnu.symbols.find((s) => s.name === 'nds_open');
  assert.ok(symbol, 'nds_open was not parsed');
  assert.strictEqual(symbol.section, '.text.nds_open');
  assert.strictEqual(symbol.key, 'libnavicore.a(nds_reader.o)');
  assert.strictEqual(symbol.address, 0x0800063c);
});

check('linker script assignments are not mistaken for symbols', () => {
  for (const symbol of gnu.symbols) {
    assert.ok(!/[.=]/.test(symbol.name.charAt(0)), 'parsed an assignment as a symbol: ' + symbol.name);
  }
});

check('--gc-sections output separates discarded sections', () => {
  assert.strictEqual(gnuGc.discarded.length, 20);
  assert.ok(gnuGc.totals.total < gnu.totals.total,
            'the garbage-collected image should be smaller');
  const discarded = gnuGc.discarded.find((e) => e.section === '.bss.nds_tile_buffer');
  assert.ok(discarded, 'the dropped buffer is missing from the discarded list');
  assert.strictEqual(discarded.size, 0x4000);
});

check('discarded sections are excluded from the totals', () => {
  const keptSections = new Set(gnuGc.entries.map((e) => e.section));
  assert.ok(!keptSections.has('.bss.nds_tile_buffer'));
  assert.strictEqual(gnuGc.totals.total, 3283);
});

console.log('');
console.log('--- Apple ld64 ---');

check('object files are resolved from their index', () => {
  const objects = [...ld64.totals.byObject.keys()];
  assert.ok(objects.some((k) => /big\.cpp|big-/.test(k) || k.endsWith('.o')),
            'no compiled object found: ' + JSON.stringify(objects));
});

check('every symbol carries a size and a section', () => {
  assert.strictEqual(ld64.symbols.length, 661);
  assert.strictEqual(ld64.entries.length, 661);
  for (const entry of ld64.entries) {
    assert.ok(typeof entry.size === 'number' && entry.size >= 0);
    assert.ok(entry.section, 'an entry has no section at all');
  }
  // A few symbols sit outside every listed section -- __mh_execute_header is the
  // Mach-O header itself -- and are reported as (none) rather than guessed at.
  const placed = ld64.entries.filter((e) => e.section.indexOf(',') !== -1);
  assert.ok(placed.length > ld64.entries.length - 5,
            'too many symbols fell outside a section: ' + (ld64.entries.length - placed.length));
  const header = ld64.symbols.find((s) => s.name === '__mh_execute_header');
  assert.strictEqual(header.section, '(none)');
});

check('symbols are mapped into the section that contains their address', () => {
  const text = ld64.entries.filter((e) => e.section === '__TEXT,__text');
  assert.ok(text.length > 100, 'expected most symbols in __TEXT,__text, got ' + text.length);
  for (const entry of text) assert.strictEqual(entry.group, '__text');
});

check('the total matches the sum of symbol sizes', () => {
  assert.strictEqual(ld64.totals.total, ld64.entries.reduce((t, e) => t + e.size, 0));
  assert.strictEqual(ld64.totals.total, 45117);
});

check('C++ names demangle when a demangler is available', () => {
  const model = mapFile.parseFile(fixture('ld64-O0'));
  mapFile.demangle(model);
  const demangled = model.symbols.filter((s) => s.display);
  if (!demangled.length) {
    console.log('        (skipped: no working c++filt on this machine)');
    return;
  }
  assert.ok(model.symbols.some((s) => s.display === 'load(int)'),
            'load(int) was not demangled');
  assert.ok(demangled.length > 100, 'only ' + demangled.length + ' symbols demangled');
});

check('demangling survives a missing demangler', () => {
  const model = mapFile.parseFile(fixture('ld64-O0'));
  mapFile.demangle(model, 'definitely-not-a-real-demangler-xyz');
  assert.strictEqual(model.symbols.filter((s) => s.display).length, 0);
  assert.strictEqual(model.symbols.length, 661);
});

console.log('');
console.log('--- diff ---');

check('an optimisation level change shows up as a shrink', () => {
  const d = mapFile.diff(ld64, ld64O2);
  assert.strictEqual(d.total.before, 45117);
  assert.strictEqual(d.total.after, 13846);
  assert.strictEqual(d.total.delta, 13846 - 45117);
  assert.ok(d.total.delta < 0);
});

check('rows are sorted by how much they moved', () => {
  const d = mapFile.diff(ld64, ld64O2);
  for (let i = 1; i < d.sections.length; i++) {
    assert.ok(Math.abs(d.sections[i - 1].delta) >= Math.abs(d.sections[i].delta),
              'section rows are not sorted by magnitude');
  }
  assert.strictEqual(d.sections[0].name, '__text');
});

check('gc-sections shows up as removed objects and sections', () => {
  const d = mapFile.diff(gnu, gnuGc);
  assert.strictEqual(d.total.delta, 3283 - 22352);
  const bss = d.sections.find((s) => s.name === '.bss');
  assert.ok(bss, '.bss should have changed');
  assert.strictEqual(bss.after, 0);
  assert.strictEqual(bss.status, 'removed');
});

check('unchanged rows are left out', () => {
  const d = mapFile.diff(gnu, gnu);
  assert.strictEqual(d.total.delta, 0);
  assert.deepStrictEqual(d.objects, []);
  assert.deepStrictEqual(d.sections, []);
});

console.log('');
console.log('--- tree ---');

const provider = new MapTreeProvider();
provider.showMap(gnu);

check('the root groups reflect what the map contains', () => {
  const groups = provider.getChildren().map((n) => n.group);
  assert.deepStrictEqual(groups, ['regions', 'objects', 'sections', 'symbols', 'archives']);
});

check('a map without regions hides the region group', () => {
  const other = new MapTreeProvider();
  other.showMap(ld64);
  const groups = other.getChildren().map((n) => n.group);
  assert.ok(groups.indexOf('regions') === -1, 'ld64 has no memory regions to show');
  assert.ok(groups.indexOf('objects') !== -1);
});

check('discarded sections get their own group when present', () => {
  const other = new MapTreeProvider();
  other.showMap(gnuGc);
  assert.ok(other.getChildren().map((n) => n.group).indexOf('discarded') !== -1);
});

check('objects are listed largest first with a percentage', () => {
  const group = provider.getChildren().find((n) => n.group === 'objects');
  const nodes = provider.getChildren(group);
  assert.strictEqual(nodes[0].object.key, 'libnavicore.a(nds_reader.o)');
  const item = provider.getTreeItem(nodes[0]);
  assert.strictEqual(item.label, 'nds_reader.o  (libnavicore.a)');
  assert.ok(/^17\.5 KB/.test(item.description), 'description was ' + item.description);
  assert.ok(/%/.test(item.description));
});

check('expanding an object breaks it down by section', () => {
  const group = provider.getChildren().find((n) => n.group === 'objects');
  const object = provider.getChildren(group)[0];
  const sections = provider.getChildren(object).map((n) => n.name);
  assert.deepStrictEqual(sections, ['.bss', '.text', '.ARM']);
});

check('memory regions render usage against capacity', () => {
  const group = provider.getChildren().find((n) => n.group === 'regions');
  const item = provider.getTreeItem(provider.getChildren(group)[0]);
  assert.strictEqual(item.label, 'FLASH');
  assert.strictEqual(item.description, '3.6 KB / 512.0 KB   0.71%');
});

check('archive reasons explain the pull-in', () => {
  const group = provider.getChildren().find((n) => n.group === 'archives');
  const item = provider.getTreeItem(provider.getChildren(group)[0]);
  assert.strictEqual(item.label, 'geo_utils.o');
  assert.ok(/app\.o/.test(item.description) && /geo_project/.test(item.description),
            'description was ' + item.description);
});

check('tree item ids are unique', () => {
  const seen = new Set();
  const walk = (node, depth) => {
    const item = provider.getTreeItem(node);
    assert.ok(!seen.has(item.id), 'duplicate id: ' + item.id);
    seen.add(item.id);
    if (depth < 3) for (const child of provider.getChildren(node)) walk(child, depth + 1);
  };
  for (const node of provider.getChildren()) walk(node, 0);
});

check('diff mode renders totals and rows', () => {
  const other = new MapTreeProvider();
  other.showDiff(ld64, ld64O2);
  const roots = other.getChildren();
  assert.deepStrictEqual(roots.map((n) => n.kind || n.group),
                         ['diffTotal', 'group', 'group']);
  const total = other.getTreeItem(roots[0]);
  assert.strictEqual(total.description, '44.1 KB → 13.5 KB   -30.5 KB');
  const sectionRows = other.getChildren(roots[2]);
  const first = other.getTreeItem(sectionRows[0]);
  assert.strictEqual(first.label, '__text');
  assert.ok(/^-/.test(first.description), 'expected a shrink, got ' + first.description);
});

check('byte formatting stays readable at every scale', () => {
  assert.strictEqual(mapFile.formatBytes(0), '0 B');
  assert.strictEqual(mapFile.formatBytes(512), '512 B');
  assert.strictEqual(mapFile.formatBytes(2048), '2.0 KB');
  assert.strictEqual(mapFile.formatBytes(17923), '17.5 KB');
  assert.strictEqual(mapFile.formatBytes(1024 * 1024), '1.00 MB');
  assert.strictEqual(mapFile.formatBytes(-2048), '-2.0 KB');
});

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

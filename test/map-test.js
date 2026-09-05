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
  assert.strictEqual(flash.used, 3098 + 625);
  assert.strictEqual(ram.used, 18432 + 4);
});

check('output section sizes match the map', () => {
  const byName = new Map(gnu.outputSections.map((s) => [s.name, s.size]));
  assert.strictEqual(byName.get('.text'), 0xc1a);
  assert.strictEqual(byName.get('.rodata'), 625);
});

check('section names that wrap onto the next line are still parsed', () => {
  // ".text.engine_load" is too long for the name column, so GNU ld puts the
  // address and size on the following line.
  const wrapped = gnu.entries.find((e) => e.section === '.text.engine_load');
  assert.ok(wrapped, 'the wrapped section was not parsed at all');
  assert.strictEqual(wrapped.size, 0x38a);
  assert.strictEqual(wrapped.object, 'engine.o');
});

check('archive members are split from their archive', () => {
  const entry = gnu.entries.find((e) => e.section === '.text.store_open');
  assert.strictEqual(entry.archive, 'libdemocore.a');
  assert.strictEqual(entry.object, 'store_reader.o');
  assert.strictEqual(entry.key, 'libdemocore.a(store_reader.o)');
});

check('sizes aggregate per object file', () => {
  const objects = new Map([...gnu.totals.byObject].map(([k, v]) => [k, v.size]));
  assert.strictEqual(objects.get('libdemocore.a(store_reader.o)'), 17923);
  assert.strictEqual(objects.get('app.o'), 2408);
  assert.strictEqual(objects.get('startup.o'), 175);
});

check('sizes aggregate per section group', () => {
  const sections = Object.fromEntries(gnu.totals.bySection);
  assert.strictEqual(sections['.text'], 3098);
  assert.strictEqual(sections['.bss'], 18432);
  assert.strictEqual(sections['.rodata'], 625);
  assert.strictEqual(sections['.data'], 4);
});

check('the total is the sum of every input section', () => {
  const sum = gnu.entries.reduce((total, e) => total + e.size, 0);
  assert.strictEqual(gnu.totals.total, sum);
  assert.strictEqual(gnu.totals.total, 22344);
});

check('archive members record why they were pulled in', () => {
  assert.deepStrictEqual(
    gnu.archiveReasons.map((r) => r.key + ' <- ' + r.requiredBy + ' (' + r.symbol + ')'),
    ['libdemocore.a(math_utils.o) <- app.o (math_project)',
     'libdemocore.a(store_reader.o) <- app.o (store_open)']);
});

check('an archive member whose requester wrapped is still parsed', () => {
  // GNU ld pushes the requester onto the next line once the member name is too
  // long for the column, which is the normal case as soon as the archive has a
  // path in front of it:
  //     libdemocore.a(store_reader.o)
  //                                   app.o (store_open)
  const wrapped = gnu.archiveReasons.find((r) => r.object === 'store_reader.o');
  assert.ok(wrapped, 'the wrapped entry was dropped');
  assert.strictEqual(wrapped.requiredBy, 'app.o');
  assert.strictEqual(wrapped.symbol, 'store_open');
});

check('a wrapped requester is read even with a long archive path', () => {
  const text = [
    'Archive member included to satisfy reference by file (symbol)',
    '',
    '../../build/libs/reader/libvery_long_name.a(some_translation_unit.o)',
    '                              main.o (open_thing)',
    '',
    'Memory Configuration',
    ''
  ].join('\n');
  const model = mapFile.parse(text, 'synthetic');
  assert.strictEqual(model.archiveReasons.length, 1);
  assert.strictEqual(model.archiveReasons[0].object, 'some_translation_unit.o');
  assert.strictEqual(model.archiveReasons[0].archive,
                     '../../build/libs/reader/libvery_long_name.a');
  assert.strictEqual(model.archiveReasons[0].requiredBy, 'main.o');
  assert.strictEqual(model.archiveReasons[0].symbol, 'open_thing');
});

check('a stray member line with no requester is dropped, not half-recorded', () => {
  const text = [
    'Archive member included to satisfy reference by file (symbol)',
    '',
    'libfoo.a(bar.o)',
    '',
    'Memory Configuration',
    ''
  ].join('\n');
  assert.deepStrictEqual(mapFile.parse(text, 'synthetic').archiveReasons, []);
});

check('an unreferenced archive member never enters the image', () => {
  // unused.o is in libdemocore.a but nothing calls never_called.
  assert.ok(![...gnu.totals.byObject.keys()].some((k) => k.indexOf('unused.o') !== -1));
});

check('symbols are attached to the section they sit in', () => {
  const symbol = gnu.symbols.find((s) => s.name === 'store_open');
  assert.ok(symbol, 'store_open was not parsed');
  assert.strictEqual(symbol.section, '.text.store_open');
  assert.strictEqual(symbol.key, 'libdemocore.a(store_reader.o)');
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
  const discarded = gnuGc.discarded.find((e) => e.section === '.bss.store_buffer');
  assert.ok(discarded, 'the dropped buffer is missing from the discarded list');
  assert.strictEqual(discarded.size, 0x4000);
});

check('discarded sections are excluded from the totals', () => {
  const keptSections = new Set(gnuGc.entries.map((e) => e.section));
  assert.ok(!keptSections.has('.bss.store_buffer'));
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
  assert.strictEqual(d.total.delta, 3283 - 22344);
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
console.log('--- joining a map to CMake targets ---');

// Needs the real build tree from test/bootstrap.sh, since the join is keyed on
// what CMake says each target produces.
const fileApi = require('../src/fileApi');
const sampleBuild = path.join(__dirname, 'sample-project', 'build');

if (!fileApi.isBuildDir(sampleBuild)) {
  console.log('  (skipped: run ./test/bootstrap.sh to create test/sample-project/build)');
} else {
  const targets = fileApi.loadModel(sampleBuild, '');
  const sampleMap = mapFile.parseFile(fixture('sample-app'));
  const joined = mapFile.matchTargets(targets, sampleMap);
  const byName = new Map(Array.from(targets.targets.values()).map((t) => [t.name, t]));
  const sizeOf = (name) => joined.get(byName.get(name).id);

  check('a static library is matched through its archive', () => {
    const row = sizeOf('store_reader');
    assert.ok(row, 'store_reader was not matched');
    assert.strictEqual(row.objects.length, 1);
    assert.ok(/libstore_reader\.a\(store_reader\.cpp\.o\)$/.test(row.objects[0]), row.objects[0]);
    assert.ok(row.size > 500, 'expected a real size, got ' + row.size);
  });

  check("an executable is matched through CMake's object directory", () => {
    const row = sizeOf('sample_app');
    assert.ok(row, 'sample_app was not matched');
    assert.ok(/sample_app\.dir\//.test(row.objects[0]), row.objects[0]);
  });

  check('a shared library is flagged as dynamic', () => {
    const row = sizeOf('render_core');
    assert.ok(row, 'render_core was not matched');
    assert.strictEqual(row.dynamic, true);
  });

  check('static libraries are not flagged as dynamic', () => {
    for (const name of ['store_reader', 'db_wrap', 'log_wrapper', 'engine']) {
      assert.strictEqual(sizeOf(name).dynamic, false, name + ' should be static');
    }
  });

  check('a target absent from this image is simply not matched', () => {
    // engine_test and store_test are separate executables, and math_utils resolved out
    // of librender_core.dylib rather than being pulled from its archive.
    assert.strictEqual(sizeOf('engine_test'), undefined);
    assert.strictEqual(sizeOf('store_test'), undefined);
    assert.strictEqual(sizeOf('math_utils'), undefined);
  });

  check('matched sizes never exceed the image', () => {
    const total = [...joined.values()].reduce((sum, row) => sum + row.size, 0);
    assert.ok(total <= sampleMap.totals.total,
              total + ' attributed but the image is only ' + sampleMap.totals.total);
  });

  check('the tree shows the size next to the link counts', () => {
    const { TargetTreeProvider } = require('../src/tree');
    const view = new TargetTreeProvider();
    view.setModel(targets);
    view.setSizes(joined);

    const roots = view.getChildren();
    const item = (name) =>
      view.getTreeItem(roots.find((n) => targets.targets.get(n.id).name === name));
    assert.strictEqual(item('store_reader').description, '→1 ←2   1.0 KB');
    assert.strictEqual(item('render_core').description, '→1 ←1   dynamic');
    assert.strictEqual(item('math_utils').description, '←2');
  });

  check('dropping the map removes the size column again', () => {
    const { TargetTreeProvider } = require('../src/tree');
    const view = new TargetTreeProvider();
    view.setModel(targets);
    view.setSizes(joined);
    view.setSizes(null);
    const roots = view.getChildren();
    const node = roots.find((n) => targets.targets.get(n.id).name === 'store_reader');
    assert.strictEqual(view.getTreeItem(node).description, '→1 ←2');
  });

  check('sorting by size puts the heaviest target first', () => {
    const { TargetTreeProvider } = require('../src/tree');
    const stub = require('./vscode-stub');
    const view = new TargetTreeProvider();
    view.setModel(targets);
    view.setSizes(joined);
    stub.__setConfig('sortTargets', 'size');
    try {
      const names = view.getChildren().map((n) => targets.targets.get(n.id).name);
      assert.strictEqual(names[0], 'store_reader');
      // Unmatched targets sort last rather than pretending to be zero bytes.
      assert.ok(names.indexOf('math_utils') > names.indexOf('log_wrapper'));
    } finally {
      stub.__clearConfig();
    }
  });
}

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
  assert.strictEqual(nodes[0].object.key, 'libdemocore.a(store_reader.o)');
  const item = provider.getTreeItem(nodes[0]);
  assert.strictEqual(item.label, 'store_reader.o  (libdemocore.a)');
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
  assert.strictEqual(item.label, 'math_utils.o');
  assert.ok(/app\.o/.test(item.description) && /math_project/.test(item.description),
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

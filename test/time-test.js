'use strict';

// Checks src/buildLog.js against the fixtures in test/ninja, which are real
// .ninja_log output from ninja + MinGW building test/sample-project
// (see test/ninja/generate.sh).
//
//   node test/time-test.js                    the checked-in fixtures
//   node test/time-test.js /path/to/.ninja_log   just parse and describe one log

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return require('./vscode-stub');
  return originalLoad.call(this, request, parent, isMain);
};

const path = require('path');
const assert = require('assert');
const buildLog = require('../src/buildLog');
const fileApi = require('../src/fileApi');
const vscodeStub = require('./vscode-stub');
const { BuildTimeTreeProvider } = require('../src/timeTree');
const { TargetTreeProvider } = require('../src/tree');

const LOGS = path.join(__dirname, 'ninja');
const fixture = (name) => path.join(LOGS, name + '.ninja_log');

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
  const model = buildLog.parseFile(process.argv[2]);
  console.log('version: v' + model.version + (model.unverifiedVersion ? ' (untested)' : ''));
  console.log('builds:  ' + model.builds.length +
              '   last took ' + buildLog.formatMs(model.totals.wall));
  console.log('edges:   ' + model.totals.edges +
              '   ' + buildLog.formatMs(model.totals.cpu) + ' of work');
  for (const [kind, ms] of model.totals.byKind) {
    console.log('  ' + kind.padEnd(8) + buildLog.formatMs(ms));
  }
  console.log('slowest:');
  for (const edge of model.edges.slice(0, 20)) {
    console.log('  ' + buildLog.formatMs(edge.duration).padStart(9) + '  ' + edge.outputs.join(', '));
  }
  process.exit(0);
}

// ------------------------------------------------------------------ parsing

const full = buildLog.parseFile(fixture('mingw-full'));
const incremental = buildLog.parseFile(fixture('mingw-incremental'));

console.log('--- parsing ---');

check('recognises a ninja log and its version', () => {
  assert.deepStrictEqual(buildLog.detectFormat('# ninja log v7\n'), { format: 'ninja', version: 7 });
  assert.strictEqual(full.version, 7);
  assert.strictEqual(full.unverifiedVersion, false);
  assert.strictEqual(full.malformed, 0);
});

check('reads every line of a clean build', () => {
  assert.strictEqual(full.entries.length, 19);
  assert.strictEqual(full.builds.length, 1);
  assert.strictEqual(full.builds[0].wall, 3608);
});

check('classifies outputs by what they are', () => {
  assert.strictEqual(buildLog.outputKind('foo/bar.cpp.obj'), 'compile');
  assert.strictEqual(buildLog.outputKind('foo/bar.cpp.o'), 'compile');
  assert.strictEqual(buildLog.outputKind('libfoo.a'), 'archive');
  assert.strictEqual(buildLog.outputKind('foo.lib'), 'archive');
  assert.strictEqual(buildLog.outputKind('libfoo.so.1.2.3'), 'link');
  assert.strictEqual(buildLog.outputKind('foo.dll'), 'link');
  assert.strictEqual(buildLog.outputKind('foo.exe'), 'link');
  // A custom command's stamp file is still build time; it just is not a
  // compile or a link, and guessing otherwise would put it in the wrong total.
  assert.strictEqual(buildLog.outputKind('CMakeFiles/docs.stamp'), 'other');
});

check('one edge with two outputs is counted once', () => {
  // ninja writes a line per output, so the DLL and its import library appear
  // twice with identical timings. Summing per output would bill that link
  // twice over.
  const multi = full.edges.filter((e) => e.outputs.length > 1);
  assert.strictEqual(multi.length, 1);
  assert.deepStrictEqual(multi[0].outputs,
                         ['libs/render_core/librender_core.dll',
                          'libs/render_core/librender_core.dll.a']);
  assert.strictEqual(multi[0].duration, 158);
  assert.strictEqual(multi[0].kind, 'link');
  assert.strictEqual(full.edges.length, 18);
  assert.strictEqual(full.latest.size, 19);
});

check('totals separate the work from the wait', () => {
  // Nine jobs ran at once, so the build finished in far less than its own sum.
  assert.strictEqual(full.totals.cpu, 11783);
  assert.strictEqual(full.totals.wall, 3608);
  assert.ok(full.totals.wall < full.totals.cpu);
  assert.strictEqual(full.totals.byKind.get('compile'), 2254);
  assert.strictEqual(full.totals.byKind.get('archive'), 8848);
  assert.strictEqual(full.totals.byKind.get('link'), 681);
});

console.log('');
console.log('--- more than one build in one file ---');

check('splits runs where the clock restarts', () => {
  // ninja appends without clearing, and the only marker between two runs is
  // that the end column drops back towards zero.
  assert.strictEqual(incremental.entries.length, 23);
  assert.strictEqual(incremental.builds.length, 2);
  assert.deepStrictEqual(incremental.builds.map((b) => b.entries.length), [19, 4]);
  assert.strictEqual(incremental.lastBuild.index, 1);
  assert.strictEqual(incremental.lastBuild.wall, 390);
  assert.strictEqual(incremental.totals.wall, 390);
});

check('the newest timing for an output wins', () => {
  const key = 'libs/engine/CMakeFiles/engine.dir/engine.cpp.obj';
  // 203 ms cold in the first build, 90 ms warm in the second. Reporting the
  // first would describe a compile that no longer happens that way.
  assert.strictEqual(full.latest.get(key).duration, 203);
  assert.strictEqual(incremental.latest.get(key).duration, 90);
  assert.strictEqual(incremental.latest.get(key).build, 1);
});

check('a rebuilt output is not counted twice', () => {
  // Four more lines than the clean log, all of them repeats.
  assert.strictEqual(incremental.latest.size, full.latest.size);
  assert.strictEqual(incremental.edges.length, full.edges.length);
});

check('targets untouched by the last build keep their timing', () => {
  // The whole point of taking the last line per output rather than the last
  // build: after one full build and a small incremental one, every target is
  // still described.
  const untouched = 'libs/math_utils/libmath_utils.a';
  assert.strictEqual(incremental.latest.get(untouched).duration, 2972);
  assert.strictEqual(incremental.latest.get(untouched).build, 0);
});

console.log('');
console.log('--- joining with the target graph ---');

const targets = fileApi.loadModel(path.join(__dirname, 'sample-project', 'build'), '');
const joined = buildLog.matchTargets(targets, incremental);
const nameOf = (id) => targets.targets.get(id).name;

check('every buildable target is accounted for', () => {
  // Counting every target in the model would depend on the generator: a tree
  // configured on Windows with Visual Studio hangs ZERO_CHECK and ALL_BUILD off
  // the project and a Ninja tree writes no such thing. Compare against the set
  // the tree view shows, the way test/run.js does.
  const buildable = [...targets.targets.values()].filter(fileApi.isLinkable);
  assert.strictEqual(buildable.length, 9);
  assert.strictEqual(joined.size, buildable.length);
  // generate_docs is a UTILITY target: it produces no file, so nothing in the
  // log belongs to it and it is correctly absent.
  assert.ok(!Array.from(joined.keys()).map(nameOf).includes('generate_docs'));
});

check('compiling and linking are attributed separately', () => {
  const engine = joined.get(Array.from(joined.keys()).find((id) => nameOf(id) === 'engine'));
  assert.strictEqual(engine.compile, 90);   // engine.cpp.obj, warm
  assert.strictEqual(engine.link, 127);     // libengine.a
  assert.strictEqual(engine.total, 217);
  assert.strictEqual(engine.edges.length, 2);
  // Sorted slowest first, so the tree can show what to look at.
  assert.strictEqual(engine.slowest.duration, 127);
  assert.strictEqual(engine.edges[0], engine.slowest);
});

check('a shared library is billed for one link, not two', () => {
  const render = joined.get(Array.from(joined.keys()).find((id) => nameOf(id) === 'render_core'));
  assert.strictEqual(render.link, 158);
  assert.strictEqual(render.edges.length, 2);
});

check('an executable joins through its object directory', () => {
  // An executable produces no archive to match by name, so its compile step is
  // only reachable through CMake's <target>.dir layout.
  const app = joined.get(Array.from(joined.keys()).find((id) => nameOf(id) === 'sample_app'));
  assert.strictEqual(app.compile, 192);
  assert.strictEqual(app.link, 173);
});

console.log('');
console.log('--- joining across platforms ---');

// Day-to-day builds are MSVC on Windows; the product is built with GNU tools on
// Linux. So the log says libfoo.a and the tree in front of you says foo.lib.
// The log is checked in and the target side is spelled out here.
const model = (rows) => ({
  targets: new Map(rows.map((row, i) => [String(i), {
    id: String(i), name: row[0], nameOnDisk: row[1], type: row[2] || 'STATIC_LIBRARY'
  }]))
});
const joinNames = (targetModel) => {
  const rows = buildLog.matchTargets(targetModel, incremental);
  return [...rows.entries()]
    .map(([id, row]) => targetModel.targets.get(id).name + '=' + row.total)
    .sort();
};

check('a GNU log still joins to a tree configured with MSVC names', () => {
  assert.deepStrictEqual(joinNames(model([['math_utils', 'math_utils.lib']])),
                         ['math_utils=3156']);
});

check('the same log joins to a GNU tree exactly as before', () => {
  assert.deepStrictEqual(joinNames(model([['math_utils', 'libmath_utils.a']])),
                         ['math_utils=3156']);
});

check('object files are never matched by stem', () => {
  // sample_app.exe would stem to "sample_app" and so would any object named
  // after it. Stemming objects would credit a compile to whatever target
  // shares the name instead of to the directory it was compiled in.
  const rows = buildLog.matchTargets(model([['unrelated', 'engine.lib']]), incremental);
  const total = [...rows.values()][0];
  // libengine.a joins by stem; engine.cpp.obj must not, because it lives under
  // engine.dir and this target is not called engine.
  assert.strictEqual(total.compile, 0);
  assert.strictEqual(total.link, 127);
});

check('a name two targets share is left to the exact routes', () => {
  const rows = buildLog.matchTargets(
    model([['a', 'math_utils.lib'], ['b', 'libmath_utils.a']]), incremental);
  // "b" matches exactly; "a" would only match by the now-dropped stem.
  assert.deepStrictEqual([...rows.keys()].map((id) => id), ['1']);
});

check('case differences do not break the join', () => {
  // VS Code and CMake can disagree on the case of a path, drive letter included,
  // and Windows does not care. Comparing raw would drop the join entirely.
  assert.deepStrictEqual(joinNames(model([['math_utils', 'LIBMATH_UTILS.A']])),
                         ['math_utils=3156']);
});

console.log('');
console.log('--- diff ---');

check('compares two logs edge by edge', () => {
  const d = buildLog.diff(full, incremental);
  assert.strictEqual(d.total.before, 11783);
  assert.strictEqual(d.total.after, 11647);
  assert.strictEqual(d.total.delta, -136);
  // Only what the incremental build touched moved.
  assert.strictEqual(d.outputs.length, 4);
  const first = d.outputs[0];
  assert.strictEqual(first.key, 'libs/engine/CMakeFiles/engine.dir/engine.cpp.obj');
  assert.strictEqual(first.before, 203);
  assert.strictEqual(first.after, 90);
  assert.strictEqual(first.status, 'changed');
  // Biggest movement first, by size not by sign.
  assert.ok(Math.abs(d.outputs[0].delta) >= Math.abs(d.outputs[1].delta));
});

console.log('');
console.log('--- refusing what it cannot read ---');

check('a file that is not a build log is rejected by name', () => {
  const mapText = require('fs').readFileSync(
    path.join(__dirname, 'maps', 'gnu-ld-full.map'), 'utf8');
  assert.throws(() => buildLog.parse(mapText, 'gnu-ld-full.map'), /not a ninja build log/i);
});

check('a log older than the five-column layout says how to fix it', () => {
  assert.throws(() => buildLog.parse('# ninja log v4\n', 'x'), /recompact/);
});

check('a newer log is read but flagged rather than refused', () => {
  // Refusing to open a log because ninja moved to v8 would be worse than
  // reading it and saying so: the columns have not moved in years.
  const model = buildLog.parse('# ninja log v9\n1\t5\t123\tfoo.o\tabc\n', 'x');
  assert.strictEqual(model.unverifiedVersion, true);
  assert.strictEqual(model.edges.length, 1);
});

check('a truncated line is skipped instead of poisoning the totals', () => {
  const model = buildLog.parse(
    '# ninja log v7\n1\t5\t123\tfoo.o\tabc\nbroken line\n2\t9\t124\tbar.o\tdef\n', 'x');
  assert.strictEqual(model.malformed, 1);
  assert.strictEqual(model.edges.length, 2);
  assert.strictEqual(model.totals.cpu, 11);
});

check('a backwards row cannot subtract from the total', () => {
  const model = buildLog.parse('# ninja log v7\n90\t10\t123\tfoo.o\tabc\n', 'x');
  assert.strictEqual(model.totals.cpu, 0);
});

check('an empty log is a model with nothing in it, not a crash', () => {
  const model = buildLog.parse('# ninja log v7\n', 'x');
  assert.strictEqual(model.builds.length, 0);
  assert.strictEqual(model.lastBuild, null);
  assert.strictEqual(model.totals.cpu, 0);
  assert.strictEqual(model.totals.wall, 0);
});

console.log('');
console.log('--- formatting ---');

check('durations stay readable at every scale', () => {
  assert.strictEqual(buildLog.formatMs(0), '0 ms');
  assert.strictEqual(buildLog.formatMs(194), '194 ms');
  assert.strictEqual(buildLog.formatMs(999), '999 ms');
  assert.strictEqual(buildLog.formatMs(1000), '1.0 s');
  assert.strictEqual(buildLog.formatMs(2908), '2.9 s');
  assert.strictEqual(buildLog.formatMs(59999), '60.0 s');
  assert.strictEqual(buildLog.formatMs(60000), '1 m 00 s');
  assert.strictEqual(buildLog.formatMs(64000), '1 m 04 s');
  assert.strictEqual(buildLog.formatMs(-2908), '-2.9 s');
  // 119.6 s rounds to 60 seconds inside the minute, which is not a time.
  assert.strictEqual(buildLog.formatMs(119600), '2 m 00 s');
});

console.log('');
console.log('--- the view ---');

// What the extension works out and hands the provider, which has no target
// graph of its own.
const rowsFor = (times) => [...times.entries()]
  .map(([id, row]) => ({ id, name: nameOf(id), type: targets.targets.get(id).type, row }))
  .sort((a, b) => b.row.total - a.row.total || a.name.localeCompare(b.name));

const view = new BuildTimeTreeProvider();
view.showLog(incremental, rowsFor(joined));

check('the root leads with the number the user waited for', () => {
  const roots = view.getChildren();
  assert.deepStrictEqual(roots.map((n) => n.group || n.kind),
                         ['total', 'targets', 'slowest', 'kinds', 'builds']);
  const total = view.getTreeItem(roots[0]);
  assert.strictEqual(total.description, '390 ms   ·   11.6 s of work across 18 steps');
});

check('a single-build log does not offer a list of one', () => {
  const single = new BuildTimeTreeProvider();
  single.showLog(full, null);
  // No target rows either, because no build tree was loaded.
  assert.deepStrictEqual(single.getChildren().map((n) => n.group || n.kind),
                         ['total', 'slowest', 'kinds']);
});

check('targets are listed slowest first', () => {
  const group = view.getChildren().find((n) => n.group === 'targets');
  const rows = view.getChildren(group);
  assert.strictEqual(rows.length, joined.size);
  const first = view.getTreeItem(rows[0]);
  // math_utils spends 3.0 s of its 3.2 s in ar, which is the whole point of
  // the view: it is nowhere near the biggest target.
  assert.strictEqual(first.label, 'math_utils');
  assert.strictEqual(first.description, '3.2 s   27.1%');
});

check('expanding a target shows the steps it paid for', () => {
  const group = view.getChildren().find((n) => n.group === 'targets');
  const engine = view.getChildren(group).find((n) => n.target.name === 'engine');
  const edges = view.getChildren(engine);
  assert.deepStrictEqual(edges.map((n) => view.getTreeItem(n).description),
                         ['127 ms   1.09%', '90 ms   0.77%']);
});

check('a step with two outputs is one row that says so', () => {
  const group = view.getChildren().find((n) => n.group === 'slowest');
  const rows = view.getChildren(group);
  const shared = rows.find((n) => n.edge.outputs.length > 1);
  const item = view.getTreeItem(shared);
  assert.ok(/\(\+1\)$/.test(item.label), 'expected the extra output flagged, got ' + item.label);
  assert.strictEqual(item.description, '158 ms   1.36%');
});

check('the slowest list is capped and says when it is', () => {
  vscodeStub.__setConfig('slowestEdgeLimit', 5);
  const group = view.getChildren().find((n) => n.group === 'slowest');
  assert.strictEqual(view.getChildren(group).length, 5);
  assert.strictEqual(view.getTreeItem(group).description, 'top 5 of 18');
  vscodeStub.__clearConfig();
  assert.strictEqual(view.getTreeItem(group).description, '18');
});

check('work is broken down by what kind it was', () => {
  const group = view.getChildren().find((n) => n.group === 'kinds');
  const rows = view.getChildren(group).map((n) => view.getTreeItem(n));
  assert.deepStrictEqual(rows.map((i) => i.label),
                         ['archiving', 'compiling', 'linking']);
  assert.strictEqual(rows[0].description, '8.8 s   75.9%');
});

check('older runs stay reachable, newest first', () => {
  const group = view.getChildren().find((n) => n.group === 'builds');
  const rows = view.getChildren(group);
  assert.deepStrictEqual(rows.map((n) => view.getTreeItem(n).label),
                         ['most recent', 'build 1']);
  assert.strictEqual(view.getTreeItem(rows[0]).description, '390 ms   4 steps');
  // Its own steps, slowest first.
  assert.strictEqual(view.getChildren(rows[0]).length, 4);
});

check('diff mode renders totals and rows', () => {
  const other = new BuildTimeTreeProvider();
  other.showDiff(full, incremental);
  const roots = other.getChildren();
  assert.deepStrictEqual(roots.map((n) => n.group || n.kind), ['diffTotal', 'diffOutputs']);
  assert.strictEqual(other.getTreeItem(roots[0]).description, '11.8 s → 11.6 s   -136 ms');
  const rows = other.getChildren(roots[1]);
  const first = other.getTreeItem(rows[0]);
  assert.strictEqual(first.description, '-113 ms     203 ms → 90 ms');
});

check('clearing leaves nothing behind', () => {
  const other = new BuildTimeTreeProvider();
  other.showLog(full, null);
  other.clear();
  assert.deepStrictEqual(other.getChildren(), []);
});

console.log('');
console.log('--- the time column on the target tree ---');

const tree = new TargetTreeProvider();
tree.setModel(targets);
const rootNode = (name) => tree.getChildren().find((n) => nameOf(n.id) === name);

check('no build log means no time column at all', () => {
  assert.strictEqual(tree.times, null);
  assert.strictEqual(tree.timeLabel(rootNode('engine').id), '');
});

check('an open log gives every target its share', () => {
  tree.setTimes(joined);
  assert.strictEqual(tree.timeLabel(rootNode('engine').id), '217 ms');
  const item = tree.getTreeItem(rootNode('math_utils'));
  assert.ok(/3\.2 s$/.test(item.description),
            'expected the time last in the description, got ' + item.description);
});

check('sorting by time needs a log and falls back without one', () => {
  vscodeStub.__setConfig('sortTargets', 'time');
  assert.strictEqual(nameOf(tree.getChildren()[0].id), 'math_utils');

  // Structure order leads with an executable; time order does not, which is how
  // we know the fallback actually happened rather than the sort silently
  // comparing every target equal.
  tree.setTimes(null);
  assert.strictEqual(targets.targets.get(tree.getChildren()[0].id).type, 'EXECUTABLE');
  vscodeStub.__clearConfig();
  tree.setTimes(joined);
});

check('the tooltip splits compiling from linking', () => {
  const tip = tree.targetTooltip(targets.targets.get(rootNode('math_utils').id), 'root');
  assert.ok(/build time: 3\.2 s\s+\(184 ms compiling, 3\.0 s linking\)/.test(tip.value),
            tip.value);
});

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

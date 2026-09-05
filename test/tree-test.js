'use strict';

// Renders the real TargetTreeProvider against the fixture. src/tree.js requires
// 'vscode', which only exists inside an extension host, so resolve it to the stub.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return require('./vscode-stub');
  return originalLoad.call(this, request, parent, isMain);
};

const path = require('path');
const assert = require('assert');
const vscodeStub = require('./vscode-stub');
const fileApi = require('../src/fileApi');
const { TargetTreeProvider } = require('../src/tree');

const model = fileApi.loadModel(path.join(__dirname, 'fixture', 'build'), '');
const provider = new TargetTreeProvider();
provider.setModel(model);

const nameOf = (node) => model.targets.get(node.id).name;

// ------------------------------------------------------------ render

const seenIds = new Set();
let duplicateId = null;

function render(node, depth, lines, budget) {
  const item = provider.getTreeItem(node);
  if (seenIds.has(item.id) && !duplicateId) duplicateId = item.id;
  seenIds.add(item.id);

  const marker = node.kind === 'external' ? '#'
    : node.direction === 'forward' ? '>'
      : node.direction === 'reverse' ? '<'
        : node.kind === 'library' ? '.' : ' ';
  lines.push('  '.repeat(depth) + marker + ' ' + item.label +
             (item.description ? '   ' + item.description : ''));
  if (item.collapsibleState === 0 || depth >= budget) return;
  for (const child of provider.getChildren(node)) render(child, depth + 1, lines, budget);
}

const roots = provider.getChildren();
const lines = [];
for (const node of roots) render(node, 0, lines, 2);
console.log(lines.join('\n'));
console.log('');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok    ' + label); }
  catch (e) { failures++; console.log('  FAIL  ' + label + '\n        ' + (e.message || e)); }
}

console.log('--- assertions ---');

check('executables come first, then libraries by how many depend on them', () => {
  assert.deepStrictEqual(roots.map(nameOf), [
    'map_test', 'navi_app', 'nds_test',      // executables, alphabetical among themselves
    'geo_utils', 'map_engine', 'nds_reader', // 2 dependents each
    'dlt_wrapper', 'sqlite_wrap', 'ui_core'  // 1 dependent each
  ]);
});

check('alphabetical order is available', () => {
  vscodeStub.__setConfig('sortTargets', 'name');
  try {
    const names = provider.getChildren().map(nameOf);
    assert.deepStrictEqual(names, [...names].sort());
  } finally {
    vscodeStub.__clearConfig();
    provider.getChildren();
  }
});

check('UTILITY targets stay out of the list', () => {
  assert.ok(!roots.map(nameOf).includes('generate_docs'));
});

check('both counts are on the row, without expanding anything', () => {
  const byName = new Map(roots.map((n) => [nameOf(n), provider.getTreeItem(n)]));
  assert.strictEqual(byName.get('map_engine').description, '→2 ←2');
  assert.strictEqual(byName.get('navi_app').description, '→3');
  assert.strictEqual(byName.get('geo_utils').description, '←2');
});

check('a root target lists both directions directly, no folder in between', () => {
  const node = roots.find((n) => nameOf(n) === 'map_engine');
  const children = provider.getChildren(node);
  assert.deepStrictEqual(children.map((c) => c.direction + ':' + nameOf(c)), [
    'forward:geo_utils', 'forward:nds_reader',
    'reverse:map_test', 'reverse:navi_app'
  ]);
});

check('forward children are the direct dependencies only', () => {
  const node = roots.find((n) => nameOf(n) === 'navi_app');
  const forward = provider.getChildren(node).filter((c) => c.direction === 'forward');
  assert.deepStrictEqual(forward.map(nameOf), ['dlt_wrapper', 'map_engine', 'ui_core']);
});

check('showTransitiveDependencies switches to the full closure', () => {
  vscodeStub.__setConfig('showTransitiveDependencies', true);
  try {
    const node = provider.getChildren().find((n) => nameOf(n) === 'navi_app');
    const forward = provider.getChildren(node).filter((c) => c.direction === 'forward');
    assert.deepStrictEqual(forward.map(nameOf),
      ['dlt_wrapper', 'geo_utils', 'map_engine', 'nds_reader', 'sqlite_wrap', 'ui_core']);
  } finally {
    vscodeStub.__clearConfig();
    provider.getChildren();
  }
});

check('a chain node keeps following its own direction', () => {
  const node = roots.find((n) => nameOf(n) === 'navi_app');
  const mapEngine = provider.getChildren(node).find((c) => nameOf(c) === 'map_engine');
  const next = provider.getChildren(mapEngine);
  assert.deepStrictEqual(next.map((c) => c.direction + ':' + nameOf(c)),
    ['forward:geo_utils', 'forward:nds_reader']);

  const geoUtils = roots.find((n) => nameOf(n) === 'geo_utils');
  const consumer = provider.getChildren(geoUtils).find((c) => nameOf(c) === 'map_engine');
  assert.deepStrictEqual(provider.getChildren(consumer).map((c) => c.direction + ':' + nameOf(c)),
    ['reverse:map_test', 'reverse:navi_app']);
});

check('direction is carried by a coloured arrow icon', () => {
  const node = roots.find((n) => nameOf(n) === 'map_engine');
  const [forward] = provider.getChildren(node);
  const reverse = provider.getChildren(node).find((c) => c.direction === 'reverse');
  const forwardItem = provider.getTreeItem(forward);
  const reverseItem = provider.getTreeItem(reverse);
  assert.strictEqual(forwardItem.iconPath.id, 'arrow-small-right');
  assert.strictEqual(reverseItem.iconPath.id, 'arrow-small-left');
  assert.notStrictEqual(forwardItem.iconPath.color.id, reverseItem.iconPath.color.id);
});

check('a chain node shows its type and how much further it goes', () => {
  const node = roots.find((n) => nameOf(n) === 'navi_app');
  const mapEngine = provider.getChildren(node).find((c) => nameOf(c) === 'map_engine');
  assert.strictEqual(provider.getTreeItem(mapEngine).description, 'static   →2');
  const dlt = provider.getChildren(node).find((c) => nameOf(c) === 'dlt_wrapper');
  assert.strictEqual(provider.getTreeItem(dlt).description, 'static');
  assert.strictEqual(provider.getTreeItem(dlt).collapsibleState, 0);
});

check('external libraries sit in one bucket at the end', () => {
  const node = roots.find((n) => nameOf(n) === 'navi_app');
  const children = provider.getChildren(node);
  const last = children[children.length - 1];
  assert.strictEqual(last.kind, 'external');
  const item = provider.getTreeItem(last);
  assert.strictEqual(item.label, 'external');
  assert.strictEqual(item.description, '3');
  assert.deepStrictEqual(provider.getChildren(last).map((c) => c.name),
    ['-lsqlite3', '-ldlt', '-lpthread']);
});

check('a root target icon reflects its type', () => {
  const byName = new Map(roots.map((n) => [nameOf(n), provider.getTreeItem(n)]));
  assert.strictEqual(byName.get('navi_app').iconPath.id, 'rocket');
  assert.strictEqual(byName.get('map_engine').iconPath.id, 'package');
  assert.strictEqual(byName.get('ui_core').iconPath.id, 'library');
});

check('the tooltip spells out both directions and the transitive count', () => {
  const node = roots.find((n) => nameOf(n) === 'navi_app');
  const tooltip = provider.getTreeItem(node).tooltip.value;
  assert.ok(/links → 3/.test(tooltip), tooltip);
  assert.ok(/including transitive/.test(tooltip), tooltip);
  assert.ok(/linked by ← 0/.test(tooltip), tooltip);
});

check('tree item ids are unique', () => {
  assert.strictEqual(duplicateId, null, 'duplicate id: ' + duplicateId);
});

check('getParent walks back to the root node', () => {
  const node = roots.find((n) => nameOf(n) === 'geo_utils');
  const child = provider.getChildren(node)[0];
  assert.strictEqual(provider.getParent(child), node);
  assert.strictEqual(provider.getParent(node), undefined);
});

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

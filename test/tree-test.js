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

const seenIds = new Set();
let duplicateId = null;

function render(node, depth, lines, budget) {
  const item = provider.getTreeItem(node);
  if (seenIds.has(item.id) && !duplicateId) duplicateId = item.id;
  seenIds.add(item.id);

  const collapsible = item.collapsibleState !== 0;
  lines.push(
    '  '.repeat(depth) + (collapsible ? '+ ' : '- ') + item.label +
    (item.description ? '   [' + item.description + ']' : '')
  );
  if (!collapsible || depth >= budget) return;
  for (const child of provider.getChildren(node)) render(child, depth + 1, lines, budget);
}

const roots = provider.getChildren();
const lines = [];
for (const node of roots) render(node, 0, lines, 3);
console.log(lines.join('\n'));
console.log('');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok    ' + label); }
  catch (e) { failures++; console.log('  FAIL  ' + label + '\n        ' + (e.message || e)); }
}

console.log('--- assertions ---');

check('root shows only linkable targets, sorted', () => {
  assert.deepStrictEqual(roots.map((n) => model.targets.get(n.id).name), [
    'dlt_wrapper', 'geo_utils', 'map_engine', 'map_test',
    'navi_app', 'nds_reader', 'nds_test', 'sqlite_wrap', 'ui_core'
  ]);
});

check('tree item ids are unique', () => {
  assert.strictEqual(duplicateId, null, 'duplicate id: ' + duplicateId);
});

const naviNode = roots.find((n) => model.targets.get(n.id).name === 'navi_app');
check('an executable shows links and external groups, but no reverse group', () => {
  const groups = provider.getChildren(naviNode).map((g) => g.group);
  assert.deepStrictEqual(groups, ['forward', 'external']);
});

const geoNode = roots.find((n) => model.targets.get(n.id).name === 'geo_utils');
check('a leaf library shows only the reverse group', () => {
  const groups = provider.getChildren(geoNode).map((g) => g.group);
  assert.deepStrictEqual(groups, ['reverse']);
});

check('reverse group lists both consumers', () => {
  const group = provider.getChildren(geoNode)[0];
  const names = provider.getChildren(group).map((n) => model.targets.get(n.id).name);
  assert.deepStrictEqual(names, ['map_engine', 'ui_core']);
});

check('group label and count are rendered', () => {
  const item = provider.getTreeItem(provider.getChildren(geoNode)[0]);
  assert.strictEqual(item.label, 'linked by ←');
  assert.strictEqual(item.description, '2');
});

check('the forward group shows direct dependencies only', () => {
  const forwardGroup = provider.getChildren(naviNode)[0];
  const names = provider.getChildren(forwardGroup).map((n) => model.targets.get(n.id).name);
  assert.deepStrictEqual(names, ['dlt_wrapper', 'map_engine', 'ui_core']);
});

check('expanding a forward child keeps following forward only', () => {
  const forwardGroup = provider.getChildren(naviNode)[0];
  const mapEngine = provider.getChildren(forwardGroup)
    .find((n) => model.targets.get(n.id).name === 'map_engine');
  const next = provider.getChildren(mapEngine).map((n) => model.targets.get(n.id).name);
  assert.deepStrictEqual(next, ['geo_utils', 'nds_reader']);
});

check('showTransitiveDependencies switches to the full closure', () => {
  vscodeStub.__setConfig('showTransitiveDependencies', true);
  try {
    const forwardGroup = provider.getChildren(naviNode)[0];
    const names = provider.getChildren(forwardGroup).map((n) => model.targets.get(n.id).name);
    assert.deepStrictEqual(names,
      ['dlt_wrapper', 'geo_utils', 'map_engine', 'nds_reader', 'sqlite_wrap', 'ui_core']);
  } finally {
    vscodeStub.__clearConfig();
  }
});

check('external libraries render as leaves', () => {
  const externalGroup = provider.getChildren(naviNode)[1];
  const items = provider.getChildren(externalGroup).map((n) => provider.getTreeItem(n));
  assert.deepStrictEqual(items.map((i) => i.label), ['-lsqlite3', '-ldlt', '-lpthread']);
  assert.deepStrictEqual(items.map((i) => i.collapsibleState), [0, 0, 0]);
});

check('a target with no relations is not collapsible', () => {
  const dlt = roots.find((n) => model.targets.get(n.id).name === 'sqlite_wrap');
  const forwardGroups = provider.getChildren(dlt).map((g) => g.group);
  assert.deepStrictEqual(forwardGroups, ['reverse']);
});

check('getParent walks back to the root node', () => {
  const group = provider.getChildren(geoNode)[0];
  const child = provider.getChildren(group)[0];
  assert.strictEqual(provider.getParent(child), group);
  assert.strictEqual(provider.getParent(group), geoNode);
  assert.strictEqual(provider.getParent(geoNode), undefined);
});

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

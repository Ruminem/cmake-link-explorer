'use strict';

// Exercises src/fileApi.js against a CMake File API reply. By default it uses the
// synthetic fixture (test/make-fixture.py); pass a real build directory to check
// against CMake's own output:
//
//   node test/run.js /path/to/build

const path = require('path');
const assert = require('assert');
const fileApi = require('../src/fileApi');

const buildDir = process.argv[2] || path.join(__dirname, 'fixture', 'build');
const usingFixture = !process.argv[2];

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log('  ok    ' + label);
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + label);
    console.log('        ' + (e.message || e).split('\n')[0]);
  }
}

console.log('build directory: ' + buildDir);
assert.ok(fileApi.isBuildDir(buildDir), 'no CMakeCache.txt in ' + buildDir);

const model = fileApi.loadModel(buildDir, '');
const byName = new Map(Array.from(model.targets.values()).map((t) => [t.name, t]));
const nameOf = (id) => model.targets.get(id).name;
const namesOf = (ids) => ids.map(nameOf).sort();

console.log('configuration: ' + model.configuration + '  (' + model.configurations.join(', ') + ')');
console.log('targets: ' + model.targets.size);
console.log('');

console.log('--- structure ---');
for (const target of Array.from(model.targets.values()).sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(target.name + '  [' + target.type + ']');
  const links = namesOf(target.dependencyIds);
  const linkedBy = namesOf(model.linkedBy.get(target.id));
  if (links.length) console.log('    links      -> ' + links.join(', '));
  if (linkedBy.length) console.log('    linked by  <- ' + linkedBy.join(', '));
  if (target.externalLibraries.length) console.log('    external   :: ' + target.externalLibraries.join(', '));
}
console.log('');

if (!usingFixture) {
  console.log('Ran against a real build tree; skipping fixture-specific assertions.');
  process.exit(0);
}

console.log('--- assertions ---');

check('all fixture targets are loaded', () => {
  assert.strictEqual(model.targets.size, 10);
});

check('UTILITY targets are excluded from the link graph', () => {
  assert.strictEqual(fileApi.isLinkable(byName.get('generate_docs')), false);
  assert.strictEqual(fileApi.isLinkable(byName.get('navi_app')), true);
});

check('forward dependencies match', () => {
  assert.deepStrictEqual(namesOf(byName.get('navi_app').dependencyIds), [
    'dlt_wrapper', 'map_engine', 'ui_core'
  ]);
});

check('reverse dependencies are built for a shared leaf', () => {
  assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('geo_utils').id)), [
    'map_engine', 'ui_core'
  ]);
});

check('reverse dependencies span app and test targets', () => {
  assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('nds_reader').id)), [
    'map_engine', 'nds_test'
  ]);
});

check('project-built libraries are not reported as external', () => {
  const external = byName.get('navi_app').externalLibraries;
  assert.deepStrictEqual(external, ['-lsqlite3', '-ldlt', '-lpthread']);
});

check('frameworks are captured as external', () => {
  assert.deepStrictEqual(byName.get('ui_core').externalLibraries, ['-framework CoreGraphics']);
});

check('link flags are not mistaken for libraries', () => {
  for (const target of model.targets.values()) {
    assert.ok(
      !target.externalLibraries.some((lib) => lib.indexOf('dead_strip') !== -1),
      target.name + ' picked up a linker flag as a library'
    );
  }
});

check('static libraries have no link line', () => {
  assert.deepStrictEqual(byName.get('map_engine').externalLibraries, []);
});

check('transitive path is found', () => {
  const ids = fileApi.findLinkPath(model, byName.get('navi_app').id, byName.get('sqlite_wrap').id);
  assert.deepStrictEqual(ids.map(nameOf), ['navi_app', 'map_engine', 'nds_reader', 'sqlite_wrap']);
});

check('unrelated targets report no path', () => {
  const ids = fileApi.findLinkPath(model, byName.get('map_test').id, byName.get('dlt_wrapper').id);
  assert.strictEqual(ids, null);
});

check('a target reaches itself in zero hops', () => {
  const id = byName.get('geo_utils').id;
  assert.deepStrictEqual(fileApi.findLinkPath(model, id, id), [id]);
});

check('build directory discovery finds the fixture', () => {
  const found = fileApi.findBuildDirs([path.join(__dirname, 'fixture')]);
  assert.ok(found.indexOf(buildDir) !== -1, 'discovery returned ' + JSON.stringify(found));
});

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

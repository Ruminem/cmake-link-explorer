'use strict';

// Exercises src/fileApi.js against a CMake File API reply.
//
//   node test/run.js                  synthetic fixture (test/make-fixture.py)
//   node test/run.js /path/to/build   any real CMake build tree
//
// The generic checks hold for any project. test/sample-project mirrors the
// fixture, so the project-specific checks run for either of those two.

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
    console.log('        ' + String(e.message || e).split('\n')[0]);
  }
}

assert.ok(fileApi.isBuildDir(buildDir), 'no CMakeCache.txt in ' + buildDir);

const model = fileApi.loadModel(buildDir, '');
const byName = new Map(Array.from(model.targets.values()).map((t) => [t.name, t]));
const nameOf = (id) => model.targets.get(id).name;
const namesOf = (ids) => ids.map(nameOf).sort();

console.log('build directory: ' + buildDir);
console.log('configuration:   ' + (model.configuration || '(default)'));
console.log('targets:         ' + model.targets.size);
console.log('');

const sorted = Array.from(model.targets.values()).sort((a, b) => a.name.localeCompare(b.name));
console.log('--- structure ---');
for (const target of sorted.slice(0, 40)) {
  const direct = namesOf(target.directDependencyIds);
  const extra = namesOf(target.dependencyIds).filter((n) => direct.indexOf(n) === -1);
  const linkedBy = namesOf(model.linkedBy.get(target.id));
  console.log(target.name + '  [' + target.type + ']');
  if (direct.length) {
    console.log('    links      -> ' + direct.join(', ') +
                (extra.length ? '     (+transitive: ' + extra.join(', ') + ')' : ''));
  }
  if (linkedBy.length) console.log('    linked by  <- ' + linkedBy.join(', '));
  if (target.externalLibraries.length) console.log('    external   :: ' + target.externalLibraries.join(', '));
}
if (sorted.length > 40) console.log('... and ' + (sorted.length - 40) + ' more targets');

console.log('');
console.log('--- generic checks ---');

check('every dependency id resolves to a known target', () => {
  for (const target of model.targets.values()) {
    for (const id of target.dependencyIds) {
      assert.ok(model.targets.has(id), target.name + ' depends on unknown id ' + id);
    }
  }
});

check('reduced edges are a subset of what CMake reported', () => {
  for (const target of model.targets.values()) {
    for (const id of target.directDependencyIds) {
      assert.ok(target.dependencyIds.indexOf(id) !== -1,
                target.name + ': a direct dependency is not in the full set');
    }
  }
});

check('reducing dependencies never loses reachability', () => {
  for (const target of model.targets.values()) {
    for (const id of target.dependencyIds) {
      assert.ok(fileApi.findLinkPath(model, target.id, id),
                target.name + ' can no longer reach ' + nameOf(id) + ' after reduction');
    }
  }
});

check('the reverse index agrees with the forward one', () => {
  for (const target of model.targets.values()) {
    for (const id of target.directDependencyIds) {
      assert.ok(model.linkedBy.get(id).indexOf(target.id) !== -1,
                nameOf(id) + ' is missing ' + target.name + ' in its reverse list');
    }
  }
});

check('linker options never appear as libraries', () => {
  for (const target of model.targets.values()) {
    for (const lib of target.externalLibraries) {
      assert.ok(lib.indexOf('-Wl,') === -1, target.name + ' lists a linker option: ' + lib);
      assert.ok(!/^-L/.test(lib), target.name + ' lists a library search path: ' + lib);
    }
  }
});

check('project-built libraries are not reported as external', () => {
  const artifacts = new Set(Array.from(model.targets.values()).map((t) => t.nameOnDisk).filter(Boolean));
  for (const target of model.targets.values()) {
    for (const lib of target.externalLibraries) {
      assert.ok(!artifacts.has(path.basename(lib)), target.name + ' lists artifact ' + lib);
    }
  }
});

check('library fragments are told apart from options', () => {
  assert.strictEqual(fileApi.isLibraryFragment('-lpthread'), true);
  assert.strictEqual(fileApi.isLibraryFragment('-framework CoreGraphics'), true);
  assert.strictEqual(fileApi.isLibraryFragment('/usr/lib/libz.dylib'), true);
  assert.strictEqual(fileApi.isLibraryFragment('-Wl,-rpath,/opt/lib'), false);
  assert.strictEqual(fileApi.isLibraryFragment('-L/usr/lib'), false);
});

check('build directory discovery finds this build tree', () => {
  const found = fileApi.findBuildDirs([path.dirname(buildDir)]);
  assert.ok(found.indexOf(buildDir) !== -1, 'discovery returned ' + JSON.stringify(found));
});

const isSampleProject = byName.has('navi_app') && byName.has('map_engine');
if (isSampleProject) {
  console.log('');
  console.log('--- sample project checks ---');

  check('UTILITY targets are excluded from the link graph', () => {
    assert.strictEqual(fileApi.isLinkable(byName.get('generate_docs')), false);
    assert.strictEqual(fileApi.isLinkable(byName.get('navi_app')), true);
  });

  check('direct dependencies match target_link_libraries', () => {
    assert.deepStrictEqual(namesOf(byName.get('navi_app').directDependencyIds),
                           ['dlt_wrapper', 'map_engine', 'ui_core']);
    assert.deepStrictEqual(namesOf(byName.get('map_engine').directDependencyIds),
                           ['geo_utils', 'nds_reader']);
  });

  check('CMake still reports the full transitive closure', () => {
    assert.deepStrictEqual(namesOf(byName.get('navi_app').dependencyIds),
                           ['dlt_wrapper', 'geo_utils', 'map_engine', 'nds_reader', 'sqlite_wrap', 'ui_core']);
  });

  check('reverse dependencies name only the direct consumers', () => {
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('geo_utils').id)),
                           ['map_engine', 'ui_core']);
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('sqlite_wrap').id)),
                           ['nds_reader']);
  });

  check('reverse dependencies span app and test targets', () => {
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('nds_reader').id)),
                           ['map_engine', 'nds_test']);
  });

  check('static libraries have no link line', () => {
    assert.deepStrictEqual(byName.get('map_engine').externalLibraries, []);
  });

  check('transitive path follows direct edges hop by hop', () => {
    const ids = fileApi.findLinkPath(model, byName.get('navi_app').id, byName.get('sqlite_wrap').id);
    assert.deepStrictEqual(ids.map(nameOf), ['navi_app', 'map_engine', 'nds_reader', 'sqlite_wrap']);
  });

  check('unrelated targets report no path', () => {
    assert.strictEqual(
      fileApi.findLinkPath(model, byName.get('map_test').id, byName.get('dlt_wrapper').id), null);
  });

  check('a target reaches itself in zero hops', () => {
    const id = byName.get('geo_utils').id;
    assert.deepStrictEqual(fileApi.findLinkPath(model, id, id), [id]);
  });
}

if (usingFixture) {
  check('fixture: system libraries survive filtering', () => {
    assert.deepStrictEqual(byName.get('navi_app').externalLibraries,
                           ['-lsqlite3', '-ldlt', '-lpthread']);
  });
  check('fixture: frameworks are captured', () => {
    assert.deepStrictEqual(byName.get('ui_core').externalLibraries, ['-framework CoreGraphics']);
  });
}

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

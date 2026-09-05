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

check('a dependency cycle neither hangs nor loses edges', () => {
  // Static library cycles are legal in CMake. The reduction must not drop an
  // edge that is the only way to reach a target, and must terminate.
  const cyclic = {
    targets: new Map(),
    linkedBy: new Map(),
    sourceDir: '',
    configuration: ''
  };
  const make = (name, deps) => ({
    id: name, name, type: 'STATIC_LIBRARY', nameOnDisk: 'lib' + name + '.a',
    sourceDir: name, dependencyIds: deps, externalLibraries: [], sources: [], sourceCount: 0
  });
  // a <-> b, both reaching c, plus a lone d.
  for (const t of [make('a', ['b', 'c']), make('b', ['a', 'c']), make('c', []), make('d', [])]) {
    cyclic.targets.set(t.id, t);
  }
  fileApi.reduceDependencies(cyclic.targets);

  for (const [id, expected] of [['a', ['b', 'c']], ['b', ['a', 'c']], ['c', []], ['d', []]]) {
    const direct = cyclic.targets.get(id).directDependencyIds;
    for (const dep of expected) {
      assert.ok(direct.indexOf(dep) !== -1 ||
                expected.some((other) => other !== dep &&
                  cyclic.targets.get(other).dependencyIds.indexOf(dep) !== -1),
                id + ' can no longer reach ' + dep);
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

const isSampleProject = byName.has('sample_app') && byName.has('engine');
if (isSampleProject) {
  console.log('');
  console.log('--- sample project checks ---');

  check('UTILITY targets are excluded from the link graph', () => {
    assert.strictEqual(fileApi.isLinkable(byName.get('generate_docs')), false);
    assert.strictEqual(fileApi.isLinkable(byName.get('sample_app')), true);
  });

  check('direct dependencies match target_link_libraries', () => {
    assert.deepStrictEqual(namesOf(byName.get('sample_app').directDependencyIds),
                           ['engine', 'log_wrapper', 'render_core']);
    assert.deepStrictEqual(namesOf(byName.get('engine').directDependencyIds),
                           ['math_utils', 'store_reader']);
  });

  check('CMake still reports the full transitive closure', () => {
    assert.deepStrictEqual(namesOf(byName.get('sample_app').dependencyIds),
                           ['db_wrap', 'engine', 'log_wrapper', 'math_utils', 'render_core', 'store_reader']);
  });

  check('reverse dependencies name only the direct consumers', () => {
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('math_utils').id)),
                           ['engine', 'render_core']);
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('db_wrap').id)),
                           ['store_reader']);
  });

  check('reverse dependencies span app and test targets', () => {
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('store_reader').id)),
                           ['engine', 'store_test']);
  });

  check('static libraries have no link line', () => {
    assert.deepStrictEqual(byName.get('engine').externalLibraries, []);
  });

  check('transitive path follows direct edges hop by hop', () => {
    const ids = fileApi.findLinkPath(model, byName.get('sample_app').id, byName.get('db_wrap').id);
    assert.deepStrictEqual(ids.map(nameOf), ['sample_app', 'engine', 'store_reader', 'db_wrap']);
  });

  check('unrelated targets report no path', () => {
    assert.strictEqual(
      fileApi.findLinkPath(model, byName.get('engine_test').id, byName.get('log_wrapper').id), null);
  });

  check('a target reaches itself in zero hops', () => {
    const id = byName.get('math_utils').id;
    assert.deepStrictEqual(fileApi.findLinkPath(model, id, id), [id]);
  });
}

if (usingFixture) {
  check('fixture: system libraries survive filtering', () => {
    assert.deepStrictEqual(byName.get('sample_app').externalLibraries,
                           ['-lsqlite3', '-lz', '-lpthread']);
  });
  check('fixture: frameworks are captured', () => {
    assert.deepStrictEqual(byName.get('render_core').externalLibraries, ['-framework CoreGraphics']);
  });
}

console.log('');
console.log('--- where CMake says a target came from ---');

// Text search cannot find add_library(${name}) inside a helper function, which
// is how plenty of real projects declare targets. These graphs are the shape
// CMake hands over, spelled out here so the checks run without a build tree.
{
  const graph = {
    files: ['CMakeLists.txt', 'cmake/helpers.cmake'],
    commands: ['add_library', 'add_module', 'target_link_libraries'],
    nodes: [
      { file: 0 },                                  // 0: top of the directory
      { file: 0, line: 1, command: 0, parent: 0 },  // 1: plain add_library()
      { file: 0, line: 9, command: 1, parent: 0 },  // 2: add_module(sensor)
      { file: 1, line: 4, command: 0, parent: 2 },  // 3: the add_library inside it
      { file: 0, line: 12, command: 2, parent: 0 }  // 4: target_link_libraries()
    ]
  };

  check('a plain declaration is one hop', () => {
    assert.deepStrictEqual(fileApi.backtraceChain(graph, 1),
                           [{ file: 'CMakeLists.txt', line: 1, command: 'add_library' }]);
  });

  check('a target made inside a helper reports both ends', () => {
    const chain = fileApi.backtraceChain(graph, 3);
    // Innermost first: the add_library that ran, then the call somebody wrote.
    assert.deepStrictEqual(chain[0], { file: 'cmake/helpers.cmake', line: 4, command: 'add_library' });
    assert.deepStrictEqual(chain[chain.length - 1],
                           { file: 'CMakeLists.txt', line: 9, command: 'add_module' });
  });

  check('the top of a directory is not a site', () => {
    assert.deepStrictEqual(fileApi.backtraceChain(graph, 0), []);
    // Every entry has to carry somewhere to jump to.
    for (const index of [0, 1, 2, 3, 4]) {
      for (const site of fileApi.backtraceChain(graph, index)) {
        assert.ok(typeof site.file === 'string' && site.line > 0, JSON.stringify(site));
      }
    }
  });

  check('a malformed graph yields nothing rather than throwing', () => {
    assert.deepStrictEqual(fileApi.backtraceChain(null, 0), []);
    assert.deepStrictEqual(fileApi.backtraceChain(graph, undefined), []);
    assert.deepStrictEqual(fileApi.backtraceChain(graph, 99), []);
    assert.deepStrictEqual(fileApi.backtraceChain({ nodes: [{ file: 7, line: 1, command: 0 }] }, 0), []);
    // A parent cycle must not spin forever.
    const looped = { files: ['a'], commands: ['c'], nodes: [{ file: 0, line: 1, command: 0, parent: 1 },
                                                           { file: 0, line: 2, command: 0, parent: 0 }] };
    assert.strictEqual(fileApi.backtraceChain(looped, 0).length, 2);
  });
}

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

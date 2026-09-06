'use strict';

// Exercises src/fileApi.js against a CMake File API reply.
//
//   node test/run.js                  synthetic fixture (test/make-fixture.py)
//   node test/run.js /path/to/build   any real CMake build tree
//
// The generic checks hold for any project. test/sample-project mirrors the
// fixture, so the project-specific checks run for either of those two.

const fs = require('fs');
const os = require('os');
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

if (isSampleProject) {
  check('a site is kept for every edge a view can walk, and no others', () => {
    const app = byName.get('sample_app');
    if (!app.dependencySites.size) {
      console.log('        (skipped: this reply carries no backtraces)');
      return;
    }
    // Why Is This Linked? prints the line beside each hop, so every direct
    // dependency has to have one.
    for (const id of app.directDependencyIds) {
      assert.ok(app.dependencySites.get(id), nameOf(id) + ' lost its site');
    }
    // The closure carries more than the reduction kept, and nothing can reach
    // those in one hop. Holding a site for them is what made the map 20 times
    // larger than anything reads.
    const closureOnly = app.dependencyIds.filter((id) =>
      app.directDependencyIds.indexOf(id) === -1 && app.linkTargetIds.indexOf(id) === -1);
    assert.ok(closureOnly.length, 'the fixture should have transitive-only dependencies');
    for (const id of closureOnly) {
      assert.strictEqual(app.dependencySites.get(id), undefined,
                         nameOf(id) + ' is transitive-only and should not be kept');
    }
  });

  check('compile groups survive a real codemodel', () => {
    const engine = byName.get('engine');
    // The synthetic fixture does not write compileGroups; a real reply does.
    if (!engine.compileGroups.length) {
      console.log('        (skipped: this reply carries no compile groups)');
      return;
    }
    const group = engine.compileGroups[0];
    assert.strictEqual(group.language, 'CXX');
    assert.ok(group.sourceIndexes.length > 0, 'the group claims no sources');
    // target_include_directories(engine PUBLIC .) has to show up somewhere,
    // with the trailing "/." CMake writes for "." already trimmed off.
    assert.ok(group.includes.some((i) => /engine$/.test(i.path)),
              JSON.stringify(group.includes));
    assert.ok(group.includes.every((i) => !/[\\/]\.$/.test(i.path)),
              JSON.stringify(group.includes));
    for (const include of group.includes) {
      assert.strictEqual(typeof include.isSystem, 'boolean', JSON.stringify(include));
    }
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
console.log('--- cycles and unused targets ---');

// Spelled out rather than configured, so these run without CMake. `links` is
// the link line as written; `deps` is the build order CMake derives from it,
// which is where the edge closing a cycle goes missing.
function graph(rows, options) {
  const targets = new Map();
  for (const row of rows) {
    targets.set(row.name, {
      id: row.name, name: row.name, type: row.type || 'STATIC_LIBRARY',
      linkTargetIds: row.links || [],
      directDependencyIds: row.deps || row.links || [],
      dependencyIds: row.deps || row.links || [],
      isInstalled: !!row.installed
    });
  }
  const linkedBy = new Map();
  for (const id of targets.keys()) linkedBy.set(id, []);
  for (const target of targets.values()) {
    for (const id of target.directDependencyIds) {
      if (linkedBy.has(id)) linkedBy.get(id).push(target.id);
    }
  }
  return {
    targets, linkedBy,
    hasLinkGraph: !options || options.hasLinkGraph !== false
  };
}

check('a cycle is reported as a walkable chain', () => {
  const model = graph([
    { name: 'a', links: ['b'] },
    { name: 'b', links: ['c'] },
    { name: 'c', links: ['a'] },
    { name: 'app', type: 'EXECUTABLE', links: ['a'] }
  ]);
  const cycles = fileApi.findCycles(model);
  assert.strictEqual(cycles.length, 1);
  // Any rotation is correct as long as each step really links the next one.
  const names = cycles[0];
  assert.deepStrictEqual([...names].sort(), ['a', 'b', 'c']);
  for (let i = 0; i < names.length; i++) {
    const from = model.targets.get(names[i]);
    assert.ok(from.linkTargetIds.indexOf(names[(i + 1) % names.length]) !== -1,
              names[i] + ' does not link ' + names[(i + 1) % names.length]);
  }
});

check('an acyclic graph reports nothing', () => {
  assert.deepStrictEqual(fileApi.findCycles(graph([
    { name: 'app', type: 'EXECUTABLE', links: ['a'] },
    { name: 'a', links: ['b'] },
    { name: 'b', links: [] }
  ])), []);
});

check('two separate cycles are both found', () => {
  const cycles = fileApi.findCycles(graph([
    { name: 'a', links: ['b'] }, { name: 'b', links: ['a'] },
    { name: 'x', links: ['y'] }, { name: 'y', links: ['x'] },
    { name: 'lonely', links: [] }
  ]));
  assert.strictEqual(cycles.length, 2);
  assert.deepStrictEqual(cycles.map((c) => c.slice().sort().join('')).sort(), ['ab', 'xy']);
});

check('a target linking itself counts', () => {
  const cycles = fileApi.findCycles(graph([{ name: 'a', links: ['a'] }]));
  assert.deepStrictEqual(cycles, [['a']]);
});

check('an older codemodel says it cannot tell rather than "none"', () => {
  // CMake drops the closing edge from the build order, so a graph that has
  // edges but no link lists genuinely cannot be judged.
  const model = graph([{ name: 'a', deps: ['b'] }, { name: 'b', deps: [] }],
                      { hasLinkGraph: false });
  assert.strictEqual(fileApi.findCycles(model), null);
});

check('a project with no edges at all is answerable either way', () => {
  const model = graph([{ name: 'a', links: [] }, { name: 'b', links: [] }],
                      { hasLinkGraph: false });
  assert.deepStrictEqual(fileApi.findCycles(model), []);
});

check('only libraries nothing needs are called unused', () => {
  const model = graph([
    { name: 'app', type: 'EXECUTABLE', links: ['used'] },
    { name: 'used', links: [] },
    { name: 'orphan', links: [] },
    { name: 'shipped', links: [], installed: true },
    { name: 'plugin', type: 'MODULE_LIBRARY', links: [] },
    { name: 'docs', type: 'UTILITY', links: [] }
  ]);
  // app is an entry point, used is linked, shipped is the deliverable, a plugin
  // is dlopened rather than linked, and a utility target builds nothing.
  assert.deepStrictEqual(fileApi.findUnusedTargets(model).map((t) => t.name), ['orphan']);
});

check('a library reachable only through the link line is not called unused', () => {
  // The cycle edge lives in linkTargetIds and nowhere else; missing it would
  // report a library that something plainly links.
  const model = graph([
    { name: 'a', links: ['b'], deps: ['b'] },
    { name: 'b', links: ['a'], deps: [] }
  ]);
  assert.deepStrictEqual(fileApi.findUnusedTargets(model).map((t) => t.name), []);
});

console.log('');
console.log('--- comparing two configured trees ---');

// The point of the comparison is the pair of trees living on different
// machines, so these give the two sides different source roots on purpose.
function tree(sourceDir, rows) {
  const targets = new Map();
  for (const row of rows) {
    targets.set(row.name, {
      id: row.name, name: row.name, type: row.type || 'STATIC_LIBRARY',
      linkTargetIds: row.links || [],
      externalLibraries: row.externals || [],
      compileGroups: [{
        language: 'CXX', standard: null,
        defines: row.defines || [],
        includes: (row.includes || []).map((p) => ({ path: p, isSystem: false })),
        sourceIndexes: [0]
      }]
    });
  }
  return { sourceDir, targets, buildDir: sourceDir + '/build' };
}

const WIN = 'C:/work/proj';
const NIX = '/home/me/proj';

check('a target on one side only is reported', () => {
  const diff = fileApi.compareModels(
    tree(WIN, [{ name: 'core' }, { name: 'win_shim' }]),
    tree(NIX, [{ name: 'core' }, { name: 'posix_shim' }]));
  assert.deepStrictEqual(diff.onlyLeft.map((t) => t.name), ['win_shim']);
  assert.deepStrictEqual(diff.onlyRight.map((t) => t.name), ['posix_shim']);
});

check('macros that differ are the headline', () => {
  const diff = fileApi.compareModels(
    tree(WIN, [{ name: 'core', defines: ['CORE_V=2', 'USE_IOCP'] }]),
    tree(NIX, [{ name: 'core', defines: ['CORE_V=2', 'USE_EPOLL'] }]));
  assert.strictEqual(diff.changed.length, 1);
  assert.deepStrictEqual(diff.changed[0].defines.removed, ['USE_IOCP']);
  assert.deepStrictEqual(diff.changed[0].defines.added, ['USE_EPOLL']);
});

check('include paths are matched against each tree own source root', () => {
  // Identical layout, two machines. Compared as they stand, every path differs.
  const diff = fileApi.compareModels(
    tree(WIN, [{ name: 'core', includes: [WIN + '/src', WIN + '/src/win'] }]),
    tree(NIX, [{ name: 'core', includes: [NIX + '/src', NIX + '/src/posix'] }]));
  assert.strictEqual(diff.changed.length, 1);
  assert.deepStrictEqual(diff.changed[0].includes.removed, ['src/win']);
  assert.deepStrictEqual(diff.changed[0].includes.added, ['src/posix']);
});

check('a backslash root still lines up with a forward-slash one', () => {
  const diff = fileApi.compareModels(
    tree('C:\\work\\proj', [{ name: 'core', includes: ['C:\\work\\proj\\src'] }]),
    tree(NIX, [{ name: 'core', includes: [NIX + '/src'] }]));
  assert.deepStrictEqual(diff.changed, []);
});

check('a differently cased checkout is not a wall of differences', () => {
  const diff = fileApi.compareModels(
    tree('C:/Work/Proj', [{ name: 'core', includes: ['C:/work/proj/src'] }]),
    tree(NIX, [{ name: 'core', includes: [NIX + '/src'] }]));
  assert.deepStrictEqual(diff.changed, []);
});

check('SDK paths outside the project are not called differences', () => {
  // /opt/sdk against C:/SDK says where two machines keep a toolchain, nothing
  // about the project, and would otherwise fire on every target.
  const diff = fileApi.compareModels(
    tree(WIN, [{ name: 'core', includes: ['C:/SDK/include'], externals: ['ws2_32.lib'] }]),
    tree(NIX, [{ name: 'core', includes: ['/opt/sdk/include'], externals: ['-lz'] }]));
  assert.deepStrictEqual(diff.changed, []);
});

check('a type or a link that changed is caught', () => {
  const diff = fileApi.compareModels(
    tree(WIN, [{ name: 'core', type: 'STATIC_LIBRARY', links: ['a'] }, { name: 'a' }]),
    tree(NIX, [{ name: 'core', type: 'SHARED_LIBRARY', links: ['b'] }, { name: 'b' },
               { name: 'a' }]));
  const core = diff.changed.find((c) => c.name === 'core');
  assert.deepStrictEqual(core.type, { left: 'STATIC_LIBRARY', right: 'SHARED_LIBRARY' });
  assert.deepStrictEqual(core.links.removed, ['a']);
  assert.deepStrictEqual(core.links.added, ['b']);
});

check('two trees configured the same way report nothing', () => {
  const rows = [{ name: 'core', defines: ['CORE_V=2'], links: ['a'] }, { name: 'a' }];
  const diff = fileApi.compareModels(tree(WIN, rows), tree(NIX, rows));
  assert.deepStrictEqual(diff.onlyLeft, []);
  assert.deepStrictEqual(diff.onlyRight, []);
  assert.deepStrictEqual(diff.changed, []);
});

console.log('');
console.log('--- knowing the reply is out of date ---');

// The reply is a snapshot taken at configure time. Deleting a
// target_link_libraries() line does not change it, so without this check the
// extension answers "already links spdlog" about a line that is gone -- and the
// wrong answer is indistinguishable from a right one. Found on a real project.
const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cle-stale-'));

function staleModel(replyTime, files) {
  const written = [];
  for (const [name, mtime] of files) {
    const file = path.join(staleDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'add_library(x x.cpp)\n');
    if (mtime !== null) fs.utimesSync(file, mtime / 1000, mtime / 1000);
    written.push(file.replace(/\\/g, '/'));
  }
  return { generatedAt: replyTime, cmakeInputs: written };
}

const T0 = Date.now() - 60000;

check('an input edited after the configure is reported', () => {
  const model = staleModel(T0, [['CMakeLists.txt', T0 + 30000]]);
  assert.deepStrictEqual(
    fileApi.staleInputs(model).map((f) => path.basename(f)), ['CMakeLists.txt']);
});

check('an input older than the configure is not', () => {
  const model = staleModel(T0, [['old/CMakeLists.txt', T0 - 30000]]);
  assert.deepStrictEqual(fileApi.staleInputs(model), []);
});

check('only the edited one is named', () => {
  const model = staleModel(T0, [
    ['a/CMakeLists.txt', T0 - 30000],
    ['b/CMakeLists.txt', T0 + 30000],
    ['c/CMakeLists.txt', T0 - 30000]]);
  assert.deepStrictEqual(
    fileApi.staleInputs(model).map((f) => path.basename(path.dirname(f))), ['b']);
});

check('a deleted input is not treated as an edit', () => {
  // It cannot be read, so there is nothing to compare. Reporting it would send
  // the user to reconfigure over a file CMake may never have needed again.
  const model = { generatedAt: T0, cmakeInputs: [path.join(staleDir, 'gone.txt')] };
  assert.deepStrictEqual(fileApi.staleInputs(model), []);
});

check('a model from before this field existed reports nothing', () => {
  assert.deepStrictEqual(fileApi.staleInputs({ targets: new Map() }), []);
  assert.deepStrictEqual(fileApi.staleInputs(null), []);
});

check('the reply timestamp is read', () => {
  assert.ok(fileApi.loadModel(buildDir, '').generatedAt > 0, 'no reply timestamp recorded');
});

check('inputs are absolute and the build tree is left out', () => {
  // Everything under the build directory is written by the configure itself, so
  // its timestamps are always newer and would mark every project permanently
  // stale. Relative paths come out joined to the source root.
  //
  // The synthetic fixture writes no backtraceGraph, so it contributes no
  // inputs -- which is the same shape an old CMake produces, and is checked
  // just below. Run this file against a real build tree to exercise the rest.
  const model = fileApi.loadModel(buildDir, '');
  const build = model.buildDir.replace(/\\/g, '/').toLowerCase();
  for (const file of model.cmakeInputs) {
    assert.ok(path.isAbsolute(file), file + ' is not absolute');
    assert.ok(!file.toLowerCase().startsWith(build + '/'), file + ' is inside the build tree');
  }
});

check('the most recently configured build tree wins discovery', () => {
  // This repository holds two: the synthetic fixture and the real sample
  // project. Taking whichever the walk reached first meant answering from a
  // tree configured hours earlier -- and because the fixture names the sample
  // project as its source directory, the answers looked like they were about
  // the CMakeLists on screen. It reported "already links render_core" for a
  // line the user had just deleted, with no warning, because a fixture with no
  // backtraceGraph has nothing to check freshness against.
  const roots = [path.join(__dirname, '..')];
  const found = fileApi.findBuildDirs(roots).filter((d) => fileApi.hasReply(d));
  if (found.length < 2) return;
  const at = (dir) => fs.statSync(fileApi.findCodemodelFile(dir)).mtimeMs;
  const newest = found.slice().sort((a, b) => at(b) - at(a))[0];
  assert.strictEqual(fileApi.pickBuildDir(found), newest);
});

check('discovery still returns something when no tree has a reply', () => {
  assert.strictEqual(fileApi.pickBuildDir(['/no/such/build']), '/no/such/build');
  assert.strictEqual(fileApi.pickBuildDir([]), null);
  assert.strictEqual(fileApi.pickBuildDir(undefined), null);
});

check('the configure time comes from the newest reply file, not the codemodel', () => {
  // CMake names reply files after a hash of their content and leaves an
  // unchanged one alone, so the codemodel keeps an old mtime across a configure
  // that did not change it. Reading that timestamp reported a project as stale
  // straight after it had been reconfigured, and went on reporting it. Only the
  // index is rewritten every time. Seen on spdlog.
  const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
  const names = fs.readdirSync(replyDir);
  const newest = Math.max.apply(null, names.map(
    (n) => fs.statSync(path.join(replyDir, n)).mtimeMs));
  const model = fileApi.loadModel(buildDir, '');
  assert.strictEqual(Math.round(model.generatedAt), Math.round(newest),
    'generatedAt is not the newest file in ' + replyDir);
});

check('an input touched between the codemodel and the index is not stale', () => {
  // The window between CMake writing the codemodel and finishing the reply can
  // be tens of seconds on a large project. A save landing inside it is the case
  // that produced the false alarm.
  const codemodel = Date.now() - 60000;
  const model = staleModel(codemodel + 30000, [['mid/CMakeLists.txt', codemodel + 20000]]);
  assert.deepStrictEqual(fileApi.staleInputs(model), []);
});

check('re-saving a file without changing it is not an edit', () => {
  // Ctrl+S on a buffer nobody touched rewrites the same bytes and moves the
  // mtime. Warning about that turns the check into a nag; it is what happened
  // the first time this was tried on spdlog, right after a configure.
  const model = staleModel(T0, [['CMakeLists.txt', T0 + 30000]]);
  const before = fileApi.inputFingerprints({ cmakeInputs: model.cmakeInputs });
  assert.deepStrictEqual(fileApi.staleInputs(model, before), []);
});

check('a real edit is still reported when a baseline exists', () => {
  const model = staleModel(T0, [['CMakeLists.txt', T0 + 30000]]);
  const before = fileApi.inputFingerprints({ cmakeInputs: model.cmakeInputs });
  fs.writeFileSync(model.cmakeInputs[0], 'add_library(x x.cpp y.cpp)');
  fs.utimesSync(model.cmakeInputs[0], (T0 + 30000) / 1000, (T0 + 30000) / 1000);
  assert.deepStrictEqual(
    fileApi.staleInputs(model, before).map((f) => path.basename(f)), ['CMakeLists.txt']);
});

check('a file the baseline never saw is reported', () => {
  // No record is no evidence of sameness. A CMakeLists that appeared after the
  // baseline was taken has to count as an edit.
  const model = staleModel(T0, [['late/CMakeLists.txt', T0 + 30000]]);
  assert.deepStrictEqual(
    fileApi.staleInputs(model, new Map()).map((f) => path.basename(f)), ['CMakeLists.txt']);
});

check('with no baseline the check is timestamps alone', () => {
  const model = staleModel(T0, [['CMakeLists.txt', T0 + 30000]]);
  assert.strictEqual(fileApi.staleInputs(model, null).length, 1);
  assert.strictEqual(fileApi.staleInputs(model).length, 1);
});

check('fingerprints skip a file that cannot be read', () => {
  const hashes = fileApi.inputFingerprints({ cmakeInputs: [path.join(staleDir, 'nope.txt')] });
  assert.strictEqual(hashes.size, 0);
});

check('a fingerprint is not recomputed while the file looks the same', () => {
  // The check runs on a timer while the user types, and after anything that
  // touches every CMakeLists it was re-reading the whole set each time.
  const model = staleModel(T0, [['CMakeLists.txt', T0 + 30000]]);
  const file = model.cmakeInputs[0];
  const first = fileApi.inputFingerprints(model).get(file.toLowerCase());

  // Rewritten byte for byte with the timestamp put back: same size, same
  // mtime, so the cached hash stands.
  const bytes = fs.readFileSync(file);
  const was = fs.statSync(file);
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, was.atime, was.mtime);
  assert.strictEqual(fileApi.inputFingerprints(model).get(file.toLowerCase()), first);
});

check('a fingerprint follows a real change', () => {
  const model = staleModel(T0, [['CMakeLists.txt', T0 + 30000]]);
  const file = model.cmakeInputs[0];
  const first = fileApi.inputFingerprints(model).get(file.toLowerCase());
  fs.writeFileSync(file, 'add_library(x x.cpp y.cpp z.cpp)');
  assert.notStrictEqual(fileApi.inputFingerprints(model).get(file.toLowerCase()), first);
});

check('a reply with no backtraceGraph records no inputs and never goes stale', () => {
  // Nothing to compare is not the same as "up to date", but claiming staleness
  // with no evidence would nag on every command. Staying quiet matches how the
  // cycle check treats an old reply it cannot read link edges from.
  const model = fileApi.loadModel(buildDir, '');
  if (model.cmakeInputs.length) return;
  assert.deepStrictEqual(fileApi.staleInputs(model), []);
});


fs.rmSync(staleDir, { recursive: true, force: true });

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

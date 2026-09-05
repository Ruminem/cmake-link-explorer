'use strict';

// Checks the "#include this, what do I link?" path against the real CMake build
// tree that test/bootstrap.sh produces.

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const fileApi = require('../src/fileApi');
const resolver = require('../src/includeResolver');
const cmakeEdit = require('../src/cmakeEdit');

const project = path.join(__dirname, 'sample-project');
const build = path.join(project, 'build');

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

console.log('--- parsing include lines ---');

check('quoted, angled and spaced forms all parse', () => {
  assert.strictEqual(resolver.parseIncludeLine('#include "map_engine.h"'), 'map_engine.h');
  assert.strictEqual(resolver.parseIncludeLine('#include <absl/strings/str_cat.h>'),
                     'absl/strings/str_cat.h');
  assert.strictEqual(resolver.parseIncludeLine('  #  include   "a/b.hpp"  '), 'a/b.hpp');
});

check('anything that is not an include is rejected', () => {
  for (const line of ['int main() {}', '// #include "x.h"', '#define FOO 1', '', '#pragma once']) {
    assert.strictEqual(resolver.parseIncludeLine(line), null, JSON.stringify(line));
  }
});

if (!fileApi.isBuildDir(build)) {
  console.log('');
  console.log('(skipped the rest: run ./test/bootstrap.sh to create test/sample-project/build)');
  process.exit(failures === 0 ? 0 : 1);
}

const model = fileApi.loadModel(build, '');
const byName = new Map(Array.from(model.targets.values()).map((t) => [t.name, t]));
const file = (relative) => path.join(project, relative);
const resolve = (relative, include) =>
  resolver.resolve(model, file(relative), include, fileApi.isLinkable);

console.log('');
console.log('--- which target compiles this file ---');

check('a source file is matched to the target that lists it', () => {
  assert.strictEqual(resolver.targetOwningFile(model, file('app/navi_app.cpp')).name, 'navi_app');
  assert.strictEqual(resolver.targetOwningFile(model, file('libs/map_engine/map_engine.cpp')).name,
                     'map_engine');
  assert.strictEqual(resolver.targetOwningFile(model, file('tests/nds_test.cpp')).name, 'nds_test');
});

check('a header falls back to the target whose directory it sits in', () => {
  // Headers are not listed in this project's add_library calls.
  assert.strictEqual(resolver.targetOwningFile(model, file('libs/geo_utils/geo_utils.h')).name,
                     'geo_utils');
});

check('a file outside every target directory belongs to none', () => {
  assert.strictEqual(resolver.targetOwningFile(model, '/tmp/somewhere/else.cpp'), null);
});

console.log('');
console.log('--- which target provides this header ---');

check('the owning library is found for each header', () => {
  const provider = (header) => {
    const found = resolver.providersOfHeader(model, header, fileApi.isLinkable);
    return found.length ? found[0].target.name : null;
  };
  assert.strictEqual(provider('map_engine.h'), 'map_engine');
  assert.strictEqual(provider('geo_utils.h'), 'geo_utils');
  assert.strictEqual(provider('sqlite_wrap.h'), 'sqlite_wrap');
  assert.strictEqual(provider('dlt_wrapper.h'), 'dlt_wrapper');
});

check('a header nothing provides comes back empty', () => {
  assert.deepStrictEqual(resolver.providersOfHeader(model, 'no_such_header.h', fileApi.isLinkable), []);
});

check('UTILITY targets are never offered as providers', () => {
  for (const header of ['map_engine.h', 'geo_utils.h']) {
    for (const row of resolver.providersOfHeader(model, header, fileApi.isLinkable)) {
      assert.ok(fileApi.isLinkable(row.target), row.target.name + ' is not linkable');
    }
  }
});

console.log('');
console.log('--- what needs to change ---');

check('an include that already works says so', () => {
  const result = resolve('app/navi_app.cpp', 'map_engine.h');
  assert.strictEqual(result.status, 'already-linked');
  assert.strictEqual(result.from.name, 'navi_app');
  assert.strictEqual(result.provider.name, 'map_engine');
});

check('a header from the same target needs nothing', () => {
  const result = resolve('libs/map_engine/map_engine.cpp', 'map_engine.h');
  assert.strictEqual(result.status, 'same-target');
});

check('an include that only works transitively is flagged', () => {
  // navi_app links map_engine, which links geo_utils; navi_app never says so.
  const result = resolve('app/navi_app.cpp', 'geo_utils.h');
  assert.strictEqual(result.status, 'transitive');
  assert.strictEqual(result.provider.name, 'geo_utils');
});

check('an include that would not compile produces the exact line to add', () => {
  const result = resolve('tests/nds_test.cpp', 'dlt_wrapper.h');
  assert.strictEqual(result.status, 'needs-link');
  assert.strictEqual(result.suggestion,
                     'target_link_libraries(nds_test PRIVATE dlt_wrapper)');
});

check('an unknown header is reported rather than guessed at', () => {
  assert.strictEqual(resolve('app/navi_app.cpp', 'nope.h').status, 'not-found');
});

check('a file outside the project is reported as such', () => {
  assert.strictEqual(
    resolver.resolve(model, '/tmp/loose.cpp', 'map_engine.h', fileApi.isLinkable).status,
    'unknown-target');
});

console.log('');
console.log('--- PUBLIC, PRIVATE or INTERFACE ---');

check('an include in a .cpp is PRIVATE', () => {
  const result = resolve('tests/nds_test.cpp', 'dlt_wrapper.h');
  assert.strictEqual(result.keyword, 'PRIVATE');
  assert.ok(/ PRIVATE dlt_wrapper\)$/.test(result.suggestion), result.suggestion);
});

check('the same include from a header is PUBLIC', () => {
  // The header becomes part of map_engine's interface, so consumers need the
  // dependency too; PRIVATE would compile here and break them.
  const result = resolve('libs/map_engine/map_engine.h', 'dlt_wrapper.h');
  assert.strictEqual(result.from.name, 'map_engine');
  assert.strictEqual(result.keyword, 'PUBLIC');
  assert.strictEqual(result.suggestion,
                     'target_link_libraries(map_engine PUBLIC dlt_wrapper)');
});

check('every header extension counts, not just .h', () => {
  const target = byName.get('map_engine');
  for (const file of ['a.h', 'a.hpp', 'a.hh', 'a.hxx', 'a.inl']) {
    assert.strictEqual(resolver.scopeFor(target, file), 'PUBLIC', file);
  }
  for (const file of ['a.cpp', 'a.cc', 'a.c', 'a.cxx']) {
    assert.strictEqual(resolver.scopeFor(target, file), 'PRIVATE', file);
  }
});

check('an INTERFACE library can only use INTERFACE', () => {
  assert.strictEqual(
    resolver.scopeFor({ type: 'INTERFACE_LIBRARY' }, 'a.cpp'), 'INTERFACE');
  assert.strictEqual(
    resolver.scopeFor({ type: 'INTERFACE_LIBRARY' }, 'a.h'), 'INTERFACE');
});

check('a transitive result also carries the right keyword', () => {
  assert.strictEqual(resolve('app/navi_app.cpp', 'geo_utils.h').keyword, 'PRIVATE');
});

console.log('');
console.log('--- editing CMakeLists.txt ---');

const apply = (plan) => {
  const text = fs.readFileSync(plan.file, 'utf8');
  return text.slice(0, plan.offset) + plan.insert + text.slice(plan.offset);
};

check('an existing target_link_libraries call is extended in place', () => {
  const plan = cmakeEdit.planLinkEdit(model, byName.get('nds_test'), 'dlt_wrapper');
  assert.strictEqual(plan.kind, 'append');
  assert.ok(plan.file.endsWith(path.join('tests', 'CMakeLists.txt')), plan.file);
  assert.ok(/target_link_libraries\(nds_test PRIVATE nds_reader dlt_wrapper\)/.test(apply(plan)),
            apply(plan));
});

check('the other target in the same file is left alone', () => {
  const plan = cmakeEdit.planLinkEdit(model, byName.get('nds_test'), 'dlt_wrapper');
  assert.ok(/target_link_libraries\(map_test PRIVATE map_engine\)/.test(apply(plan)),
            'map_test was disturbed');
});

check('a target with no link call gets a new one after its declaration', () => {
  const plan = cmakeEdit.planLinkEdit(model, byName.get('geo_utils'), 'sqlite_wrap');
  assert.strictEqual(plan.kind, 'create');
  const text = apply(plan);
  const declaration = text.indexOf('add_library(geo_utils');
  const added = text.indexOf('target_link_libraries(geo_utils PRIVATE sqlite_wrap)');
  assert.ok(added > declaration, 'the new call must come after the declaration');
});

check('the scope keyword can be chosen', () => {
  const plan = cmakeEdit.planLinkEdit(model, byName.get('geo_utils'), 'sqlite_wrap', 'PUBLIC');
  assert.ok(/target_link_libraries\(geo_utils PUBLIC sqlite_wrap\)/.test(plan.insert), plan.insert);
});

check('the reported position matches where the text is inserted', () => {
  for (const [target, library] of [['nds_test', 'dlt_wrapper'], ['geo_utils', 'sqlite_wrap']]) {
    const plan = cmakeEdit.planLinkEdit(model, byName.get(target), library);
    const text = fs.readFileSync(plan.file, 'utf8');
    const lines = text.slice(0, plan.offset).split('\n');
    assert.strictEqual(plan.position.line, lines.length - 1, target);
    assert.strictEqual(plan.position.character, lines[lines.length - 1].length, target);
  }
});

console.log('');
console.log('--- CMake command parsing ---');

check('a multi-line call is matched whole', () => {
  const text = 'target_link_libraries(app\n    PRIVATE\n    foo\n    bar\n)\n';
  const found = cmakeEdit.findCommand(text, ['target_link_libraries'], 'app');
  assert.ok(found);
  assert.strictEqual(text[found.close], ')');
  assert.ok(/foo/.test(found.args) && /bar/.test(found.args));
});

check('a commented-out call is ignored', () => {
  const text = '# target_link_libraries(app PRIVATE ghost)\ntarget_link_libraries(app PRIVATE real)\n';
  const found = cmakeEdit.findCommand(text, ['target_link_libraries'], 'app');
  assert.ok(found);
  assert.ok(/real/.test(found.args) && !/ghost/.test(found.args), found.args);
});

check('a call for a different target is not matched', () => {
  const text = 'target_link_libraries(other PRIVATE foo)\n';
  assert.strictEqual(cmakeEdit.findCommand(text, ['target_link_libraries'], 'app'), null);
});

check('nested parentheses do not confuse the matcher', () => {
  const text = 'target_link_libraries(app PRIVATE $<$<BOOL:${X}>:foo> bar)\nmessage(done)\n';
  const found = cmakeEdit.findCommand(text, ['target_link_libraries'], 'app');
  assert.ok(found);
  assert.strictEqual(found.args, 'app PRIVATE $<$<BOOL:${X}>:foo> bar');
});

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

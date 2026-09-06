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
  assert.strictEqual(resolver.parseIncludeLine('#include "engine.h"'), 'engine.h');
  assert.strictEqual(resolver.parseIncludeLine('#include <absl/strings/str_cat.h>'),
                     'absl/strings/str_cat.h');
  assert.strictEqual(resolver.parseIncludeLine('  #  include   "a/b.hpp"  '), 'a/b.hpp');
});

check('anything that is not an include is rejected', () => {
  for (const line of ['int main() {}', '// #include "x.h"', '#define FOO 1', '', '#pragma once']) {
    assert.strictEqual(resolver.parseIncludeLine(line), null, JSON.stringify(line));
  }
});

console.log('');
console.log('--- the edit keeps the line endings the file already had ---');

// CMakeLists.txt on Windows is usually CRLF, and this extension is used on
// Windows. Writing a bare \n into one leaves a single mixed line that shows up
// in every diff. These need no build tree, so they run everywhere.
{
  const scratch = fs.mkdtempSync(path.join(require('os').tmpdir(), 'clx-eol-'));
  const plan = (content) => {
    fs.writeFileSync(path.join(scratch, 'CMakeLists.txt'), content);
    const edit = cmakeEdit.planLinkEdit({ sourceDir: scratch }, { name: 'foo', sourceDir: '' },
                                        'newlib', 'PRIVATE');
    return { edit, after: content.slice(0, edit.offset) + edit.insert + content.slice(edit.offset) };
  };
  const lonelyNewline = (text) => /(^|[^\r])\n/.test(text);

  check('appending to a CRLF file stays CRLF', () => {
    const { edit, after } = plan('add_library(foo foo.cpp)\r\ntarget_link_libraries(foo\r\n    bar\r\n)\r\n');
    assert.strictEqual(edit.kind, 'append');
    assert.ok(!lonelyNewline(after), JSON.stringify(after));
    assert.ok(after.indexOf('    bar\r\n    newlib') !== -1, JSON.stringify(after));
  });

  check('creating a call in a CRLF file stays CRLF', () => {
    const { edit, after } = plan('add_library(foo foo.cpp)\r\n');
    assert.strictEqual(edit.kind, 'create');
    assert.ok(!lonelyNewline(after), JSON.stringify(after));
  });

  check('an LF file is left as LF', () => {
    const appended = plan('add_library(foo foo.cpp)\ntarget_link_libraries(foo\n    bar\n)\n');
    assert.ok(appended.after.indexOf('\r') === -1, JSON.stringify(appended.after));
    const created = plan('add_library(foo foo.cpp)\n');
    assert.ok(created.after.indexOf('\r') === -1, JSON.stringify(created.after));
  });

  check('a single-line call is still extended in place', () => {
    const { after } = plan('add_library(foo foo.cpp)\r\ntarget_link_libraries(foo bar)\r\n');
    assert.ok(after.indexOf('target_link_libraries(foo bar newlib)') !== -1, JSON.stringify(after));
    assert.ok(!lonelyNewline(after), JSON.stringify(after));
  });

  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('--- what a file is compiled with ---');

// CMake attaches compile settings to a group and says which of the target's
// sources belong to it. The model is spelled out here so these run without a
// build tree; the shape matches what fileApi.loadModel produces.
{
  const group = (over) => Object.assign(
    { language: 'CXX', standard: null, defines: [], includes: [], sourceIndexes: [] }, over);
  const model = {
    sourceDir: '/proj',
    targets: new Map([
      ['board', {
        id: 'board', name: 'board', type: 'STATIC_LIBRARY', sourceDir: 'board',
        sources: ['board/board.cpp', 'board/board.h'],
        compileGroups: [group({
          standard: '17',
          // BOARD_REV is this target's own; the other two came through hal's
          // PUBLIC settings, which is the part you cannot read off a CMakeLists.
          defines: ['BOARD_REV=3', 'STM32F407xx', 'USE_HAL_DRIVER'],
          includes: [{ path: '/proj/board/inc', isSystem: false },
                     { path: '/opt/sdk', isSystem: true }],
          sourceIndexes: [0]
        })]
      }],
      ['mixed', {
        id: 'mixed', name: 'mixed', type: 'STATIC_LIBRARY', sourceDir: 'mixed',
        sources: ['mixed/a.c', 'mixed/b.cpp', 'mixed/shared.h'],
        compileGroups: [
          group({ language: 'C', defines: ['C_ONLY'], sourceIndexes: [0] }),
          group({ language: 'CXX', defines: ['CXX_ONLY'], sourceIndexes: [1] })
        ]
      }]
    ])
  };

  check('a compiled source reports its own group', () => {
    const found = resolver.compileSettingsForFile(model, '/proj/board/board.cpp');
    assert.strictEqual(found.target.name, 'board');
    assert.strictEqual(found.exact, true);
    assert.deepStrictEqual(found.group.defines, ['BOARD_REV=3', 'STM32F407xx', 'USE_HAL_DRIVER']);
    assert.strictEqual(found.group.standard, '17');
  });

  check('system include directories are marked as such', () => {
    const { group } = resolver.compileSettingsForFile(model, '/proj/board/board.cpp');
    assert.deepStrictEqual(group.includes.map((i) => i.isSystem), [false, true]);
  });

  check('a header falls back to the target, flagged as inferred', () => {
    // Headers are compiled by nobody, so they sit in no group at all.
    const found = resolver.compileSettingsForFile(model, '/proj/board/board.h');
    assert.strictEqual(found.target.name, 'board');
    assert.strictEqual(found.exact, false);
    assert.deepStrictEqual(found.group.defines, ['BOARD_REV=3', 'STM32F407xx', 'USE_HAL_DRIVER']);
  });

  check('a header in a two-language target is not guessed at', () => {
    // C and C++ disagree here, so picking one would be inventing an answer.
    const found = resolver.compileSettingsForFile(model, '/proj/mixed/shared.h');
    assert.strictEqual(found.target.name, 'mixed');
    assert.strictEqual(found.exact, false);
    assert.strictEqual(found.group, null);
  });

  check('each language in a target keeps its own settings', () => {
    assert.deepStrictEqual(
      resolver.compileSettingsForFile(model, '/proj/mixed/a.c').group.defines, ['C_ONLY']);
    assert.deepStrictEqual(
      resolver.compileSettingsForFile(model, '/proj/mixed/b.cpp').group.defines, ['CXX_ONLY']);
  });

  check('a file no target compiles reports nothing', () => {
    assert.strictEqual(resolver.compileSettingsForFile(model, '/elsewhere/x.cpp'), null);
  });
}

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
  assert.strictEqual(resolver.targetOwningFile(model, file('app/sample_app.cpp')).name, 'sample_app');
  assert.strictEqual(resolver.targetOwningFile(model, file('libs/engine/engine.cpp')).name,
                     'engine');
  assert.strictEqual(resolver.targetOwningFile(model, file('tests/store_test.cpp')).name, 'store_test');
});

check('a header falls back to the target whose directory it sits in', () => {
  // Headers are not listed in this project's add_library calls.
  assert.strictEqual(resolver.targetOwningFile(model, file('libs/math_utils/math_utils.h')).name,
                     'math_utils');
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
  assert.strictEqual(provider('engine.h'), 'engine');
  assert.strictEqual(provider('math_utils.h'), 'math_utils');
  assert.strictEqual(provider('db_wrap.h'), 'db_wrap');
  assert.strictEqual(provider('log_wrapper.h'), 'log_wrapper');
});

check('a header nothing provides comes back empty', () => {
  assert.deepStrictEqual(resolver.providersOfHeader(model, 'no_such_header.h', fileApi.isLinkable), []);
});

check('UTILITY targets are never offered as providers', () => {
  for (const header of ['engine.h', 'math_utils.h']) {
    for (const row of resolver.providersOfHeader(model, header, fileApi.isLinkable)) {
      assert.ok(fileApi.isLinkable(row.target), row.target.name + ' is not linkable');
    }
  }
});

check('a header created after the index was built is still found', () => {
  const fresh = fileApi.loadModel(build, '');
  resolver.providersOfHeader(fresh, 'engine.h', fileApi.isLinkable); // builds the index
  const added = path.join(project, 'libs', 'engine', 'generated_by_test.h');
  fs.writeFileSync(added, '#pragma once\n');
  try {
    // The index is rebuilt on a miss once it is old enough; force that here
    // rather than making the test wait.
    const index = resolver.__headerIndexForTests(fresh);
    index.builtAt = 0;
    const found = resolver.providersOfHeader(fresh, 'generated_by_test.h', fileApi.isLinkable);
    assert.ok(found.length, 'a newly written header was not picked up');
    assert.strictEqual(found[0].target.name, 'engine');
  } finally {
    fs.unlinkSync(added);
  }
});

check('paths are matched however the editor cased them', () => {
  // VS Code does not always hand back the casing CMake recorded, and Windows and
  // macOS do not care about the difference.
  const upper = path.join(project.toUpperCase(), 'app', 'sample_app.cpp');
  const owner = resolver.targetOwningFile(model, upper);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.ok(owner, 'case-insensitive filesystem should still match');
    assert.strictEqual(owner.name, 'sample_app');
  } else {
    assert.strictEqual(owner, null, 'a case-sensitive filesystem must not match');
  }
});

console.log('');
console.log('--- what needs to change ---');

check('an include that already works says so', () => {
  const result = resolve('app/sample_app.cpp', 'engine.h');
  assert.strictEqual(result.status, 'already-linked');
  assert.strictEqual(result.from.name, 'sample_app');
  assert.strictEqual(result.provider.name, 'engine');
});

check('a header from the same target needs nothing', () => {
  const result = resolve('libs/engine/engine.cpp', 'engine.h');
  assert.strictEqual(result.status, 'same-target');
});

check('an include that only works transitively is flagged', () => {
  // sample_app links engine, which links math_utils; sample_app never says so.
  const result = resolve('app/sample_app.cpp', 'math_utils.h');
  assert.strictEqual(result.status, 'transitive');
  assert.strictEqual(result.provider.name, 'math_utils');
});

check('an include that would not compile produces the exact line to add', () => {
  const result = resolve('tests/store_test.cpp', 'log_wrapper.h');
  assert.strictEqual(result.status, 'needs-link');
  assert.strictEqual(result.suggestion,
                     'target_link_libraries(store_test PRIVATE log_wrapper)');
});

check('an unknown header is reported rather than guessed at', () => {
  assert.strictEqual(resolve('app/sample_app.cpp', 'nope.h').status, 'not-found');
});

check('a file outside the project is reported as such', () => {
  assert.strictEqual(
    resolver.resolve(model, '/tmp/loose.cpp', 'engine.h', fileApi.isLinkable).status,
    'unknown-target');
});

console.log('');
console.log('--- PUBLIC, PRIVATE or INTERFACE ---');

check('an include in a .cpp is PRIVATE', () => {
  const result = resolve('tests/store_test.cpp', 'log_wrapper.h');
  assert.strictEqual(result.keyword, 'PRIVATE');
  assert.ok(/ PRIVATE log_wrapper\)$/.test(result.suggestion), result.suggestion);
});

check('the same include from a header is PUBLIC', () => {
  // The header becomes part of engine's interface, so consumers need the
  // dependency too; PRIVATE would compile here and break them.
  const result = resolve('libs/engine/engine.h', 'log_wrapper.h');
  assert.strictEqual(result.from.name, 'engine');
  assert.strictEqual(result.keyword, 'PUBLIC');
  assert.strictEqual(result.suggestion,
                     'target_link_libraries(engine PUBLIC log_wrapper)');
});

check('every header extension counts, not just .h', () => {
  const target = byName.get('engine');
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
  assert.strictEqual(resolve('app/sample_app.cpp', 'math_utils.h').keyword, 'PRIVATE');
});

console.log('');
console.log('--- editing CMakeLists.txt ---');

const apply = (plan) => {
  const text = fs.readFileSync(plan.file, 'utf8');
  return text.slice(0, plan.offset) + plan.insert + text.slice(plan.offset);
};

check('an existing target_link_libraries call is extended in place', () => {
  const plan = cmakeEdit.planLinkEdit(model, byName.get('store_test'), 'log_wrapper');
  assert.strictEqual(plan.kind, 'append');
  assert.ok(plan.file.endsWith(path.join('tests', 'CMakeLists.txt')), plan.file);
  assert.ok(/target_link_libraries\(store_test PRIVATE store_reader log_wrapper\)/.test(apply(plan)),
            apply(plan));
});

check('the other target in the same file is left alone', () => {
  const plan = cmakeEdit.planLinkEdit(model, byName.get('store_test'), 'log_wrapper');
  assert.ok(/target_link_libraries\(engine_test PRIVATE engine\)/.test(apply(plan)),
            'engine_test was disturbed');
});

check('a target with no link call gets a new one after its declaration', () => {
  const plan = cmakeEdit.planLinkEdit(model, byName.get('math_utils'), 'db_wrap');
  assert.strictEqual(plan.kind, 'create');
  const text = apply(plan);
  const declaration = text.indexOf('add_library(math_utils');
  const added = text.indexOf('target_link_libraries(math_utils PRIVATE db_wrap)');
  assert.ok(added > declaration, 'the new call must come after the declaration');
});

check('the scope keyword can be chosen', () => {
  const plan = cmakeEdit.planLinkEdit(model, byName.get('math_utils'), 'db_wrap', 'PUBLIC');
  assert.ok(/target_link_libraries\(math_utils PUBLIC db_wrap\)/.test(plan.insert), plan.insert);
});

check('the reported position matches where the text is inserted', () => {
  for (const [target, library] of [['store_test', 'log_wrapper'], ['math_utils', 'db_wrap']]) {
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
console.log('--- an edit that would be wrong is not made ---');

// One scratch CMakeLists per case, planned against it, and the plan applied so
// what the user would end up with is what gets asserted -- not just the shape
// of the plan object.
const editDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'clx-edit-'));
let editCase = 0;

function planFor(body, scope) {
  const dir = path.join(editDir, 'c' + (editCase++));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'CMakeLists.txt'), body);
  const plan = cmakeEdit.planLinkEdit(
    { sourceDir: dir, targets: new Map() }, { name: 'app', sourceDir: '' }, 'newlib', scope);
  plan.result = plan.offset === undefined ? null : (() => {
    const text = fs.readFileSync(path.join(dir, 'CMakeLists.txt'), 'utf8');
    return text.slice(0, plan.offset) + plan.insert + text.slice(plan.offset);
  })();
  return plan;
}

check('a call inside if() is not extended', () => {
  // It would link the library only on the platform the guard names, and the
  // preview showed nothing of it. Found by reading; reproduced before fixing.
  const plan = planFor(
    'add_executable(app app.cpp)\n\n' +
    'if(WIN32)\n    target_link_libraries(app PRIVATE ws2_32)\nendif()\n\n' +
    'target_link_libraries(app PUBLIC core)\n', 'PRIVATE');
  assert.strictEqual(plan.kind, 'create');
  assert.ok(/if\(WIN32\)\s*\n\s*target_link_libraries\(app PRIVATE ws2_32\)/.test(plan.result),
    'the guarded call was modified:\n' + plan.result);
  assert.ok(plan.insteadOfAppending && /if\(\)/.test(plan.insteadOfAppending),
    'no reason given: ' + plan.insteadOfAppending);
});

check('a call ending in a different scope is not extended', () => {
  // Appending after INTERFACE gives the target something it does not link, so
  // the suggested fix would not have fixed anything.
  const plan = planFor(
    'add_executable(app app.cpp)\n' +
    'target_link_libraries(app PUBLIC core INTERFACE headers_only)\n', 'PRIVATE');
  assert.strictEqual(plan.kind, 'create');
  assert.ok(/target_link_libraries\(app PRIVATE newlib\)/.test(plan.result), plan.result);
  assert.ok(/INTERFACE headers_only\)/.test(plan.result), 'the existing call was edited');
});

check('a call ending in the wanted scope is extended', () => {
  const plan = planFor(
    'add_executable(app app.cpp)\n' +
    'target_link_libraries(app PUBLIC core PRIVATE thing)\n', 'PRIVATE');
  assert.strictEqual(plan.kind, 'append');
  assert.ok(/PRIVATE thing newlib\)/.test(plan.result), plan.result);
});

check('the preview names the section the library lands in', () => {
  const plan = planFor(
    'add_executable(app app.cpp)\ntarget_link_libraries(app PRIVATE core)\n', 'PRIVATE');
  assert.ok(/PRIVATE/.test(plan.preview), plan.preview);
});

check('the plain signature is never mixed with a keyword one', () => {
  // CMake refuses outright, so a second call cannot be the answer here.
  const plan = planFor(
    'add_executable(app app.cpp)\n\n' +
    'if(WIN32)\n    target_link_libraries(app ws2_32)\nendif()\n', 'PRIVATE');
  assert.strictEqual(plan.kind, 'manual');
  assert.ok(/plain signature/.test(plan.reason), plan.reason);
});

check('a target declared inside if() gets no generated call', () => {
  const plan = planFor('if(BUILD_APP)\n    add_executable(app app.cpp)\nendif()\n', 'PRIVATE');
  assert.strictEqual(plan.kind, 'manual');
  assert.ok(/if\(\)/.test(plan.reason), plan.reason);
});

check('a lone quote in a comment does not blind the parser', () => {
  // quoteIndex counted quotes inside comments, so one unbalanced one made every
  // position after it read as "inside a string" and no command could be found.
  const plan = planFor(
    '# a 24" monitor is assumed here\n' +
    'add_executable(app app.cpp)\ntarget_link_libraries(app PRIVATE core)\n', 'PRIVATE');
  assert.strictEqual(plan.kind, 'append');
  assert.ok(/PRIVATE core newlib\)/.test(plan.result), plan.result);
});

check('the file comes from where CMake says the target was declared', () => {
  // Not from sourceDir/CMakeLists.txt, which is a different file whenever the
  // target is created inside an include()d .cmake.
  const dir = path.join(editDir, 'declared');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'targets.cmake'),
    'add_executable(app app.cpp)\ntarget_link_libraries(app PRIVATE core)\n');
  const plan = cmakeEdit.planLinkEdit(
    { sourceDir: dir, targets: new Map() },
    { name: 'app', sourceDir: 'sub', declaration: { file: 'sub/targets.cmake', line: 1 } },
    'newlib', 'PRIVATE');
  assert.ok(plan.file.endsWith('targets.cmake'), plan.file);
  assert.strictEqual(plan.kind, 'append');
});

fs.rmSync(editDir, { recursive: true, force: true });

console.log('');
console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);

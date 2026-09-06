'use strict';

// Runs inside a real VS Code extension host:
//   code --extensionDevelopmentPath=<repo> --extensionTestsPath=<this dir> <workspace>
//
// Unlike the jsc harness, nothing here is shimmed: this is the real vscode API,
// the real activation path and a real CMake build tree.

const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const EXTENSION_ID = 'Ruminem.cmake-link-explorer';

// The extension host does not forward console output to the launching shell, so
// results also go to a file the caller can read back.
const LOG_FILE = process.env.CMAKE_LINK_TEST_LOG || '';
const captured = [];

const results = [];

// The status bar refresh is debounced so a keystroke does not stat every
// CMakeLists in the project. Wait past that window before reading it.
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

async function check(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, error: (e && e.message) || String(e) });
  }
}

function log(line) {
  console.log(line);
  captured.push(line);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (e) {
      // Losing the log file must not fail the run.
    }
  }
}

async function run() {
  try {
    await runChecks();
  } catch (e) {
    log('ERROR: ' + ((e && e.stack) || e));
    throw e;
  }
}

async function runChecks() {
  log('');
  log('=== CMake Link Explorer :: integration ===');
  log('vscode ' + vscode.version);

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, 'extension ' + EXTENSION_ID + ' was not found by VS Code');

  const api = await extension.activate();
  assert.ok(api && api.reload, 'activate() did not return the test API');

  // Activation kicks off an async reload; wait for a deterministic one.
  await api.reload();

  const model = api.getModel();
  const provider = api.getProvider();
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;

  await check('the extension activates', () => {
    assert.strictEqual(extension.isActive, true);
  });

  await check('every contributed command is registered', async () => {
    const registered = await vscode.commands.getCommands(true);
    const contributed = extension.packageJSON.contributes.commands.map((c) => c.command);
    const missing = contributed.filter((c) => registered.indexOf(c) === -1);
    assert.deepStrictEqual(missing, [], 'not registered: ' + missing.join(', '));
  });

  await check('the build directory is auto-detected in the workspace', () => {
    const buildDir = api.getBuildDirectory();
    assert.ok(buildDir, 'no build directory was found');
    assert.ok(buildDir.indexOf('sample-project') !== -1, 'unexpected build directory: ' + buildDir);
  });

  await check('CMake File API produced a usable model', () => {
    assert.ok(model, 'no model was loaded');
    assert.ok(model.targets.size > 0, 'model has no targets');
  });

  const byName = new Map(Array.from(model.targets.values()).map((t) => [t.name, t]));
  const nameOf = (id) => model.targets.get(id).name;
  const namesOf = (ids) => ids.map(nameOf).sort();

  log('');
  log('--- targets reported by real CMake ---');
  for (const target of Array.from(model.targets.values()).sort((a, b) => a.name.localeCompare(b.name))) {
    const links = namesOf(target.directDependencyIds);
    const extra = namesOf(target.dependencyIds).filter((n) => links.indexOf(n) === -1);
    const linkedBy = namesOf(model.linkedBy.get(target.id));
    log('  ' + target.name + '  [' + target.type + ']');
    if (links.length) {
      log('      links     -> ' + links.join(', ') +
          (extra.length ? '     (+transitive: ' + extra.join(', ') + ')' : ''));
    }
    if (linkedBy.length) log('      linked by <- ' + linkedBy.join(', '));
    if (target.externalLibraries.length) log('      external  :: ' + target.externalLibraries.join(', '));
  }
  log('');

  await check('all sample-project targets are present', () => {
    const expected = ['db_wrap', 'engine', 'engine_test', 'log_wrapper', 'math_utils',
                        'render_core', 'sample_app', 'store_reader', 'store_test'];
    const actual = Array.from(byName.keys()).filter((n) => expected.indexOf(n) !== -1).sort();
    assert.deepStrictEqual(actual, expected);
  });

  await check('direct dependencies match what the CMakeLists declares', () => {
    // app/CMakeLists.txt: target_link_libraries(sample_app PRIVATE engine render_core log_wrapper)
    assert.deepStrictEqual(namesOf(byName.get('sample_app').directDependencyIds),
                           ['engine', 'log_wrapper', 'render_core']);
    // libs/engine/CMakeLists.txt: target_link_libraries(engine PUBLIC store_reader math_utils)
    assert.deepStrictEqual(namesOf(byName.get('engine').directDependencyIds),
                           ['math_utils', 'store_reader']);
  });

  await check('CMake reports the transitive closure that the view reduces away', () => {
    assert.deepStrictEqual(namesOf(byName.get('sample_app').dependencyIds),
                           ['db_wrap', 'engine', 'log_wrapper', 'math_utils', 'render_core', 'store_reader']);
  });

  await check('the tree shows only the direct dependencies', () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'sample_app');
    const shown = provider.getChildren(node)
      .filter((n) => n.direction === 'forward')
      .map((n) => model.targets.get(n.id).name).sort();
    assert.deepStrictEqual(shown, ['engine', 'log_wrapper', 'render_core']);
  });

  await check('the path trace walks one hop at a time', () => {
    const fileApi = require('../../src/fileApi');
    const ids = fileApi.findLinkPath(model, byName.get('sample_app').id, byName.get('db_wrap').id);
    assert.deepStrictEqual(ids.map(nameOf),
                           ['sample_app', 'engine', 'store_reader', 'db_wrap']);
  });

  await check('reverse dependencies are derived correctly', () => {
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('math_utils').id)),
                           ['engine', 'render_core']);
  });

  await check('transitive PUBLIC linkage is visible', () => {
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('store_reader').id)),
                           ['engine', 'store_test']);
  });

  await check('no project-built library is reported as external', () => {
    const artifacts = new Set(
      Array.from(model.targets.values()).map((t) => t.nameOnDisk).filter(Boolean)
    );
    for (const target of model.targets.values()) {
      for (const lib of target.externalLibraries) {
        assert.ok(!artifacts.has(path.basename(lib)),
                  target.name + ' lists project artifact ' + lib + ' as external');
      }
    }
  });

  await check('no linker flag leaks into the external library list', () => {
    for (const target of model.targets.values()) {
      for (const lib of target.externalLibraries) {
        assert.ok(lib.indexOf('-Wl,') === -1, target.name + ' external contains a flag: ' + lib);
      }
    }
  });

  await check('the tree renders root targets', () => {
    const roots = provider.getChildren();
    assert.ok(roots.length > 0, 'tree produced no root nodes');
    const names = roots.map((n) => model.targets.get(n.id).name);
    assert.ok(names.indexOf('sample_app') !== -1, 'sample_app missing from tree roots');
    assert.ok(names.indexOf('generate_docs') === -1, 'UTILITY target leaked into the tree');
  });

  await check('a real TreeItem is produced for a target', () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'math_utils');
    const item = provider.getTreeItem(node);
    assert.strictEqual(item.label, 'math_utils');
    assert.strictEqual(item.description, '←2');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.ok(item.iconPath instanceof vscode.ThemeIcon, 'icon is not a ThemeIcon');

    // Tooltips are built on demand, which is what VS Code's resolveTreeItem is
    // for; drawing the list must not pay for markdown on every row.
    assert.strictEqual(item.tooltip, undefined);
    const resolved = provider.resolveTreeItem(item, node);
    assert.ok(resolved.tooltip instanceof vscode.MarkdownString, 'tooltip is not a MarkdownString');
    assert.ok(/linked by ← 2/.test(resolved.tooltip.value), resolved.tooltip.value);
  });

  await check('both directions are counted on the row itself', () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'engine');
    assert.strictEqual(provider.getTreeItem(node).description, '→2 ←2');

    const children = provider.getChildren(node);
    assert.deepStrictEqual(
      children.map((c) => c.direction + ':' + model.targets.get(c.id).name),
      ['forward:math_utils', 'forward:store_reader', 'reverse:engine_test', 'reverse:sample_app']);
  });

  await check('executables sort ahead of the libraries everything leans on', () => {
    const names = provider.getChildren().map((n) => model.targets.get(n.id).name);
    assert.deepStrictEqual(names.slice(0, 3), ['engine_test', 'sample_app', 'store_test']);
    assert.ok(names.indexOf('math_utils') < names.indexOf('log_wrapper'),
              'math_utils has more dependents and should sort higher');
  });

  await check('direction arrows are real coloured ThemeIcons', () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'engine');
    const children = provider.getChildren(node);
    const forward = provider.getTreeItem(children[0]);
    const reverse = provider.getTreeItem(children.find((c) => c.direction === 'reverse'));
    assert.ok(forward.iconPath instanceof vscode.ThemeIcon);
    assert.ok(forward.iconPath.color instanceof vscode.ThemeColor);
    assert.strictEqual(forward.iconPath.id, 'arrow-small-right');
    assert.strictEqual(reverse.iconPath.id, 'arrow-small-left');
  });

  await check('openCMakeLists jumps to the add_library line', async () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'engine');
    await vscode.commands.executeCommand('cmakeLinkExplorer.openCMakeLists', node);

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'no editor was opened');
    assert.ok(editor.document.fileName.endsWith(path.join('engine', 'CMakeLists.txt')),
              'opened the wrong file: ' + editor.document.fileName);
    const line = editor.document.lineAt(editor.selection.active.line).text;
    assert.ok(/add_library\s*\(\s*engine\b/.test(line),
              'cursor landed on: ' + JSON.stringify(line));
  });

  await check('the refresh command runs without throwing', async () => {
    await vscode.commands.executeCommand('cmakeLinkExplorer.refresh');
    assert.ok(api.getModel(), 'model was lost after refresh');
  });

  await check('copyName puts the target name on the clipboard', async () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'db_wrap');
    await vscode.commands.executeCommand('cmakeLinkExplorer.copyName', node);
    assert.strictEqual(await vscode.env.clipboard.readText(), 'db_wrap');
  });

  // ------------------------------------------------- include -> link resolving

  await check('an include that already works is reported as linked', () => {
    const result = api.resolveInclude(
      path.join(workspace, 'app', 'sample_app.cpp'), 'engine.h');
    assert.strictEqual(result.status, 'already-linked');
    assert.strictEqual(result.provider.name, 'engine');
  });

  await check('an include that only works transitively is flagged', () => {
    const result = api.resolveInclude(
      path.join(workspace, 'app', 'sample_app.cpp'), 'math_utils.h');
    assert.strictEqual(result.status, 'transitive');
  });

  await check('a missing link produces the exact CMake line', () => {
    const result = api.resolveInclude(
      path.join(workspace, 'tests', 'store_test.cpp'), 'log_wrapper.h');
    assert.strictEqual(result.status, 'needs-link');
    assert.strictEqual(result.suggestion, 'target_link_libraries(store_test PRIVATE log_wrapper)');

    const plan = api.planLinkEdit(result.from, result.provider.name);
    assert.strictEqual(plan.kind, 'append');
    assert.ok(plan.file.endsWith(path.join('tests', 'CMakeLists.txt')), plan.file);
  });

  // ------------------------------------------------- the reply as a snapshot

  // CMake reads files, not editor buffers. An unsaved CMakeLists is therefore
  // out of step with the reply while no timestamp says so, and configuring
  // against it regenerates the old text. Applying a link edit used to leave the
  // document exactly like this, so the next question answered "does not link"
  // about the line it had just written.
  await check('a clean tree reports nothing stale', () => {
    const stale = api.getStaleFiles();
    assert.deepStrictEqual(stale.unsaved, []);
    assert.deepStrictEqual(stale.edited, [], 'edited: ' + JSON.stringify(stale.edited));
  });

  const rootLists = path.join(workspace, 'CMakeLists.txt');
  const listsUri = vscode.Uri.file(rootLists);
  const listsDoc = await vscode.workspace.openTextDocument(listsUri);
  const before = fs.readFileSync(rootLists);
  try {
    // Shown first: revert acts on the active editor, and without this the
    // buffer stays dirty and the next save writes the probe text into the
    // checked-in fixture. It did, once.
    await vscode.window.showTextDocument(listsDoc);
    const dirty = new vscode.WorkspaceEdit();
    dirty.insert(listsUri, new vscode.Position(0, 0), '# unsaved\n');
    assert.ok(await vscode.workspace.applyEdit(dirty), 'could not dirty the document');

    await check('an unsaved CMakeLists counts as stale', () => {
      assert.ok(listsDoc.isDirty, 'the document was expected to be dirty');
      const stale = api.getStaleFiles();
      assert.deepStrictEqual(stale.unsaved.map((f) => path.basename(f)), ['CMakeLists.txt']);
      assert.ok(stale.all.length >= 1);
    });

    // The status bar used to be worked out once per model load and never
    // again, so it went on showing a file already put back and stayed quiet
    // about one just edited. Editing a CMakeLists has to move it on its own.
    await check('the status bar picks up the edit without a reload', async () => {
      await settle();
      assert.ok(api.getStatusText().indexOf('$(warning)') !== -1,
        'status bar reads ' + JSON.stringify(api.getStatusText()));
    });
  } finally {
    await vscode.commands.executeCommand('workbench.action.files.revert');
    // Nothing here may write. If the revert did not take, put the bytes back
    // rather than leave a modified tree behind for every later run.
    if (!fs.readFileSync(rootLists).equals(before)) fs.writeFileSync(rootLists, before);
  }

  await check('reverting the buffer clears the warning', async () => {
    assert.ok(!listsDoc.isDirty, 'the document is still dirty');
    assert.deepStrictEqual(api.getStaleFiles().unsaved, []);
    await settle();
    assert.strictEqual(api.getStatusText().indexOf('$(warning)'), -1,
      'status bar still reads ' + JSON.stringify(api.getStatusText()));
  });

  await check('a save that changes nothing is not an edit', () => {
    // Ctrl+S over an untouched buffer rewrites the same bytes and moves the
    // mtime; touching it is the same thing on disk without the risk of writing.
    // Warning about it is a nag, and it is what happened the first time this
    // was tried on a real project.
    const was = fs.statSync(rootLists);
    try {
      const now = Date.now() / 1000;
      fs.utimesSync(rootLists, now, now);
      const stale = api.getStaleFiles();
      assert.deepStrictEqual(stale.all, [], 'reported: ' + JSON.stringify(stale.all));
    } finally {
      // Put the timestamp back. Left forward, the fixture is newer than the
      // reply for good, and the next run of this file starts on a stale tree
      // with no baseline -- which is exactly how it failed.
      fs.utimesSync(rootLists, was.atime, was.mtime);
    }
  });

  // The quick fix is the point of the feature: it has to appear on the #include
  // line itself, which means going through VS Code's real code action pipeline.
  const probe = path.join(workspace, 'tests', '_probe_generated.cpp');
  try {
    fs.writeFileSync(probe, '#include "log_wrapper.h"\nint probe() { return 0; }\n');
    const uri = vscode.Uri.file(probe);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });

    await check('a quick fix is offered on the #include line', async () => {
      const actions = await vscode.commands.executeCommand(
        'vscode.executeCodeActionProvider', uri, new vscode.Range(0, 0, 0, 24));
      const ours = (actions || []).filter(
        (a) => a.command && a.command.command === 'cmakeLinkExplorer.applyLinkForInclude');
      assert.strictEqual(ours.length, 1, 'expected one quick fix, got ' + ours.length);
      assert.ok(/log_wrapper/.test(ours[0].title), 'title was ' + ours[0].title);
      assert.strictEqual(ours[0].kind.value, vscode.CodeActionKind.QuickFix.value);
    });

    await check('no quick fix on a line that is not an include', async () => {
      const actions = await vscode.commands.executeCommand(
        'vscode.executeCodeActionProvider', uri, new vscode.Range(1, 0, 1, 10));
      const ours = (actions || []).filter(
        (a) => a.command && a.command.command === 'cmakeLinkExplorer.applyLinkForInclude');
      assert.deepStrictEqual(ours, []);
    });
  } finally {
    try { fs.unlinkSync(probe); } catch (e) { /* best effort */ }
  }

  // ---------------------------------------------------------- linker map tab

  const mapFile = require('../../src/mapFile');
  const maps = path.join(__dirname, '..', 'maps');
  const mapProvider = api.getMapProvider();

  await check('a GNU ld map loads through the extension', () => {
    const model = api.loadMap(path.join(maps, 'gnu-ld-full.map'));
    assert.strictEqual(model.format, 'gnu-ld');
    assert.strictEqual(model.totals.total, 22344);
    assert.strictEqual(model.regions.length, 2);
  });

  await check('the map view renders real TreeItems', () => {
    const groups = mapProvider.getChildren();
    assert.ok(groups.length, 'the map view produced no groups');
    const objects = groups.find((g) => g.group === 'objects');
    assert.ok(objects, 'no "by object" group');

    const item = mapProvider.getTreeItem(objects);
    assert.ok(item.iconPath instanceof vscode.ThemeIcon, 'group icon is not a ThemeIcon');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);

    const biggest = mapProvider.getChildren(objects)[0];
    const objectItem = mapProvider.getTreeItem(biggest);
    assert.strictEqual(objectItem.label, 'store_reader.o  (libdemocore.a)');
    assert.ok(objectItem.tooltip instanceof vscode.MarkdownString, 'tooltip is not a MarkdownString');
  });

  await check('memory regions show usage against capacity', () => {
    const regions = mapProvider.getChildren().find((g) => g.group === 'regions');
    const flash = mapProvider.getTreeItem(mapProvider.getChildren(regions)[0]);
    assert.strictEqual(flash.label, 'FLASH');
    assert.strictEqual(flash.description, '3.6 KB / 512.0 KB   0.71%');
  });

  await check('an ld64 map loads and demangles C++ names', () => {
    const model = api.loadMap(path.join(maps, 'ld64-O0.map'));
    assert.strictEqual(model.format, 'ld64');
    // demangleSymbols defaults to true, so this exercises the c++filt path.
    assert.ok(model.symbols.some((s) => s.display === 'load(int)'),
              'no demangled name found; is c++filt missing?');
  });

  await check('two maps can be compared', () => {
    const comparison = api.compareMaps(path.join(maps, 'ld64-O0.map'),
                                       path.join(maps, 'ld64-O2.map'));
    assert.strictEqual(comparison.diff.total.delta, 13846 - 45117);
    const roots = mapProvider.getChildren();
    assert.strictEqual(mapProvider.getTreeItem(roots[0]).description,
                       '44.1 KB → 13.5 KB   -30.5 KB');
    const sections = mapProvider.getChildren(roots[2]);
    assert.strictEqual(mapProvider.getTreeItem(sections[0]).label, '__text');
  });

  await check('a loaded map gives every CMake target its share of the image', () => {
    api.loadMap(path.join(maps, 'sample-app.map'));
    const sizes = api.getSizes();
    assert.ok(sizes, 'no sizes were attached to the targets');

    const byName = new Map(Array.from(model.targets.values()).map((t) => [t.name, t]));
    const storeReader = sizes.get(byName.get('store_reader').id);
    assert.ok(storeReader && storeReader.size > 500, 'store_reader has no size');
    assert.strictEqual(sizes.get(byName.get('render_core').id).dynamic, true);

    const roots = provider.getChildren();
    const item = (name) =>
      provider.getTreeItem(roots.find((n) => model.targets.get(n.id).name === name));
    assert.strictEqual(item('store_reader').description, '→1 ←2   1.0 KB');
    assert.strictEqual(item('render_core').description, '→1 ←1   dynamic');
  });

  await check('comparing two maps drops the size column', () => {
    api.compareMaps(path.join(maps, 'ld64-O0.map'), path.join(maps, 'ld64-O2.map'));
    assert.strictEqual(api.getSizes(), null, 'a diff cannot give one size per target');
  });

  await check('closing the map empties the view', async () => {
    await vscode.commands.executeCommand('cmakeLinkExplorer.closeMap');
    assert.deepStrictEqual(mapProvider.getChildren(), []);
    assert.strictEqual(api.getSizes(), null, 'sizes should go away with the map');
  });

  await check('a file that is not a map is rejected with a clear error', () => {
    assert.throws(() => mapFile.parseFile(path.join(__dirname, 'index.js')), /Unrecognised/);
  });

  log('--- results ---');
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      log('  ok    ' + r.label);
    } else {
      failed++;
      log('  FAIL  ' + r.label);
      log('        ' + r.error);
    }
  }
  log('');
  log(failed === 0 ? 'all ' + results.length + ' checks passed' : failed + ' of ' + results.length + ' failed');
  log('');

  if (failed > 0) throw new Error(failed + ' integration check(s) failed');
}

module.exports = { run };

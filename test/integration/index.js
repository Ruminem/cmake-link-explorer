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

const EXTENSION_ID = 'local.cmake-link-explorer';

// The extension host does not forward console output to the launching shell, so
// results also go to a file the caller can read back.
const LOG_FILE = process.env.CMAKE_LINK_TEST_LOG || '';
const captured = [];

const results = [];
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
    const expected = ['dlt_wrapper', 'geo_utils', 'map_engine', 'map_test',
                      'navi_app', 'nds_reader', 'nds_test', 'sqlite_wrap', 'ui_core'];
    const actual = Array.from(byName.keys()).filter((n) => expected.indexOf(n) !== -1).sort();
    assert.deepStrictEqual(actual, expected);
  });

  await check('direct dependencies match what the CMakeLists declares', () => {
    // app/CMakeLists.txt: target_link_libraries(navi_app PRIVATE map_engine ui_core dlt_wrapper)
    assert.deepStrictEqual(namesOf(byName.get('navi_app').directDependencyIds),
                           ['dlt_wrapper', 'map_engine', 'ui_core']);
    // libs/map_engine/CMakeLists.txt: target_link_libraries(map_engine PUBLIC nds_reader geo_utils)
    assert.deepStrictEqual(namesOf(byName.get('map_engine').directDependencyIds),
                           ['geo_utils', 'nds_reader']);
  });

  await check('CMake reports the transitive closure that the view reduces away', () => {
    assert.deepStrictEqual(namesOf(byName.get('navi_app').dependencyIds),
                           ['dlt_wrapper', 'geo_utils', 'map_engine', 'nds_reader', 'sqlite_wrap', 'ui_core']);
  });

  await check('the tree shows only the direct dependencies', () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'navi_app');
    const shown = provider.getChildren(node)
      .filter((n) => n.direction === 'forward')
      .map((n) => model.targets.get(n.id).name).sort();
    assert.deepStrictEqual(shown, ['dlt_wrapper', 'map_engine', 'ui_core']);
  });

  await check('the path trace walks one hop at a time', () => {
    const fileApi = require('../../src/fileApi');
    const ids = fileApi.findLinkPath(model, byName.get('navi_app').id, byName.get('sqlite_wrap').id);
    assert.deepStrictEqual(ids.map(nameOf),
                           ['navi_app', 'map_engine', 'nds_reader', 'sqlite_wrap']);
  });

  await check('reverse dependencies are derived correctly', () => {
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('geo_utils').id)),
                           ['map_engine', 'ui_core']);
  });

  await check('transitive PUBLIC linkage is visible', () => {
    assert.deepStrictEqual(namesOf(model.linkedBy.get(byName.get('nds_reader').id)),
                           ['map_engine', 'nds_test']);
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
    assert.ok(names.indexOf('navi_app') !== -1, 'navi_app missing from tree roots');
    assert.ok(names.indexOf('generate_docs') === -1, 'UTILITY target leaked into the tree');
  });

  await check('a real TreeItem is produced for a target', () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'geo_utils');
    const item = provider.getTreeItem(node);
    assert.strictEqual(item.label, 'geo_utils');
    assert.strictEqual(item.description, '←2');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.ok(item.iconPath instanceof vscode.ThemeIcon, 'icon is not a ThemeIcon');
    assert.ok(item.tooltip instanceof vscode.MarkdownString, 'tooltip is not a MarkdownString');
  });

  await check('both directions are counted on the row itself', () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'map_engine');
    assert.strictEqual(provider.getTreeItem(node).description, '→2 ←2');

    const children = provider.getChildren(node);
    assert.deepStrictEqual(
      children.map((c) => c.direction + ':' + model.targets.get(c.id).name),
      ['forward:geo_utils', 'forward:nds_reader', 'reverse:map_test', 'reverse:navi_app']);
  });

  await check('executables sort ahead of the libraries everything leans on', () => {
    const names = provider.getChildren().map((n) => model.targets.get(n.id).name);
    assert.deepStrictEqual(names.slice(0, 3), ['map_test', 'navi_app', 'nds_test']);
    assert.ok(names.indexOf('geo_utils') < names.indexOf('dlt_wrapper'),
              'geo_utils has more dependents and should sort higher');
  });

  await check('direction arrows are real coloured ThemeIcons', () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'map_engine');
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
    const node = roots.find((n) => model.targets.get(n.id).name === 'map_engine');
    await vscode.commands.executeCommand('cmakeLinkExplorer.openCMakeLists', node);

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'no editor was opened');
    assert.ok(editor.document.fileName.endsWith(path.join('map_engine', 'CMakeLists.txt')),
              'opened the wrong file: ' + editor.document.fileName);
    const line = editor.document.lineAt(editor.selection.active.line).text;
    assert.ok(/add_library\s*\(\s*map_engine\b/.test(line),
              'cursor landed on: ' + JSON.stringify(line));
  });

  await check('the refresh command runs without throwing', async () => {
    await vscode.commands.executeCommand('cmakeLinkExplorer.refresh');
    assert.ok(api.getModel(), 'model was lost after refresh');
  });

  await check('copyName puts the target name on the clipboard', async () => {
    const roots = provider.getChildren();
    const node = roots.find((n) => model.targets.get(n.id).name === 'sqlite_wrap');
    await vscode.commands.executeCommand('cmakeLinkExplorer.copyName', node);
    assert.strictEqual(await vscode.env.clipboard.readText(), 'sqlite_wrap');
  });

  // ---------------------------------------------------------- linker map tab

  const mapFile = require('../../src/mapFile');
  const maps = path.join(__dirname, '..', 'maps');
  const mapProvider = api.getMapProvider();

  await check('a GNU ld map loads through the extension', () => {
    const model = api.loadMap(path.join(maps, 'gnu-ld-full.map'));
    assert.strictEqual(model.format, 'gnu-ld');
    assert.strictEqual(model.totals.total, 22352);
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
    assert.strictEqual(objectItem.label, 'nds_reader.o  (libnavicore.a)');
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
    api.loadMap(path.join(maps, 'sample-navi_app.map'));
    const sizes = api.getSizes();
    assert.ok(sizes, 'no sizes were attached to the targets');

    const byName = new Map(Array.from(model.targets.values()).map((t) => [t.name, t]));
    const ndsReader = sizes.get(byName.get('nds_reader').id);
    assert.ok(ndsReader && ndsReader.size > 500, 'nds_reader has no size');
    assert.strictEqual(sizes.get(byName.get('ui_core').id).dynamic, true);

    const roots = provider.getChildren();
    const item = (name) =>
      provider.getTreeItem(roots.find((n) => model.targets.get(n.id).name === name));
    assert.strictEqual(item('nds_reader').description, '→1 ←2   1.0 KB');
    assert.strictEqual(item('ui_core').description, '→1 ←1   dynamic');
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

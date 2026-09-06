'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const fileApi = require('./fileApi');
const mapFile = require('./mapFile');
const includeResolver = require('./includeResolver');
const cmakeEdit = require('./cmakeEdit');
const { TargetTreeProvider, SHORT_TYPE } = require('./tree');
const { MapTreeProvider } = require('./mapTree');

let provider = null;
let mapProvider = null;
let mapView = null;
let treeView = null;
let output = null;
let statusItem = null;
let replyWatcher = null;
let currentBuildDir = null;
let currentMapModel = null;

function config() {
  return vscode.workspace.getConfiguration('cmakeLinkExplorer');
}

function activate(context) {
  provider = new TargetTreeProvider();
  mapProvider = new MapTreeProvider();
  output = vscode.window.createOutputChannel('CMake Link Explorer');

  treeView = vscode.window.createTreeView('cmakeLinkExplorer.targets', {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  mapView = vscode.window.createTreeView('cmakeLinkExplorer.map', {
    treeDataProvider: mapProvider,
    showCollapseAll: true
  });

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.command = 'cmakeLinkExplorer.search';

  context.subscriptions.push(treeView, mapView, output, statusItem, {
    dispose: () => replyWatcher && replyWatcher.dispose()
  });

  const register = (name, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));

  register('cmakeLinkExplorer.refresh', () => reload());
  register('cmakeLinkExplorer.selectBuildDir', selectBuildDir);
  register('cmakeLinkExplorer.configure', runConfigure);
  register('cmakeLinkExplorer.search', searchTarget);
  register('cmakeLinkExplorer.whyLinked', whyLinked);
  register('cmakeLinkExplorer.openCMakeLists', openCMakeLists);
  register('cmakeLinkExplorer.copyName', copyName);
  register('cmakeLinkExplorer.openMap', openMap);
  register('cmakeLinkExplorer.diffMaps', diffMaps);
  register('cmakeLinkExplorer.closeMap', closeMap);
  register('cmakeLinkExplorer.linkForInclude', linkForInclude);
  register('cmakeLinkExplorer.compileSettings', compileSettings);
  register('cmakeLinkExplorer.projectHealth', projectHealth);
  register('cmakeLinkExplorer.compareTrees', compareTrees);
  register('cmakeLinkExplorer.applyLinkForInclude', reportInclude);

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ language: 'cpp' }, { language: 'c' }, { language: 'objective-cpp' }],
      new LinkIncludeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cmakeLinkExplorer.buildDirectory') ||
          e.affectsConfiguration('cmakeLinkExplorer.configuration')) {
        reload();
      } else if (e.affectsConfiguration('cmakeLinkExplorer')) {
        provider.refresh();
      }
    })
  );

  reload();

  // Returned to VS Code as this extension's public API. Integration tests use it
  // to inspect the loaded graph without going through the tree view UI.
  return {
    reload: reload,
    getModel: () => provider.model,
    getProvider: () => provider,
    getBuildDirectory: () => currentBuildDir,
    getMapProvider: () => mapProvider,
    loadMap: loadMapFile,
    resolveInclude: (file, include) =>
      includeResolver.resolve(provider.model, file, include, fileApi.isLinkable),
    planLinkEdit: (target, library) => cmakeEdit.planLinkEdit(provider.model, target, library),
    compareMaps: compareMapFiles,
    closeMap: closeMap,
    getSizes: () => provider.sizes
  };
}

function deactivate() {
  if (replyWatcher) replyWatcher.dispose();
}

// ---------------------------------------------------------------- loading

async function reload() {
  const buildDir = resolveBuildDir();
  if (!buildDir) {
    currentBuildDir = null;
    provider.setError('No CMake build directory found.');
    updateStatus();
    return;
  }

  currentBuildDir = buildDir;

  // Ask CMake for a codemodel. Harmless if it is already there, and it means the
  // user's next configure run will produce a reply even if this one cannot.
  try {
    fileApi.ensureQuery(buildDir);
  } catch (e) {
    // A read-only build tree is not fatal as long as a reply already exists.
  }

  if (!fileApi.hasReply(buildDir)) {
    provider.setError('CMake has not written a File API reply yet.');
    updateStatus();
    const choice = await vscode.window.showInformationMessage(
      'CMake Link Explorer needs one CMake configure run in ' + path.basename(buildDir) +
        ' to read the target graph.',
      'Run CMake configure'
    );
    if (choice) runConfigure();
    return;
  }

  try {
    const model = fileApi.loadModel(buildDir, config().get('configuration', ''));
    resolveCache = new Map();
    provider.setModel(model);
    applySizesToTargets();
    watchReply(buildDir);
    updateStatus();
  } catch (e) {
    provider.setError(String(e.message || e));
    updateStatus();
    vscode.window.showErrorMessage('CMake Link Explorer: ' + (e.message || e));
  }
}

function resolveBuildDir() {
  const configured = (config().get('buildDirectory', '') || '').trim();
  if (configured) {
    const resolved = path.isAbsolute(configured)
      ? configured
      : path.join(firstWorkspaceRoot() || '', configured);
    return fileApi.isBuildDir(resolved) ? resolved : null;
  }

  const roots = (vscode.workspace.workspaceFolders || [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
  if (!roots.length) return null;

  const found = fileApi.findBuildDirs(roots);
  if (!found.length) return null;

  // Prefer a build tree that already has a reply, so we show something useful
  // straight away instead of asking for a reconfigure of an unrelated tree.
  const withReply = found.filter((dir) => fileApi.hasReply(dir));
  return (withReply.length ? withReply : found)[0];
}

function firstWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.length ? folders[0].uri.fsPath : null;
}

function watchReply(buildDir) {
  if (replyWatcher) replyWatcher.dispose();
  const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
  const pattern = new vscode.RelativePattern(vscode.Uri.file(replyDir), 'index-*.json');
  replyWatcher = vscode.workspace.createFileSystemWatcher(pattern);
  // A new index file means CMake reconfigured; the graph may have changed.
  replyWatcher.onDidCreate(() => reload());
  replyWatcher.onDidChange(() => reload());
}

function updateStatus() {
  if (!provider.model) {
    statusItem.hide();
    return;
  }
  const count = provider.visibleTargets().length;
  const stale = fileApi.staleInputs(provider.model);
  statusItem.text = (stale.length ? '$(warning) ' : '$(circuit-board) ') + count + ' targets';
  statusItem.tooltip =
    'CMake Link Explorer\n' +
    provider.model.buildDir +
    '\nconfiguration: ' +
    provider.model.configuration +
    (stale.length
      ? '\n\nEdited since CMake last configured:\n  ' +
        stale.map((f) => path.basename(f)).join('\n  ') +
        '\nWhat is shown is the previous configure.'
      : '');
  statusItem.show();
}

// ---------------------------------------------------------------- commands

// Everything here is read out of the File API reply, which CMake writes when it
// configures. Editing a CMakeLists.txt does not touch it. So after an edit the
// extension will happily answer "example already links spdlog" about a
// target_link_libraries() line that has already been deleted -- and that answer
// looks exactly like a correct one. Nothing downstream can tell the difference,
// so the question gets asked before the answer is given rather than after.
async function staleEnoughToStop(subject) {
  if (!provider.model) return false;
  const stale = fileApi.staleInputs(provider.model);
  if (!stale.length) return false;

  const shown = stale.slice(0, 3).map((f) => path.basename(f));
  const names = shown.join(', ') +
    (stale.length > shown.length ? ' and ' + (stale.length - shown.length) + ' more' : '');
  const choice = await vscode.window.showWarningMessage(
    names + ' changed since CMake last configured, so ' + subject +
      ' describes the previous configure.',
    'Run CMake configure', 'Show it anyway');
  if (choice === 'Run CMake configure') runConfigure();
  return choice !== 'Show it anyway';
}


async function selectBuildDir() {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use as CMake build directory'
  });
  if (!picked || !picked.length) return;

  const dir = picked[0].fsPath;
  if (!fileApi.isBuildDir(dir)) {
    vscode.window.showErrorMessage('No CMakeCache.txt in ' + dir + ' — that is not a CMake build directory.');
    return;
  }

  const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await config().update('buildDirectory', dir, target);
  // onDidChangeConfiguration triggers the reload.
}

function runConfigure() {
  if (!currentBuildDir) {
    vscode.window.showErrorMessage('Select a CMake build directory first.');
    return;
  }
  const terminal = vscode.window.createTerminal('CMake configure');
  terminal.show();
  // Re-running cmake on an existing build tree regenerates using the cached
  // source directory and options.
  terminal.sendText('cmake ' + quote(currentBuildDir));
}

function quote(p) {
  return '"' + p.replace(/"/g, '\\"') + '"';
}

async function searchTarget() {
  if (!provider.model) {
    vscode.window.showInformationMessage('No CMake targets loaded.');
    return;
  }
  const target = await pickTarget('Find a target');
  if (!target) return;

  // rootNodes is only populated once the tree has been asked for children.
  if (!provider.rootNodes.length) provider.getChildren();
  const node = provider.rootNodes.find((n) => n.id === target.id);
  if (node) {
    await treeView.reveal(node, { select: true, focus: true, expand: true });
  }
}

async function pickTarget(placeHolder) {
  const items = provider.visibleTargets().map((target) => ({
    label: target.name,
    description: SHORT_TYPE[target.type] || target.type,
    detail: target.sourceDir ? target.sourceDir + '/CMakeLists.txt' : undefined,
    target: target
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeHolder,
    matchOnDescription: true,
    matchOnDetail: true
  });
  return picked ? picked.target : null;
}

async function whyLinked() {
  if (!provider.model) {
    vscode.window.showInformationMessage('No CMake targets loaded.');
    return;
  }
  if (await staleEnoughToStop('the path between two targets')) return;
  const from = await pickTarget('Start from which target?');
  if (!from) return;
  const to = await pickTarget('Why does "' + from.name + '" end up pulling in...?');
  if (!to) return;

  const model = provider.model;
  const ids = fileApi.findLinkPath(model, from.id, to.id);

  output.clear();
  output.show(true);

  if (!ids) {
    output.appendLine(from.name + '  does not link  ' + to.name + '  directly or transitively.');
    const reverse = fileApi.findLinkPath(model, to.id, from.id);
    if (reverse) {
      output.appendLine('');
      output.appendLine('It is the other way around: ' + to.name + ' links ' + from.name + '.');
      output.appendLine('');
      writeChain(model, reverse);
    }
    return;
  }

  output.appendLine('Why ' + from.name + ' pulls in ' + to.name + '  (shortest path, ' + (ids.length - 1) + ' hops)');
  output.appendLine('');
  writeChain(model, ids);
}

function writeChain(model, ids) {
  ids.forEach((id, index) => {
    const target = model.targets.get(id);
    const label = target.name + '  [' + (SHORT_TYPE[target.type] || target.type) + ']';
    if (index === 0) {
      output.appendLine(label);
      return;
    }
    // Name the target_link_libraries() that made this hop. Written as file:line
    // so the output pane turns it into something clickable.
    const previous = model.targets.get(ids[index - 1]);
    const site = previous && previous.dependencySites && previous.dependencySites.get(id);
    const where = site ? '    ' + site.file + ':' + site.line : '';
    output.appendLine('  '.repeat(index) + '└─ links → ' + label + where);
  });
}

async function openCMakeLists(node) {
  if (!provider.model || !node || !node.id) return;
  const target = provider.model.targets.get(node.id);
  if (!target) return;

  // CMake records where it saw this target declared, so use that. Searching the
  // text only finds the call when the name is written out literally, which stops
  // being true the moment a helper function or a variable is involved.
  const site = target.declaration;
  const file = site
    ? path.join(provider.model.sourceDir, site.file)
    : path.join(provider.model.sourceDir, target.sourceDir, 'CMakeLists.txt');
  if (!fs.existsSync(file)) {
    vscode.window.showWarningMessage('Could not find ' + file);
    return;
  }
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document, { preview: true });

  const line = site ? site.line - 1 : findDeclarationLine(document, target.name);
  revealLine(editor, line);

  // The line above is the one somebody wrote. When a helper stands between it
  // and the add_library() itself, say where that ran rather than leaving the
  // jump looking like it landed on the wrong command.
  const via = target.declaredVia;
  if (via && (via.file !== site.file || via.line !== site.line)) {
    vscode.window.setStatusBarMessage(
      target.name + ' is created by ' + via.command + ' at ' + via.file + ':' + via.line, 8000);
  }
}

// Only used when the codemodel gave us no location for a target.
function findDeclarationLine(document, name) {
  const pattern = new RegExp('(add_executable|add_library)\\s*\\(\\s*' + escapeRegExp(name) + '\\b', 'i');
  for (let line = 0; line < document.lineCount; line++) {
    if (pattern.test(document.lineAt(line).text)) return line;
  }
  return -1;
}

function revealLine(editor, line) {
  if (typeof line !== 'number' || line < 0 || line >= editor.document.lineCount) return;
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function copyName(node) {
  if (!provider.model || !node || !node.id) return;
  const target = provider.model.targets.get(node.id);
  if (target) await vscode.env.clipboard.writeText(target.name);
}

// ------------------------------------------------------- includes -> linking

// resolve() touches the filesystem, and the code action provider is asked on
// every cursor move, so results are cached until the model reloads.
let resolveCache = new Map();

function resolveInclude(document, includePath) {
  if (!provider.model) return null;
  const key = document.uri.fsPath + ' ' + includePath;
  if (resolveCache.has(key)) return resolveCache.get(key);

  let result = null;
  try {
    result = includeResolver.resolve(
      provider.model, document.uri.fsPath, includePath, fileApi.isLinkable);
  } catch (e) {
    result = null;
  }
  if (resolveCache.size > 500) resolveCache.clear();
  resolveCache.set(key, result);
  return result;
}

function includeAt(document, line) {
  if (line < 0 || line >= document.lineCount) return null;
  return includeResolver.parseIncludeLine(document.lineAt(line).text);
}

/**
 * Offers the fix on the #include line itself, which is where the question comes
 * up: you have just typed the include and the build has not been run yet.
 */
class LinkIncludeActionProvider {
  provideCodeActions(document, range) {
    const includePath = includeAt(document, range.start.line);
    if (!includePath) return [];

    const result = resolveInclude(document, includePath);
    if (!result || (result.status !== 'needs-link' && result.status !== 'transitive')) return [];

    const direct = result.status === 'needs-link';
    const action = new vscode.CodeAction(
      (direct ? 'Link ' : 'Link ') + result.provider.name + ' from ' + result.from.name +
        (direct ? '' : ' (currently only transitive)'),
      vscode.CodeActionKind.QuickFix);
    action.command = {
      command: 'cmakeLinkExplorer.applyLinkForInclude',
      title: 'Add target_link_libraries',
      arguments: [document.uri.fsPath, includePath]
    };
    action.isPreferred = direct;
    return [action];
  }
}

// Development happens on one platform and the product is built on another, so
// the same CMakeLists produces two different configured trees. What differs
// between them is where "builds here, breaks there" comes from.
async function compareTrees() {
  if (!provider.model) {
    vscode.window.showInformationMessage('No CMake targets loaded.');
    return;
  }
  if (await staleEnoughToStop('this comparison')) return;

  const other = await pickOtherBuildDir();
  if (!other) return;

  let otherModel;
  try {
    otherModel = fileApi.loadModel(other, config().get('configuration', ''));
  } catch (e) {
    vscode.window.showWarningMessage('Could not read ' + other + ': ' + (e.message || e));
    return;
  }

  const diff = fileApi.compareModels(provider.model, otherModel);

  output.clear();
  output.show(true);
  output.appendLine('this tree   ' + provider.model.buildDir);
  output.appendLine('other tree  ' + otherModel.buildDir);
  output.appendLine('');

  const listTargets = (label, targets) => {
    if (!targets.length) return;
    output.appendLine(label + ' (' + targets.length + ')');
    for (const target of targets) {
      output.appendLine('    ' + target.name +
                        '  [' + (SHORT_TYPE[target.type] || target.type) + ']' +
                        (target.declaration
                          ? '    ' + target.declaration.file + ':' + target.declaration.line : ''));
    }
    output.appendLine('');
  };
  listTargets('only in this tree', diff.onlyLeft);
  listTargets('only in the other tree', diff.onlyRight);

  const writeDiff = (label, entry) => {
    if (!entry.added.length && !entry.removed.length) return;
    // "+" is what the other tree has and this one does not.
    for (const value of entry.removed) output.appendLine('    ' + label + '  - ' + value);
    for (const value of entry.added) output.appendLine('    ' + label + '  + ' + value);
  };

  if (!diff.changed.length) {
    output.appendLine('Every target the two share is configured the same way.');
  } else {
    output.appendLine('differing targets (' + diff.changed.length + ')');
    output.appendLine('  "-" is only in this tree, "+" only in the other.');
    for (const entry of diff.changed) {
      output.appendLine('');
      output.appendLine('  ' + entry.name);
      if (entry.type) {
        output.appendLine('    type      - ' + entry.type.left + '  + ' + entry.type.right);
      }
      writeDiff('define  ', entry.defines);
      writeDiff('include ', entry.includes);
      writeDiff('links   ', entry.links);
    }
  }

  output.appendLine('');
  output.appendLine('Include paths outside the project and external libraries are left out:');
  output.appendLine('they sit at different places on the two machines and are spelled');
  output.appendLine('differently by the two toolchains, so comparing them says nothing.');
}

async function pickOtherBuildDir() {
  const roots = (vscode.workspace.workspaceFolders || [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
  const current = provider.model.buildDir;
  const found = fileApi.findBuildDirs(roots)
    .filter((dir) => path.resolve(dir) !== path.resolve(current));

  const BROWSE = 'Choose another folder...';
  const items = found.map((dir) => ({ label: dir })).concat([{ label: BROWSE }]);
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Compare this build tree against which other one?'
  });
  if (!picked) return null;
  if (picked.label !== BROWSE) return picked.label;

  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    openLabel: 'Compare against this build tree'
  });
  if (!chosen || !chosen.length) return null;

  const dir = chosen[0].fsPath;
  if (!fileApi.isBuildDir(dir)) {
    vscode.window.showWarningMessage('No CMakeCache.txt in ' + dir + '.');
    return null;
  }
  return dir;
}

// Two questions a link graph can answer about itself: what loops, and what
// nothing needs.
async function projectHealth() {
  if (!provider.model) {
    vscode.window.showInformationMessage('No CMake targets loaded.');
    return;
  }
  if (await staleEnoughToStop('the cycle and unused report')) return;
  const model = provider.model;
  const name = (id) => (model.targets.get(id) || {}).name || id;

  output.clear();
  output.show(true);

  const cycles = fileApi.findCycles(model);
  if (cycles === null) {
    // Saying "no cycles" here would be a claim this codemodel cannot support.
    output.appendLine('cycles: cannot tell from this codemodel.');
    output.appendLine('  CMake drops the edge that closes a cycle from its dependency');
    output.appendLine('  graph, and this reply does not carry the link lists that keep it.');
    output.appendLine('  A newer CMake writes them; re-run the configure with one to check.');
  } else if (!cycles.length) {
    output.appendLine('cycles: none.');
  } else {
    output.appendLine('cycles (' + cycles.length + ')');
    output.appendLine('  CMake allows these between static libraries and repeats the archives');
    output.appendLine('  on the link line, so they build. They still make the structure much');
    output.appendLine('  harder to follow than the tree suggests.');
    for (const cycle of cycles) {
      output.appendLine('');
      output.appendLine('    ' + cycle.map(name).join(' → ') + ' → ' + name(cycle[0]));
      for (let i = 0; i < cycle.length; i++) {
        const from = model.targets.get(cycle[i]);
        const toId = cycle[(i + 1) % cycle.length];
        const site = from.dependencySites && from.dependencySites.get(toId);
        output.appendLine('      ' + from.name + ' links ' + name(toId) +
                          (site ? '    ' + site.file + ':' + site.line : ''));
      }
    }
  }

  const unused = fileApi.findUnusedTargets(model);
  output.appendLine('');
  if (!unused.length) {
    output.appendLine('unused libraries: none.');
  } else {
    output.appendLine('unused libraries (' + unused.length + ')');
    output.appendLine('  Nothing in this project links them, and they are not installed.');
    output.appendLine('  Executables, utility targets and plugins are not counted.');
    output.appendLine('');
    for (const target of unused) {
      output.appendLine('    ' + target.name +
                        '  [' + (SHORT_TYPE[target.type] || target.type) + ']' +
                        (target.declaration
                          ? '    ' + target.declaration.file + ':' + target.declaration.line : ''));
    }
  }
}

// "Why is this #ifdef not firing, and which headers can this file even see?"
// CMake has already resolved generator expressions and everything inherited
// through PUBLIC/INTERFACE by the time it writes the codemodel, so this is the
// effective set rather than a reading of the CMakeLists.
async function compileSettings() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a source file first.');
    return;
  }
  if (!provider.model) {
    vscode.window.showWarningMessage('No CMake targets loaded yet.');
    return;
  }
  if (await staleEnoughToStop('these compile settings')) return;

  const file = editor.document.uri.fsPath;
  const found = includeResolver.compileSettingsForFile(provider.model, file);

  output.clear();
  output.show(true);
  output.appendLine(path.basename(file));

  if (!found) {
    output.appendLine('');
    output.appendLine('No target in this project compiles it.');
    return;
  }

  const { target, group, exact } = found;
  output.appendLine('  target     ' + target.name +
                    '  [' + (SHORT_TYPE[target.type] || target.type) + ']');

  if (!group) {
    output.appendLine('');
    output.appendLine(target.compileGroups && target.compileGroups.length
      ? 'CMake lists no compile settings for this file, and ' + target.name +
        ' has more than one language group, so which one applies is a guess. Not showing any.'
      : 'CMake recorded no compile settings for ' + target.name + '.');
    return;
  }

  const language = group.language || 'unknown';
  output.appendLine('  language   ' + language + (group.standard ? ' (' + group.standard + ')' : ''));
  if (!exact) {
    // Headers are never in a compile group; say so rather than implying CMake
    // reported this file directly.
    output.appendLine('  note       not compiled directly; showing what ' + target.name + ' uses');
  }

  output.appendLine('');
  output.appendLine('  defines (' + group.defines.length + ')');
  for (const define of group.defines) output.appendLine('    ' + define);
  if (!group.defines.length) output.appendLine('    (none)');

  output.appendLine('');
  output.appendLine('  include paths (' + group.includes.length + ')');
  for (const include of group.includes) {
    output.appendLine('    ' + include.path + (include.isSystem ? '   [system]' : ''));
  }
  if (!group.includes.length) output.appendLine('    (none)');
}

async function linkForInclude() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a source file first.');
    return;
  }
  if (!provider.model) {
    vscode.window.showWarningMessage('No CMake targets loaded yet.');
    return;
  }

  let includePath = includeAt(editor.document, editor.selection.active.line);
  if (!includePath) includePath = await pickIncludeFromDocument(editor.document);
  if (!includePath) return;

  await reportInclude(editor.document.uri.fsPath, includePath);
}

async function pickIncludeFromDocument(document) {
  const items = [];
  for (let line = 0; line < document.lineCount; line++) {
    const value = includeResolver.parseIncludeLine(document.lineAt(line).text);
    if (value) items.push({ label: value, description: 'line ' + (line + 1), value });
  }
  if (!items.length) {
    vscode.window.showInformationMessage('No #include lines in this file.');
    return null;
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Which include do you need linked?'
  });
  return picked ? picked.value : null;
}

async function reportInclude(filePath, includePath) {
  // Guarded here rather than in linkForInclude so the context-menu route and
  // the quick-pick route are both covered.
  if (await staleEnoughToStop('the answer for this include')) return;

  const document = await vscode.workspace.openTextDocument(filePath);
  const result = resolveInclude(document, includePath);
  if (!result) return;

  const header = '#include "' + includePath + '"';

  switch (result.status) {
    case 'unknown-target':
      vscode.window.showWarningMessage(
        path.basename(filePath) + ' is not part of any CMake target in this build.');
      return;

    case 'not-found':
      vscode.window.showInformationMessage(
        'No CMake target in this project provides ' + includePath +
        '. It may come from a header-only INTERFACE library or from outside the project.');
      return;

    case 'same-target':
      vscode.window.showInformationMessage(
        includePath + ' belongs to ' + result.from.name + ' itself. Nothing to link.');
      return;

    case 'already-linked':
      vscode.window.showInformationMessage(
        result.from.name + ' already links ' + result.provider.name + ', so ' + header + ' works.');
      return;

    case 'transitive': {
      const choice = await vscode.window.showWarningMessage(
        result.provider.name + ' reaches ' + result.from.name +
          ' only through another library. That compiles today and breaks the day the ' +
          'library in the middle stops using it.',
        'Link it directly', 'Leave it');
      if (choice === 'Link it directly') await applyLink(result);
      return;
    }

    case 'needs-link': {
      const choice = await vscode.window.showInformationMessage(
        includePath + ' comes from ' + result.provider.name + ', which ' +
          result.from.name + ' does not link.',
        result.suggestion, 'Show other candidates');
      if (choice === result.suggestion) await applyLink(result);
      else if (choice) await showCandidates(result);
      return;
    }

    default:
      return;
  }
}

async function showCandidates(result) {
  const items = result.candidates.map((candidate) => ({
    label: candidate.target.name,
    description: candidate.how === 'listed' ? 'lists this header'
      : candidate.how === 'owned' ? 'the header is in its directory'
        : 'a file of that name is under its directory',
    detail: candidate.file,
    candidate
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Which library actually provides it?'
  });
  if (picked) {
    await applyLink(Object.assign({}, result, { provider: picked.candidate.target }));
  }
}

async function applyLink(result) {
  const plan = cmakeEdit.planLinkEdit(
    provider.model, result.from, result.provider.name, result.keyword);
  if (plan.kind === 'manual') {
    vscode.window.showWarningMessage(plan.reason);
    return;
  }

  const document = await vscode.workspace.openTextDocument(plan.file);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(plan.position.line, plan.position.character), plan.insert);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage('Could not edit ' + path.basename(plan.file));
    return;
  }

  const editor = await vscode.window.showTextDocument(document);
  const line = Math.min(plan.position.line + (plan.kind === 'create' ? 1 : 0), document.lineCount - 1);
  editor.selection = new vscode.Selection(new vscode.Position(line, 0), new vscode.Position(line, 0));
  editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);

  vscode.window.showInformationMessage(
    plan.preview + '  —  re-run CMake for the change to take effect.', 'Run CMake configure')
    .then((choice) => { if (choice) runConfigure(); });
}

// ---------------------------------------------------------------- map files

function loadMapFile(filePath) {
  const model = mapFile.parseFile(filePath);
  if (config().get('demangleSymbols', true)) {
    // Only what the view can show; demangling every symbol of a large map costs
    // about a second on the extension host thread.
    mapFile.demangle(model, config().get('demanglerCommand', 'c++filt'),
                     config().get('mapSymbolLimit', 200));
  }
  mapProvider.showMap(model);
  mapView.title = path.basename(filePath);
  mapView.description = model.format + '  ·  ' + mapFile.formatBytes(model.totals.total);

  currentMapModel = model;
  applySizesToTargets();
  return model;
}

// The two views describe the same build, so a loaded map also gives every CMake
// target its share of the image. Re-run whenever either side changes.
function applySizesToTargets() {
  if (!currentMapModel || !provider.model) {
    provider.setSizes(null);
    return null;
  }
  const sizes = mapFile.matchTargets(provider.model, currentMapModel);
  provider.setSizes(sizes);
  return sizes;
}

function compareMapFiles(beforePath, afterPath) {
  const before = mapFile.parseFile(beforePath);
  const after = mapFile.parseFile(afterPath);
  mapProvider.showDiff(before, after);
  // A diff describes two images at once, so a single size per target would be
  // ambiguous; drop the column until one map is open again.
  currentMapModel = null;
  applySizesToTargets();
  mapView.title = 'diff';
  mapView.description = path.basename(beforePath) + ' → ' + path.basename(afterPath);
  return mapProvider.comparison;
}

// Offers the map files sitting in the build tree, plus a way to pick any other.
async function pickMapFile(placeHolder, exclude) {
  const candidates = currentBuildDir ? mapFile.findMapFiles(currentBuildDir) : [];
  const items = candidates
    .filter((file) => file !== exclude)
    .map((file) => ({
      label: path.basename(file),
      description: path.relative(currentBuildDir, path.dirname(file)) || '.',
      file
    }));
  items.push({ label: '$(folder-opened) Browse...', description: 'pick a map file anywhere', file: null });

  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  if (!picked) return null;
  if (picked.file) return picked.file;

  const chosen = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Open map file',
    filters: { 'Linker map files': ['map', 'txt'], 'All files': ['*'] }
  });
  return chosen && chosen.length ? chosen[0].fsPath : null;
}

async function openMap() {
  const file = await pickMapFile('Open a linker map file');
  if (!file) return;
  try {
    const model = loadMapFile(file);
    vscode.window.showInformationMessage(
      path.basename(file) + ': ' + mapFile.formatBytes(model.totals.total) +
      ' across ' + model.totals.byObject.size + ' object files (' + model.format + ')');
  } catch (e) {
    vscode.window.showErrorMessage('Could not read ' + path.basename(file) + ': ' + (e.message || e));
  }
}

async function diffMaps() {
  const before = await pickMapFile('Compare from which map file? (the older build)');
  if (!before) return;
  const after = await pickMapFile('Compare against which map file? (the newer build)', before);
  if (!after) return;
  try {
    const comparison = compareMapFiles(before, after);
    const { delta } = comparison.diff.total;
    vscode.window.showInformationMessage(
      'Size change: ' + (delta > 0 ? '+' : '') + mapFile.formatBytes(delta) +
      ' across ' + comparison.diff.objects.length + ' object files');
  } catch (e) {
    vscode.window.showErrorMessage('Could not compare those map files: ' + (e.message || e));
  }
}

function closeMap() {
  mapProvider.clear();
  currentMapModel = null;
  applySizesToTargets();
  mapView.title = 'Linker Map';
  mapView.description = undefined;
}

module.exports = { activate, deactivate };

'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const fileApi = require('./fileApi');
const { TargetTreeProvider, SHORT_TYPE } = require('./tree');

let provider = null;
let treeView = null;
let output = null;
let statusItem = null;
let replyWatcher = null;
let currentBuildDir = null;

function config() {
  return vscode.workspace.getConfiguration('cmakeLinkExplorer');
}

function activate(context) {
  provider = new TargetTreeProvider();
  output = vscode.window.createOutputChannel('CMake Link Explorer');

  treeView = vscode.window.createTreeView('cmakeLinkExplorer.targets', {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.command = 'cmakeLinkExplorer.search';

  context.subscriptions.push(treeView, output, statusItem, {
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
    provider.setModel(model);
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
  statusItem.text = '$(circuit-board) ' + count + ' targets';
  statusItem.tooltip =
    'CMake Link Explorer\n' +
    provider.model.buildDir +
    '\nconfiguration: ' +
    provider.model.configuration;
  statusItem.show();
}

// ---------------------------------------------------------------- commands

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
    } else {
      output.appendLine('  '.repeat(index) + '└─ links → ' + label);
    }
  });
}

async function openCMakeLists(node) {
  if (!provider.model || !node || !node.id) return;
  const target = provider.model.targets.get(node.id);
  if (!target) return;

  const file = path.join(provider.model.sourceDir, target.sourceDir, 'CMakeLists.txt');
  if (!fs.existsSync(file)) {
    vscode.window.showWarningMessage('Could not find ' + file);
    return;
  }
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document, { preview: true });

  // Jump to wherever the target is declared, if we can spot it.
  const pattern = new RegExp('(add_executable|add_library)\\s*\\(\\s*' + escapeRegExp(target.name) + '\\b', 'i');
  for (let line = 0; line < document.lineCount; line++) {
    if (pattern.test(document.lineAt(line).text)) {
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      break;
    }
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function copyName(node) {
  if (!provider.model || !node || !node.id) return;
  const target = provider.model.targets.get(node.id);
  if (target) await vscode.env.clipboard.writeText(target.name);
}

module.exports = { activate, deactivate };

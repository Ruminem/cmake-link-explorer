'use strict';

const vscode = require('vscode');
const path = require('path');
const fileApi = require('./fileApi');

const ICON_BY_TYPE = {
  EXECUTABLE: 'rocket',
  STATIC_LIBRARY: 'package',
  SHARED_LIBRARY: 'library',
  MODULE_LIBRARY: 'library',
  OBJECT_LIBRARY: 'symbol-namespace',
  INTERFACE_LIBRARY: 'symbol-interface',
  UTILITY: 'tools'
};

const SHORT_TYPE = {
  EXECUTABLE: 'exe',
  STATIC_LIBRARY: 'static',
  SHARED_LIBRARY: 'shared',
  MODULE_LIBRARY: 'module',
  OBJECT_LIBRARY: 'object',
  INTERFACE_LIBRARY: 'interface',
  UTILITY: 'utility'
};

/**
 * Tree nodes come in three shapes:
 *   target  - a CMake target. At the root it shows all its groups; inside a
 *             "links"/"linked by" group it keeps following that one direction,
 *             so expanding repeatedly walks the chain.
 *   group   - the "links", "linked by" and "external" headers under a root target.
 *   library - an external library leaf.
 */
class TargetTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.model = null;
    this.error = null;
    this.rootNodes = [];
  }

  setModel(model) {
    this.model = model;
    this.error = null;
    this.rootNodes = [];
    this._onDidChangeTreeData.fire();
  }

  setError(message) {
    this.model = null;
    this.error = message;
    this.rootNodes = [];
    this._onDidChangeTreeData.fire();
  }

  refresh() {
    this.rootNodes = [];
    this._onDidChangeTreeData.fire();
  }

  get showUtility() {
    return vscode.workspace.getConfiguration('cmakeLinkExplorer').get('showUtilityTargets', false);
  }

  get showExternal() {
    return vscode.workspace.getConfiguration('cmakeLinkExplorer').get('showExternalLibraries', true);
  }

  get showTransitive() {
    return vscode.workspace.getConfiguration('cmakeLinkExplorer').get('showTransitiveDependencies', false);
  }

  visibleTargets() {
    if (!this.model) return [];
    const all = Array.from(this.model.targets.values());
    const kept = this.showUtility ? all : all.filter(fileApi.isLinkable);
    return kept.sort((a, b) => a.name.localeCompare(b.name));
  }

  getParent(node) {
    return node.parent || undefined;
  }

  getChildren(node) {
    if (!this.model) return [];

    if (!node) {
      this.rootNodes = this.visibleTargets().map((target) => ({
        kind: 'target',
        direction: 'root',
        id: target.id,
        parent: null
      }));
      return this.rootNodes;
    }

    if (node.kind === 'group') return this.groupChildren(node);
    if (node.kind === 'target') return this.targetChildren(node);
    return [];
  }

  targetChildren(node) {
    const target = this.model.targets.get(node.id);
    if (!target) return [];

    // Inside a directional chain we keep following the same direction only.
    if (node.direction === 'forward' || node.direction === 'reverse') {
      return this.neighbourNodes(node, node.direction);
    }

    const groups = [];
    const forward = this.neighbourIds(target.id, 'forward');
    const reverse = this.neighbourIds(target.id, 'reverse');

    if (forward.length) groups.push({ kind: 'group', group: 'forward', id: target.id, parent: node });
    if (reverse.length) groups.push({ kind: 'group', group: 'reverse', id: target.id, parent: node });
    if (this.showExternal && target.externalLibraries.length) {
      groups.push({ kind: 'group', group: 'external', id: target.id, parent: node });
    }
    return groups;
  }

  groupChildren(node) {
    if (node.group === 'external') {
      const target = this.model.targets.get(node.id);
      return target.externalLibraries.map((name) => ({
        kind: 'library',
        name: name,
        parent: node
      }));
    }
    return this.neighbourNodes(node, node.group);
  }

  neighbourIds(targetId, direction) {
    const target = this.model.targets.get(targetId);
    const ids =
      direction === 'forward'
        ? (this.showTransitive ? target.dependencyIds : target.directDependencyIds)
        : this.model.linkedBy.get(targetId) || [];
    const visible = this.showUtility ? ids : ids.filter((id) => fileApi.isLinkable(this.model.targets.get(id)));
    return visible.sort((a, b) =>
      this.model.targets.get(a).name.localeCompare(this.model.targets.get(b).name)
    );
  }

  neighbourNodes(node, direction) {
    return this.neighbourIds(node.id, direction).map((id) => ({
      kind: 'target',
      direction: direction,
      id: id,
      parent: node
    }));
  }

  getTreeItem(node) {
    if (node.kind === 'library') return this.libraryItem(node);
    if (node.kind === 'group') return this.groupItem(node);
    return this.targetItem(node);
  }

  targetItem(node) {
    const target = this.model.targets.get(node.id);
    const hasChildren =
      node.direction === 'root'
        ? this.targetChildren(node).length > 0
        : this.neighbourIds(node.id, node.direction).length > 0;

    const item = new vscode.TreeItem(
      target.name,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    item.id = nodeKey(node);
    item.description = SHORT_TYPE[target.type] || target.type.toLowerCase();
    item.iconPath = new vscode.ThemeIcon(ICON_BY_TYPE[target.type] || 'symbol-misc');
    item.contextValue = 'target';
    item.tooltip = this.targetTooltip(target);
    item.command = {
      command: 'cmakeLinkExplorer.openCMakeLists',
      title: 'Open CMakeLists.txt',
      arguments: [node]
    };
    return item;
  }

  targetTooltip(target) {
    const forward = this.neighbourIds(target.id, 'forward').length;
    const reverse = this.neighbourIds(target.id, 'reverse').length;
    const transitive = target.dependencyIds.length;
    const lines = [
      '**' + target.name + '**  _' + (SHORT_TYPE[target.type] || target.type) + '_',
      '',
      '- links: ' + forward + (transitive > forward ? '  (' + transitive + ' including transitive)' : ''),
      '- linked by: ' + reverse,
      '- external libs: ' + target.externalLibraries.length,
      '- source files: ' + target.sourceCount
    ];
    if (target.sourceDir) lines.push('- defined in: `' + target.sourceDir + '/CMakeLists.txt`');
    if (target.nameOnDisk) lines.push('- produces: `' + target.nameOnDisk + '`');
    return new vscode.MarkdownString(lines.join('\n'));
  }

  groupItem(node) {
    const count =
      node.group === 'external'
        ? this.model.targets.get(node.id).externalLibraries.length
        : this.neighbourIds(node.id, node.group).length;

    const labels = {
      forward: 'links →',
      reverse: 'linked by ←',
      external: 'external'
    };
    const icons = { forward: 'arrow-right', reverse: 'arrow-left', external: 'link-external' };

    const item = new vscode.TreeItem(labels[node.group], vscode.TreeItemCollapsibleState.Collapsed);
    item.id = nodeKey(node);
    item.description = String(count);
    item.iconPath = new vscode.ThemeIcon(icons[node.group]);
    item.contextValue = 'group';
    return item;
  }

  libraryItem(node) {
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.id = nodeKey(node);
    item.iconPath = new vscode.ThemeIcon('link-external');
    item.contextValue = 'library';
    item.tooltip = node.name;
    return item;
  }
}

// TreeItem ids must be unique across the whole tree, and the same node must keep
// the same id between refreshes for reveal() and expansion state to work.
function nodeKey(node) {
  const parentKey = node.parent ? nodeKey(node.parent) + '/' : '';
  if (node.kind === 'library') return parentKey + 'lib:' + node.name;
  if (node.kind === 'group') return parentKey + 'group:' + node.group;
  return parentKey + 'target:' + node.direction + ':' + node.id;
}

module.exports = { TargetTreeProvider, SHORT_TYPE };

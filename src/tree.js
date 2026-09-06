'use strict';

const vscode = require('vscode');
const fileApi = require('./fileApi');
const { formatBytes } = require('./mapFile');

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

// A tree view has no columns, so anything that needs to be readable at a glance
// has to fit in the one description string next to the label.
// One collator reused everywhere: String.prototype.localeCompare builds a new
// one on every call, which is most of the cost of sorting a large target list.
const byName = new Intl.Collator(undefined, { sensitivity: 'variant' });

const FORWARD_MARK = '→';
const REVERSE_MARK = '←';

const FORWARD_COLOR = new vscode.ThemeColor('charts.blue');
const REVERSE_COLOR = new vscode.ThemeColor('charts.orange');

/**
 * Nodes are either a target or the "external" bucket hanging off one.
 *
 * A target at the root shows both directions at once. A target reached by
 * following one direction keeps going that way only, so expanding repeatedly
 * walks a chain instead of fanning out.
 */
class TargetTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.model = null;
    this.error = null;
    this.rootNodes = [];
    // targetId -> {size, dynamic, objects}, from a loaded linker map. Null until
    // a map is opened, and the size column simply does not appear.
    this.sizes = null;
    // neighbourIds sorts, and the sort comparator and every rendered row ask for
    // the same lists over and over; on a large project that was tens of
    // thousands of sorts to draw one screen.
    this.neighbourCache = new Map();
  }

  /** Attaches per-target sizes worked out from a linker map, or null to drop them. */
  setSizes(sizes) {
    this.sizes = sizes && sizes.size ? sizes : null;
    this.rootNodes = [];
    this._onDidChangeTreeData.fire();
  }

  sizeOf(targetId) {
    return this.sizes ? this.sizes.get(targetId) : undefined;
  }

  setModel(model) {
    this.model = model;
    this.error = null;
    this.rootNodes = [];
    this.neighbourCache = new Map();
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
    // Settings change which neighbours are visible, so the lists go with them.
    this.neighbourCache = new Map();
    this._onDidChangeTreeData.fire();
  }

  config(key, fallback) {
    return vscode.workspace.getConfiguration('cmakeLinkExplorer').get(key, fallback);
  }

  get showUtility() { return this.config('showUtilityTargets', false); }
  get showExternal() { return this.config('showExternalLibraries', true); }
  get showTransitive() { return this.config('showTransitiveDependencies', false); }
  get sortOrder() { return this.config('sortTargets', 'structure'); }

  /**
   * Default order puts what the project produces first, then the libraries the
   * most things lean on. Alphabetical is available but makes a large project
   * look like an undifferentiated wall of names.
   */
  /**
   * How many rows the tree would show. visibleTargets() sorts, and the sort is
   * wasted when the caller only wants the count -- which is all the status bar
   * ever wanted. Five milliseconds a call at two thousand targets, and it now
   * refreshes on a timer while the user types.
   */
  visibleCount() {
    if (!this.model) return 0;
    if (this.showUtility) return this.model.targets.size;
    let count = 0;
    for (const target of this.model.targets.values()) {
      if (fileApi.isLinkable(target)) count++;
    }
    return count;
  }

  visibleTargets() {
    if (!this.model) return [];
    const all = Array.from(this.model.targets.values());
    const kept = this.showUtility ? all : all.filter(fileApi.isLinkable);

    if (this.sortOrder === 'name') {
      return kept.sort((a, b) => byName.compare(a.name, b.name));
    }
    // Sorting by size only makes sense once a map has been loaded; without one
    // every target would compare equal and the order would look arbitrary.
    if (this.sortOrder === 'size' && this.sizes) {
      return kept.sort((a, b) => {
        const size = (t) => (this.sizeOf(t.id) || { size: -1 }).size;
        return size(b) - size(a) || byName.compare(a.name, b.name);
      });
    }
    return kept.sort((a, b) => {
      const executable = (t) => (t.type === 'EXECUTABLE' ? 0 : 1);
      if (executable(a) !== executable(b)) return executable(a) - executable(b);
      const dependents = (t) => this.neighbourIds(t.id, 'reverse').length;
      const diff = dependents(b) - dependents(a);
      if (diff) return diff;
      return byName.compare(a.name, b.name);
    });
  }

  getParent(node) {
    return node.parent || undefined;
  }

  getChildren(node) {
    if (!this.model) return [];

    if (!node) {
      this.rootNodes = this.visibleTargets().map((target) => ({
        kind: 'target', direction: 'root', id: target.id, parent: null
      }));
      return this.rootNodes;
    }

    if (node.kind === 'external') {
      return this.model.targets.get(node.id).externalLibraries
        .map((name) => ({ kind: 'library', name, parent: node }));
    }

    if (node.kind !== 'target') return [];

    // Inside a chain, keep following the same direction.
    if (node.direction !== 'root') return this.neighbourNodes(node, node.direction);

    // At the root, both directions are listed directly rather than behind a
    // "links"/"linked by" folder: one expand instead of two.
    const children = [
      ...this.neighbourNodes(node, 'forward'),
      ...this.neighbourNodes(node, 'reverse')
    ];
    const target = this.model.targets.get(node.id);
    if (this.showExternal && target.externalLibraries.length) {
      children.push({ kind: 'external', id: node.id, parent: node });
    }
    return children;
  }

  neighbourIds(targetId, direction) {
    // The settings decide what is in the list, so they belong in the key. Relying
    // on refresh() being called first makes the cache quietly wrong the moment
    // some other path changes a setting.
    const key = (this.showTransitive ? 'T' : 't') + (this.showUtility ? 'U' : 'u') +
                direction + ':' + targetId;
    const cached = this.neighbourCache.get(key);
    if (cached) return cached;

    const target = this.model.targets.get(targetId);
    const ids = direction === 'forward'
      ? (this.showTransitive ? target.dependencyIds : target.directDependencyIds)
      : (this.model.linkedBy.get(targetId) || []);
    const visible = (this.showUtility
      ? ids.slice()
      : ids.filter((id) => fileApi.isLinkable(this.model.targets.get(id))))
      .sort((a, b) =>
        byName.compare(this.model.targets.get(a).name, this.model.targets.get(b).name));

    this.neighbourCache.set(key, visible);
    return visible;
  }

  neighbourNodes(node, direction) {
    return this.neighbourIds(node.id, direction).map((id) => ({
      kind: 'target', direction, id, parent: node
    }));
  }

  rootChildCount(targetId) {
    const external = this.showExternal &&
      this.model.targets.get(targetId).externalLibraries.length ? 1 : 0;
    return this.neighbourIds(targetId, 'forward').length +
           this.neighbourIds(targetId, 'reverse').length + external;
  }

  // Counts shown on the row itself, so the shape of the graph is visible without
  // expanding anything: "→3 ←9" is a hub, "←9" alone is a leaf everything uses.
  countsFor(targetId) {
    const forward = this.neighbourIds(targetId, 'forward').length;
    const reverse = this.neighbourIds(targetId, 'reverse').length;
    const parts = [];
    if (forward) parts.push(FORWARD_MARK + forward);
    if (reverse) parts.push(REVERSE_MARK + reverse);
    return parts.join(' ');
  }

  // How much of the linked image this target accounts for. A shared library is
  // not in the image -- what shows up is a handful of import stubs -- so
  // reporting those bytes as its size would be wrong by orders of magnitude.
  sizeLabel(targetId) {
    const row = this.sizeOf(targetId);
    if (!row) return '';
    return row.dynamic ? 'dynamic' : formatBytes(row.size);
  }

  // Tooltips are markdown built from several lookups, and building one for every
  // row on every redraw is most of the cost of drawing a large list. VS Code
  // asks for them only when a row is actually hovered.
  resolveTreeItem(item, node) {
    if (node.kind === 'target' && this.model) {
      item.tooltip = this.targetTooltip(this.model.targets.get(node.id), node.direction);
    }
    return item;
  }

  getTreeItem(node) {
    if (node.kind === 'library') return this.libraryItem(node);
    if (node.kind === 'external') return this.externalItem(node);
    return this.targetItem(node);
  }

  targetItem(node) {
    const target = this.model.targets.get(node.id);
    const root = node.direction === 'root';
    // Counting is enough to decide whether the row expands; building the child
    // nodes here would allocate them again for every row on every redraw.
    const onward = root ? this.rootChildCount(node.id)
                        : this.neighbourIds(node.id, node.direction).length;

    const item = new vscode.TreeItem(
      target.name,
      onward ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);

    item.id = nodeKey(node);
    item.contextValue = 'target';

    if (root) {
      // Type is carried by the icon, leaving the description free for counts.
      item.iconPath = new vscode.ThemeIcon(ICON_BY_TYPE[target.type] || 'symbol-misc');
      item.description = [this.countsFor(node.id), this.sizeLabel(node.id)]
        .filter(Boolean).join('   ');
    } else {
      const forward = node.direction === 'forward';
      item.iconPath = new vscode.ThemeIcon(
        forward ? 'arrow-small-right' : 'arrow-small-left',
        forward ? FORWARD_COLOR : REVERSE_COLOR);
      const mark = forward ? FORWARD_MARK : REVERSE_MARK;
      item.description = (SHORT_TYPE[target.type] || target.type.toLowerCase()) +
                         (onward ? '   ' + mark + onward : '');
    }

    item.command = {
      command: 'cmakeLinkExplorer.openCMakeLists',
      title: 'Open CMakeLists.txt',
      arguments: [node]
    };
    return item;
  }

  targetTooltip(target, direction) {
    const forward = this.neighbourIds(target.id, 'forward').length;
    const reverse = this.neighbourIds(target.id, 'reverse').length;
    const transitive = target.dependencyIds.length;

    const lines = [
      '**' + target.name + '**  _' + (SHORT_TYPE[target.type] || target.type) + '_',
      ''
    ];
    if (direction === 'forward') lines.push('_reached by following links_', '');
    if (direction === 'reverse') lines.push('_reached by following dependents_', '');

    lines.push('- links ' + FORWARD_MARK + ' ' + forward +
               (transitive > forward ? '  (' + transitive + ' including transitive)' : ''));
    lines.push('- linked by ' + REVERSE_MARK + ' ' + reverse);
    const size = this.sizeOf(target.id);
    if (size) {
      lines.push(size.dynamic
        ? '- linked dynamically; only ' + formatBytes(size.size) +
          ' of import stubs are in the image'
        : '- in the image: ' + formatBytes(size.size) +
          ' (' + size.objects.length + ' object' + (size.objects.length === 1 ? '' : 's') + ')');
    }
    if (target.externalLibraries.length) {
      lines.push('- external libraries: ' + target.externalLibraries.length);
    }
    lines.push('- source files: ' + target.sourceCount);
    if (target.sourceDir) lines.push('- defined in `' + target.sourceDir + '/CMakeLists.txt`');
    if (target.nameOnDisk) lines.push('- produces `' + target.nameOnDisk + '`');
    return new vscode.MarkdownString(lines.join('\n'));
  }

  externalItem(node) {
    const target = this.model.targets.get(node.id);
    const item = new vscode.TreeItem('external', vscode.TreeItemCollapsibleState.Collapsed);
    item.id = nodeKey(node);
    item.description = String(target.externalLibraries.length);
    item.iconPath = new vscode.ThemeIcon('link-external');
    item.contextValue = 'external';
    item.tooltip = new vscode.MarkdownString(
      'Libraries from outside the project\n\n' +
      target.externalLibraries.map((l) => '- `' + l + '`').join('\n'));
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

// Ids must be unique across the tree and stable between refreshes, otherwise
// reveal() and the expanded/collapsed state stop working.
function nodeKey(node) {
  const parentKey = node.parent ? nodeKey(node.parent) + '/' : '';
  if (node.kind === 'library') return parentKey + 'lib:' + node.name;
  if (node.kind === 'external') return parentKey + 'external';
  return parentKey + 'target:' + node.direction + ':' + node.id;
}

module.exports = { TargetTreeProvider, SHORT_TYPE, FORWARD_MARK, REVERSE_MARK };

'use strict';

const vscode = require('vscode');
const path = require('path');
const buildLog = require('./buildLog');
const { percent, shortenPath } = require('./mapTree');

const { formatMs } = buildLog;

function signed(value) {
  return (value > 0 ? '+' : '') + formatMs(value);
}

const KIND_ICON = {
  compile: 'file-code',
  archive: 'archive',
  link: 'link',
  other: 'gear'
};

const KIND_LABEL = {
  compile: 'compiling',
  archive: 'archiving',
  link: 'linking',
  other: 'everything else'
};

// What an edge is called on screen. ninja names an edge by its outputs, and a
// compile step's output says more than its input ever would: the .dir tells you
// the target and the stem tells you the source.
function edgeLabel(edge) {
  const first = edge.outputs[0];
  const label = shortenPath(first);
  return edge.outputs.length > 1 ? label + '  (+' + (edge.outputs.length - 1) + ')' : label;
}

/**
 * Renders one parsed ninja build log, or the difference between two of them.
 *
 * The linker map answers what is eating the size; this answers what is eating
 * the time. Same shape, so the two views read the same way.
 */
class BuildTimeTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.model = null;
    this.comparison = null; // {before, after, diff}
    // [{id, name, type, row}] worked out by the extension, which is the only
    // side that has the target graph. Null when no build tree is loaded.
    this.targetRows = null;
  }

  showLog(model, targetRows) {
    this.model = model;
    this.comparison = null;
    this.targetRows = targetRows && targetRows.length ? targetRows : null;
    this._onDidChangeTreeData.fire();
  }

  /** Re-attaches attribution after the target graph reloads under an open log. */
  setTargetRows(targetRows) {
    this.targetRows = targetRows && targetRows.length ? targetRows : null;
    this._onDidChangeTreeData.fire();
  }

  showDiff(before, after) {
    this.model = null;
    this.targetRows = null;
    this.comparison = { before, after, diff: buildLog.diff(before, after) };
    this._onDidChangeTreeData.fire();
  }

  clear() {
    this.model = null;
    this.comparison = null;
    this.targetRows = null;
    this._onDidChangeTreeData.fire();
  }

  get edgeLimit() {
    return vscode.workspace.getConfiguration('cmakeLinkExplorer').get('slowestEdgeLimit', 50);
  }

  getParent(node) {
    return node.parent || undefined;
  }

  getChildren(node) {
    if (this.comparison) return this.diffChildren(node);
    if (this.model) return this.logChildren(node);
    return [];
  }

  // ------------------------------------------------------------ single log

  logChildren(node) {
    const model = this.model;

    if (!node) {
      const groups = [{ kind: 'total', parent: null }];
      if (this.targetRows) groups.push({ kind: 'group', group: 'targets', parent: null });
      groups.push({ kind: 'group', group: 'slowest', parent: null });
      groups.push({ kind: 'group', group: 'kinds', parent: null });
      // One build is the common case and a list of one is noise.
      if (model.builds.length > 1) groups.push({ kind: 'group', group: 'builds', parent: null });
      return groups;
    }

    if (node.kind === 'group') {
      switch (node.group) {
        case 'targets':
          return this.targetRows.map((target) => ({ kind: 'target', target, parent: node }));
        case 'slowest':
          return model.edges.slice(0, this.edgeLimit)
            .map((edge) => ({ kind: 'edge', edge, parent: node }));
        case 'kinds':
          return [...model.totals.byKind.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name, ms]) => ({ kind: 'kindRow', name, ms, parent: node }));
        case 'builds':
          return model.builds.slice().reverse()
            .map((build) => ({ kind: 'build', build, parent: node }));
        default:
          return [];
      }
    }

    if (node.kind === 'target') {
      return node.target.row.edges.map((edge) => ({ kind: 'edge', edge, parent: node }));
    }

    if (node.kind === 'build') {
      return node.build.entries.slice()
        .sort((a, b) => b.duration - a.duration)
        .map((entry) => ({ kind: 'entry', entry, parent: node }));
    }

    return [];
  }

  // ------------------------------------------------------------ diff

  diffChildren(node) {
    if (!node) {
      return [
        { kind: 'diffTotal', parent: null },
        { kind: 'group', group: 'diffOutputs', parent: null }
      ];
    }
    if (node.kind === 'group') {
      return this.comparison.diff.outputs
        .slice(0, this.edgeLimit)
        .map((row) => ({ kind: 'diffRow', row, parent: node }));
    }
    return [];
  }

  // ------------------------------------------------------------ items

  getTreeItem(node) {
    switch (node.kind) {
      case 'total': return this.totalItem();
      case 'group': return this.groupItem(node);
      case 'target': return this.targetItem(node);
      case 'edge': return this.edgeItem(node);
      case 'entry': return this.entryItem(node);
      case 'kindRow': return this.kindItem(node);
      case 'build': return this.buildItem(node);
      case 'diffTotal': return this.diffTotalItem();
      case 'diffRow': return this.diffRowItem(node);
      default: return new vscode.TreeItem('?');
    }
  }

  totalItem() {
    const { totals, builds } = this.model;
    const item = new vscode.TreeItem('last build', vscode.TreeItemCollapsibleState.None);
    item.id = 'time:total';
    // The wait comes first because it is the number the user actually felt.
    item.description = formatMs(totals.wall) + '   ·   ' +
                       formatMs(totals.cpu) + ' of work across ' + totals.edges + ' steps';
    item.iconPath = new vscode.ThemeIcon('watch');
    const lines = [
      '**' + path.basename(this.model.path) + '**  ninja log v' + this.model.version, '',
      '- last build took: ' + formatMs(totals.wall),
      '- work in it, added up: ' + formatMs(totals.cpu),
      '- steps: ' + totals.edges,
      '- builds recorded: ' + builds.length
    ];
    // Two numbers that differ by a lot is the parallelism working, not an error.
    // Saying so once here saves explaining it in every row below.
    if (totals.wall && totals.cpu > totals.wall) {
      lines.push('', 'The build finished in less time than its steps add up to ' +
                 'because ninja ran several at once.');
    }
    if (this.model.unverifiedVersion) {
      lines.push('', '_This log is v' + this.model.version + ', newer than any version ' +
                 'checked against real ninja output. The columns are read as usual._');
    }
    if (this.model.malformed) {
      lines.push('', '_' + this.model.malformed + ' line(s) skipped: not five columns._');
    }
    item.tooltip = new vscode.MarkdownString(lines.join('\n'));
    return item;
  }

  groupItem(node) {
    const labels = {
      targets: 'by target',
      slowest: 'slowest steps',
      kinds: 'by kind of work',
      builds: 'builds in this log',
      diffOutputs: 'by step'
    };
    const icons = {
      targets: 'package',
      slowest: 'flame',
      kinds: 'list-tree',
      builds: 'history',
      diffOutputs: 'flame'
    };

    const item = new vscode.TreeItem(labels[node.group], vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'timegroup:' + node.group;
    item.iconPath = new vscode.ThemeIcon(icons[node.group]);
    item.contextValue = 'buildTimeGroup';

    if (node.group === 'targets') {
      item.description = this.targetRows.length + ' attributed';
    }
    if (node.group === 'slowest') {
      const shown = Math.min(this.edgeLimit, this.model.edges.length);
      item.description = shown < this.model.edges.length
        ? 'top ' + shown + ' of ' + this.model.edges.length
        : String(this.model.edges.length);
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }
    if (node.group === 'builds') {
      item.description = this.model.builds.length + ', newest first';
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }
    return item;
  }

  targetItem(node) {
    const { id, name, type, row } = node.target;
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = 'timetarget:' + id;
    item.description = formatMs(row.total) + '   ' + percent(row.total, this.model.totals.cpu);
    item.iconPath = new vscode.ThemeIcon('package');
    item.contextValue = 'buildTimeTarget';
    item.tooltip = new vscode.MarkdownString(
      ['**' + name + '**  _' + (type || '').toLowerCase() + '_', '',
       '- compiling: ' + formatMs(row.compile),
       '- linking: ' + formatMs(row.link),
       '- total: ' + formatMs(row.total) + ' (' + percent(row.total, this.model.totals.cpu) + ')',
       '- steps: ' + row.edges.length,
       row.slowest ? '- slowest: `' + row.slowest.outputs[0] + '` ' +
                     formatMs(row.slowest.duration) : ''
      ].filter(Boolean).join('\n'));
    return item;
  }

  edgeItem(node) {
    const { edge } = node;
    const item = new vscode.TreeItem(edgeLabel(edge), vscode.TreeItemCollapsibleState.None);
    item.id = 'timeedge:' + (node.parent ? node.parent.kind + ':' : '') + edge.key;
    item.description = formatMs(edge.duration) + '   ' +
                       percent(edge.duration, this.model.totals.cpu);
    item.iconPath = new vscode.ThemeIcon(KIND_ICON[edge.kind] || 'gear');
    item.contextValue = 'buildTimeEdge';
    item.tooltip = new vscode.MarkdownString(
      ['**' + KIND_LABEL[edge.kind] + '** — ' + formatMs(edge.duration), '',
       ...edge.outputs.map((output) => '- `' + output + '`'),
       edge.outputs.length > 1
         ? '\nOne step, several outputs. ninja records a line for each; it is counted once.'
         : ''
      ].filter(Boolean).join('\n'));
    return item;
  }

  entryItem(node) {
    const { entry } = node;
    const item = new vscode.TreeItem(shortenPath(entry.output), vscode.TreeItemCollapsibleState.None);
    item.id = 'timeentry:' + node.parent.build.index + ':' + entry.output;
    item.description = formatMs(entry.duration);
    item.iconPath = new vscode.ThemeIcon(KIND_ICON[entry.kind] || 'gear');
    return item;
  }

  kindItem(node) {
    const item = new vscode.TreeItem(KIND_LABEL[node.name] || node.name,
                                     vscode.TreeItemCollapsibleState.None);
    item.id = 'timekind:' + node.name;
    item.description = formatMs(node.ms) + '   ' + percent(node.ms, this.model.totals.cpu);
    item.iconPath = new vscode.ThemeIcon(KIND_ICON[node.name] || 'gear');
    return item;
  }

  buildItem(node) {
    const { build } = node;
    const newest = build.index === this.model.builds.length - 1;
    const item = new vscode.TreeItem(newest ? 'most recent' : 'build ' + (build.index + 1),
                                     vscode.TreeItemCollapsibleState.Collapsed);
    item.id = 'timebuild:' + build.index;
    item.description = formatMs(build.wall) + '   ' + build.entries.length + ' steps';
    item.iconPath = new vscode.ThemeIcon(newest ? 'circle-filled' : 'circle-outline');
    item.tooltip = new vscode.MarkdownString(
      ['**' + (newest ? 'most recent build' : 'build ' + (build.index + 1)) + '**', '',
       '- took: ' + formatMs(build.wall),
       '- steps: ' + build.entries.length, '',
       'ninja appends to this file and never clears it, so older runs stay ' +
       'here. Each step is reported with its newest timing.'].join('\n'));
    return item;
  }

  diffTotalItem() {
    const { diff, before, after } = this.comparison;
    const item = new vscode.TreeItem('total work', vscode.TreeItemCollapsibleState.None);
    item.id = 'timediff:total';
    item.description = formatMs(diff.total.before) + ' → ' + formatMs(diff.total.after) +
                       '   ' + signed(diff.total.delta);
    item.iconPath = new vscode.ThemeIcon(diff.total.delta > 0 ? 'arrow-up' : 'arrow-down');
    item.tooltip = new vscode.MarkdownString(
      ['**' + path.basename(before.path) + '** → **' + path.basename(after.path) + '**', '',
       '- before: ' + formatMs(diff.total.before),
       '- after: ' + formatMs(diff.total.after),
       '- change: ' + signed(diff.total.delta), '',
       'Steps neither log agrees on are listed below; unchanged ones are left out.'
      ].join('\n'));
    return item;
  }

  diffRowItem(node) {
    const { row } = node;
    const item = new vscode.TreeItem(shortenPath(row.key), vscode.TreeItemCollapsibleState.None);
    item.id = 'timediffrow:' + row.key;
    item.description = signed(row.delta) + '     ' +
                       formatMs(row.before) + ' → ' + formatMs(row.after);
    item.iconPath = new vscode.ThemeIcon(
      row.status === 'added' ? 'diff-added'
        : row.status === 'removed' ? 'diff-removed'
          : row.delta > 0 ? 'arrow-up' : 'arrow-down');
    item.tooltip = new vscode.MarkdownString(
      ['**' + row.key + '**  _' + row.status + '_', '',
       '- before: ' + formatMs(row.before),
       '- after: ' + formatMs(row.after),
       '- change: ' + signed(row.delta)].join('\n'));
    return item;
  }
}

module.exports = { BuildTimeTreeProvider, edgeLabel, signed };

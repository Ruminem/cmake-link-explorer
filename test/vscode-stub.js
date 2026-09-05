'use strict';

// The pieces of the vscode API that src/tree.js touches, so the tree logic can be
// exercised with plain node. The real API is covered by test/integration, which
// runs inside an actual extension host.

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState === undefined ? 0 : collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) { this.id = id; this.color = color; }
}

class ThemeColor {
  constructor(id) { this.id = id; }
}

class MarkdownString {
  constructor(value) { this.value = value; }
}

class EventEmitter {
  constructor() {
    this._handlers = [];
    this.event = (handler) => {
      this._handlers.push(handler);
      return { dispose: () => {} };
    };
  }
  fire(value) { this._handlers.forEach((h) => h(value)); }
}

const overrides = {};

module.exports = {
  TreeItem,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  EventEmitter,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) =>
        Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback
    })
  },
  // Test-only helper for flipping extension settings.
  __setConfig(key, value) { overrides[key] = value; },
  __clearConfig() { for (const key of Object.keys(overrides)) delete overrides[key]; }
};

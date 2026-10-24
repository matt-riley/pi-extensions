import assert from "node:assert/strict";
import { installWorkbench } from "../workbench.mjs";

const actions = {
  up: "up",
  down: "down",
  pageUp: "pageUp",
  pageDown: "pageDown",
  confirm: "enter",
  cancel: "escape",
};
const keys = { matches: (data, action) => data === actions[action.split(".").at(-1)] };
class Input {
  value = "";
  setValue(value) {
    this.value = value;
  }
  getValue() {
    return this.value;
  }
  handleInput(data) {
    this.value = data === "backspace" ? this.value.slice(0, -1) : this.value + data;
  }
  render() {
    return ["> " + this.value];
  }
  invalidate() {}
}
class SelectList {
  index = 0;
  constructor(items) {
    this.items = items;
  }
  setSelectedIndex(index) {
    this.index = Math.max(0, index);
  }
  getSelectedItem() {
    return this.items[this.index];
  }
  handleInput(data) {
    if (data === "escape") return this.onCancel?.();
    if (data === "enter") return this.items.length && this.onSelect?.(this.getSelectedItem());
    if (!this.items.length) return;
    if (data === "up") this.index = (this.index + this.items.length - 1) % this.items.length;
    if (data === "down") this.index = (this.index + 1) % this.items.length;
    this.onSelectionChange?.(this.getSelectedItem());
  }
  render() {
    return this.items.length
      ? this.items.map((item, i) => (i === this.index ? "→ " : "  ") + item.label)
      : ["No matches"];
  }
  invalidate() {}
}
class ScrollView {
  scrollTop = 0;
  max = 0;
  constructor(child) {
    this.child = child;
  }
  updateLayout(count, height) {
    this.max = Math.max(0, count - height);
    this.scrollTo(this.scrollTop);
  }
  scrollTo(n) {
    this.scrollTop = Math.max(0, Math.min(this.max, n));
  }
  scrollBy(n) {
    this.scrollTo(this.scrollTop + n);
  }
  scrollToStart() {
    this.scrollTo(0);
  }
  scrollToEnd() {
    this.scrollTo(this.max);
  }
  render(width) {
    return this.child.render(width);
  }
  invalidate() {}
}
export const widgets = {
  Input,
  SelectList,
  ScrollView,
  matchesKey: (data, key) => data === key,
  truncateToWidth: (text, width) => [...text].slice(0, width).join(""),
};

export function terminal(steps = [], rows = 30) {
  const screens = [],
    lifecycle = [];
  const tui = {
    terminal: { rows },
    requestRender() {},
    stop: () => lifecycle.push("stop"),
    start: () => lifecycle.push("start"),
  };
  const custom = async (factory) => {
    let finished = false,
      result;
    const component = await factory(tui, { fg: (_, text) => text }, keys, (value) => {
      finished = true;
      result = value;
    });
    if (!finished) {
      component.focused = true;
      const render = () => {
        const lines = component.render(90);
        screens.push(lines);
        return lines;
      };
      render();
      const step = steps.shift();
      if (typeof step === "function") step(component, render);
      else
        for (const data of step ?? ["escape"]) {
          component.handleInput(data);
          if (!finished) render();
        }
      assert.ok(finished, "every scripted interaction must finish");
    }
    return result;
  };
  return { custom, screens, lifecycle, tui };
}

export function harness(
  steps = [],
  { draft = "keep", mode = "tui", entries = [], busy = false, fail = false, root = "/repo" } = {},
) {
  const commands = {},
    shortcuts = {},
    handlers = {},
    notices = [],
    saved = [],
    calls = [];
  const t = terminal(steps);
  let text = draft;
  const pi = {
    on: (name, fn) => {
      handlers[name] = fn;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    registerShortcut: (key, def) => {
      shortcuts[key] = def;
    },
    appendEntry: (type, data) => saved.push({ type, data }),
    getCommands: () => [
      ...Object.keys(commands).map((name) => ({ name })),
      { name: "review", source: "prompt" },
      { name: "exit" },
      { name: "skill:test", source: "skill" },
    ],
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      if (fail) return { code: 128, stdout: "", stderr: "Git unavailable" };
      if (args.includes("rev-parse")) return { code: 0, stdout: root + "\n" };
      if (args.includes("ls-files")) return { code: 0, stdout: "src/a.txt\0src/b.txt\0" };
      if (args.includes("status")) return { code: 0, stdout: " M src/a.txt\0" };
      if (args.includes("diff"))
        return { code: 0, stdout: "+hello\n+" + String.fromCharCode(27) + "[2J\n" };
      throw Error("Unexpected command");
    },
  };
  const ctx = {
    mode,
    cwd: "/repo",
    isIdle: () => !busy,
    sessionManager: { getBranch: () => entries },
    ui: {
      ...t,
      getEditorText: () => text,
      setEditorText: (value) => {
        text = value;
      },
      setStatus() {},
      notify: (message) => notices.push(message),
      select() {
        throw Error("legacy select is not a live picker");
      },
      editor() {
        throw Error("diffs must never open an editable scratch view");
      },
    },
  };
  installWorkbench(pi, widgets);
  handlers.session_start({}, ctx);
  return { pi, ctx, commands, shortcuts, handlers, notices, saved, calls, ...t, text: () => text };
}

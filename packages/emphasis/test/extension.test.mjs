import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import emphasis from "../index.ts";

const theme = (tag = "") => ({
  fg: (color, text) => `<${tag}${color}>${text}</>`,
  getFgAnsi: (color) => `\u001b[38;fg-${color}m`,
  getBgAnsi: (color) => `\u001b[48;bg-${color}m`,
});

function load(mode = "tui", ui = { theme: theme() }) {
  const handlers = new Map();
  let transformer;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerMarkdownTransformer: (fn) => {
      transformer = fn;
    },
  };
  emphasis(pi);
  const ctx = { mode, ui };
  return {
    start: () => handlers.get("session_start")({}, ctx),
    sections: async (sections = {}) => {
      await handlers.get("before_agent_start")({ systemPromptOptions: { sections } }, ctx);
      return sections;
    },
    draw: (markdown, messageType = "assistant") => transformer(markdown, { messageType }),
    ui,
  };
}

afterEach(() => {
  delete process.env.PI_EMPHASIS;
  delete process.env.PI_EMPHASIS_GUIDANCE;
  delete process.env.PI_EMPHASIS_COLOR;
});

test("in the terminal it draws assistant replies and adds the reply_style section", async () => {
  const session = load();
  await session.start();
  assert.match((await session.sections()).reply_style, /Pills are required, not optional\./);
  assert.equal(session.draw("**x**"), "**<mdLink>x</>**");
});

test("user and thinking text are left as written", async () => {
  const session = load();
  await session.start();
  assert.equal(session.draw("**x**", "user"), "**x**");
  assert.equal(session.draw("**x**", "assistant-thinking"), "**x**");
});

test("RPC mode has a UI but draws nothing, so it is not taught pills", async () => {
  const session = load("rpc");
  await session.start();
  assert.deepEqual(await session.sections({ reply_style: "stale" }), {});
  assert.equal(session.draw("[[Done]]"), "[[Done]]");
});

test("before a session starts nothing is drawn", () => {
  assert.equal(load().draw("[[Done]]"), "[[Done]]");
});

test("PI_EMPHASIS_GUIDANCE=0 keeps the drawing and drops the section", async () => {
  process.env.PI_EMPHASIS_GUIDANCE = "0";
  const session = load();
  await session.start();
  assert.deepEqual(await session.sections(), {});
  assert.equal(session.draw("**x**"), "**<mdLink>x</>**");
});

test("PI_EMPHASIS=0 turns both off", async () => {
  process.env.PI_EMPHASIS = "off";
  const session = load();
  await session.start();
  assert.deepEqual(await session.sections(), {});
  assert.equal(session.draw("**x**"), "**x**");
});

test("PI_EMPHASIS_COLOR picks the bold color", async () => {
  process.env.PI_EMPHASIS_COLOR = "accent";
  const session = load();
  await session.start();
  assert.equal(session.draw("**x**"), "**<accent>x</>**");
});

test("a theme switch recolors the next render", async () => {
  const session = load();
  await session.start();
  assert.equal(session.draw("**x**"), "**<mdLink>x</>**");
  session.ui.theme = theme("new-");
  assert.equal(session.draw("**x**"), "**<new-mdLink>x</>**");
});

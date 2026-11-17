import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import emphasis from "../index.ts";
import { noteUncheckedEdits, resetEvidenceState } from "../../../shared/evidence-state.mjs";

const theme = (tag = "") => ({
  fg: (color, text) => `<${tag}${color}>${text}</>`,
  getFgAnsi: (color) => `\u001b[38;fg-${color}m`,
  getBgAnsi: (color) => `\u001b[48;bg-${color}m`,
});

function load(mode = "tui", ui = { theme: theme() }, cwd = undefined) {
  const handlers = new Map();
  let transformer;
  let options;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerMarkdownTransformer: (fn, opts) => {
      transformer = fn;
      options = opts;
    },
  };
  emphasis(pi);
  const ctx = { mode, ui, cwd };
  return {
    start: () => handlers.get("session_start")({}, ctx),
    sections: async (sections = {}) => {
      await handlers.get("before_agent_start")({ systemPromptOptions: { sections } }, ctx);
      return sections;
    },
    draw: (markdown, messageType = "assistant", extra = {}) =>
      transformer(markdown, { messageType, ...extra }),
    options: () => options,
    ui,
  };
}

afterEach(() => {
  delete process.env.PI_EMPHASIS;
  delete process.env.PI_EMPHASIS_GUIDANCE;
  delete process.env.PI_EMPHASIS_COLOR;
  delete process.env.PI_EMPHASIS_EVIDENCE;
  delete process.env.PI_EMPHASIS_PATHS;
  resetEvidenceState();
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

const visible = (text) =>
  text
    .split("\u001b[")
    .map((part, i) => (i ? part.slice(part.indexOf("m") + 1) : part))
    .join("")
    .replaceAll("\u00a0", " ");

test("extension messages and summaries are drawn; pi before 1.5.1 ignores the option", async () => {
  const session = load();
  await session.start();
  assert.deepEqual(session.options(), { messageTypes: ["assistant", "custom", "summary"] });
  assert.equal(session.draw("**x**", "custom"), "**<mdLink>x</>**");
  assert.equal(session.draw("**x**", "summary"), "**<mdLink>x</>**");
  assert.equal(session.draw("**x**", "changelog"), "**x**");
});

test("a [[Done]] written over edits done-gate saw unchecked is drawn as a question", async () => {
  const session = load();
  await session.start();
  noteUncheckedEdits(false, 1000);
  noteUncheckedEdits(true, 2000);
  noteUncheckedEdits(false, 3000);
  const at = (iso) => visible(session.draw("[[Done]]", "assistant", { timestamp: iso }));
  assert.match(at(new Date(2500).toISOString()), /Done · unchecked/);
  assert.doesNotMatch(at(new Date(3500).toISOString()), /unchecked/);
  noteUncheckedEdits(true);
  assert.match(visible(session.draw("[[Done]]")), /Done · unchecked/, "a live reply is judged now");
  assert.doesNotMatch(visible(session.draw("[[Done]]", "custom")), /unchecked/);
  process.env.PI_EMPHASIS_EVIDENCE = "0";
  assert.doesNotMatch(visible(session.draw("[[Done]]")), /unchecked/);
});

test("a finished reply naming a missing path marks it; a streaming one waits", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "emphasis-ext-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const session = load("tui", { theme: theme() }, cwd);
  await session.start();
  assert.match(visible(session.draw("see `src/gone.ts`")), /`src\/gone.ts` <warning>.*missing<\/>/);
  assert.doesNotMatch(
    visible(session.draw("see `src/gone2.ts`", "assistant", { isStreaming: true })),
    /missing/,
  );
  process.env.PI_EMPHASIS_PATHS = "0";
  assert.doesNotMatch(visible(session.draw("see `src/gone3.ts`")), /missing/);
});

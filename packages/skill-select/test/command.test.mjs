import assert from "node:assert/strict";
import test from "node:test";
import { installSkillSearch } from "../command.mjs";

function harness({ hasUI = true, choice = 0, skills } = {}) {
  let command,
    roots,
    draft = "Existing draft";
  const messages = [];
  const ctx = {
    cwd: "/scratch/project",
    hasUI,
    mode: hasUI ? "tui" : "rpc",
    ui: {
      select: async (_title, options) => options[choice],
      getEditorText: () => draft,
      setEditorText: (text) => {
        draft = text;
      },
      notify() {},
    },
  };
  installSkillSearch(
    {
      registerCommand: (name, definition) => {
        assert.equal(name, "skill-search");
        command = definition;
      },
      sendMessage: (...args) => messages.push(args),
    },
    {
      env: { PI_SKILL_LIBRARY: "/reviewed/library" },
      discover: async (args) => {
        roots = args.roots;
        return (
          skills ?? [
            { name: "testing", description: "Test behavior", path: '/lib/a "test"/SKILL.md' },
          ]
        );
      },
    },
  );
  return {
    ctx,
    run: (query) => command.handler(query, ctx),
    messages,
    draft: () => draft,
    roots: () => roots,
  };
}

test("skill search prepares a quoted reference while preserving the current draft", async () => {
  const h = harness();
  await h.run("test behavior");
  assert.equal(h.roots()[0], "/reviewed/library");
  assert.ok(h.roots().includes("/scratch/project/.agents/skills"));
  assert.equal(
    h.draft(),
    'Existing draft\n\nRead the skill at "/lib/a \\"test\\"/SKILL.md" and follow it for this task: test behavior',
  );
  assert.equal(h.messages.length, 0);
});

test("cancelling skill selection leaves the draft and conversation untouched", async () => {
  const h = harness({ choice: -1 });
  await h.run("");
  assert.equal(h.draft(), "Existing draft");
  assert.equal(h.messages.length, 0);
});

test("headless skill search reports paths without opening a dialog or starting a turn", async () => {
  const h = harness({ hasUI: false });
  h.ctx.ui.select = () => {
    throw Error("headless dialog");
  };
  await h.run("test");
  assert.match(h.messages[0][0].content, /testing/);
  assert.match(h.messages[0][0].content, /SKILL.md/);
  assert.deepEqual(h.messages[0][1], { triggerTurn: false, deliverAs: "followUp" });
  assert.equal(h.draft(), "Existing draft");
});

test("an unmatched search reports no results without changing the editor", async () => {
  const h = harness({ skills: [] });
  await h.run("unavailable task");
  assert.match(h.messages[0][0].content, /No skill matched.*0 skills searched/);
  assert.equal(h.draft(), "Existing draft");
});

test("RPC clients with UI support still receive a report instead of a terminal picker", async () => {
  const h = harness();
  h.ctx.mode = "rpc";
  h.ctx.ui.select = () => {
    throw Error("RPC picker would wait for a client response");
  };
  await h.run("test");
  assert.equal(h.messages.length, 1);
  assert.equal(h.draft(), "Existing draft");
});

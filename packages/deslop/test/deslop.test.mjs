import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_REPORTS, changeOf, createDeslopState, observeEdit } from "../deslop.mjs";

const SLOP = "It's worth noting that this is a seamless upgrade.";
const PLAIN = "The upgrade keeps your config and takes one command.";
const CWD = "/repo";

const confirmed = async () => ({
  judged: true,
  verdict: "confirmed",
  signals: { worse_for_reader: 0.9 },
});
const dismissed = async () => ({ judged: true, verdict: "dismissed", signals: {} });
const unavailable = async () => ({ judged: false, verdict: null, signals: {} });
const never = async () => {
  throw new Error("the judge must not be asked");
};

const write = (path, content) => ({ toolName: "write", input: { path, content }, cwd: CWD });
const edit = (path, oldText, newText) => ({
  toolName: "edit",
  input: { path, edits: [{ oldText, newText }] },
  cwd: CWD,
});

test("changeOf reads write content and both edit input shapes", () => {
  assert.deepEqual(changeOf("write", { content: "a" }), { before: "", after: "a" });
  assert.deepEqual(changeOf("edit", { oldText: "a", newText: "b" }), { before: "a", after: "b" });
  assert.deepEqual(
    changeOf("edit", {
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    }),
    { before: "a\n\nc", after: "b\n\nd" },
  );
  assert.equal(changeOf("edit", { path: "a.md" }), null);
  assert.equal(changeOf("write", {}), null);
});

test("only successful prose edits inside the cwd are looked at", async () => {
  const state = createDeslopState();
  const judges = { judgeFindings: never, judgeRewrite: never };
  const skipped = [
    { toolName: "bash", input: { command: `echo "${SLOP}" > README.md` }, cwd: CWD },
    write("src/index.ts", `// ${SLOP}`),
    write("/tmp/notes.md", SLOP),
    write("../other/README.md", SLOP),
    { ...write("README.md", SLOP), isError: true },
    write("README.md", "   "),
  ];
  for (const event of skipped) assert.equal(await observeEdit(state, event, judges), null);
  assert.equal(state.pending.size, 0);
});

test("clean prose costs no TypeSafe request", async () => {
  const state = createDeslopState();
  const note = await observeEdit(state, write("README.md", PLAIN), {
    judgeFindings: never,
    judgeRewrite: never,
  });
  assert.equal(note, null);
});

test("confirmed findings become one note naming the file, the signs and the evidence", async () => {
  const state = createDeslopState();
  const asked = [];
  const note = await observeEdit(state, write("docs/guide.md", SLOP), {
    judgeFindings: async (request) => {
      asked.push(request);
      return confirmed();
    },
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].path, "docs/guide.md");
  assert.equal(asked[0].text, SLOP);
  assert.match(note, /^deslop: the text this edit added to docs\/guide\.md/);
  assert.match(note, /worse_for_reader 0\.90/);
  assert.match(note, /filler phrase \(W1, high\)/);
  assert.match(note, /marketing adjective \(W5, high\)/);
  assert.match(note, /This is advice/);
  assert.equal(state.reports.get("docs/guide.md"), 1);
});

test("an absolute path inside the cwd is tracked by its relative path", async () => {
  const state = createDeslopState();
  await observeEdit(state, write("/repo/README.md", SLOP), { judgeFindings: confirmed });
  assert.deepEqual([...state.pending.keys()], ["README.md"]);
});

test("findings TypeSafe dismisses are dropped silently", async () => {
  const state = createDeslopState();
  assert.equal(
    await observeEdit(state, write("README.md", SLOP), { judgeFindings: dismissed }),
    null,
  );
  assert.equal(state.pending.size, 0);
});

test("without a judge, only a high-severity sign is reported, and says so", async () => {
  const state = createDeslopState();
  const note = await observeEdit(state, write("README.md", SLOP), { judgeFindings: unavailable });
  assert.match(note, /TypeSafe was unavailable, so this is the pattern check alone/);

  const medium = "Moreover, the cache — once warm — serves every read.";
  assert.equal(
    await observeEdit(state, write("NOTES.md", medium), { judgeFindings: unavailable }),
    null,
  );
});

test("verify: false runs the pattern check and asks nothing", async () => {
  const state = createDeslopState();
  const note = await observeEdit(state, write("README.md", SLOP), {
    verify: false,
    judgeFindings: never,
    judgeRewrite: never,
  });
  assert.match(note, /pattern check alone/);
  const fixed = await observeEdit(state, write("README.md", PLAIN), {
    verify: false,
    judgeFindings: never,
    judgeRewrite: never,
  });
  assert.equal(fixed, null);
  assert.equal(state.pending.size, 0);
});

test("an edit is not blamed for patterns already in the text it replaced", async () => {
  const state = createDeslopState();
  const note = await observeEdit(state, edit("README.md", SLOP, `${SLOP} It holds 100 entries.`), {
    judgeFindings: never,
  });
  assert.equal(note, null);
});

test("a rewrite that is clean and keeps the meaning passes silently", async () => {
  const state = createDeslopState();
  await observeEdit(state, write("README.md", SLOP), { judgeFindings: confirmed });
  const asked = [];
  const note = await observeEdit(state, edit("README.md", SLOP, PLAIN), {
    judgeFindings: never,
    judgeRewrite: async (request) => {
      asked.push(request);
      return { judged: true, verdict: "clean", signals: {} };
    },
  });
  assert.equal(note, null);
  assert.deepEqual(asked, [
    { path: "README.md", before: SLOP, after: PLAIN, remainingReportable: false },
  ]);
  assert.equal(state.pending.size, 0);
});

test("a full rewrite with write is compared against the flagged text", async () => {
  const state = createDeslopState();
  await observeEdit(state, write("README.md", SLOP), { judgeFindings: confirmed });
  let before;
  await observeEdit(state, write("README.md", PLAIN), {
    judgeRewrite: async (request) => {
      before = request.before;
      return { judged: true, verdict: "clean", signals: {} };
    },
  });
  assert.equal(before, SLOP);
});

test("a rewrite that changes the meaning is reported with TypeSafe's number", async () => {
  const state = createDeslopState();
  await observeEdit(state, write("README.md", SLOP), { judgeFindings: confirmed });
  const note = await observeEdit(state, edit("README.md", SLOP, "The upgrade is risky."), {
    judgeRewrite: async () => ({
      judged: true,
      verdict: "meaning_changed",
      signals: { meaning_preserved: 0.12 },
    }),
  });
  assert.match(note, /rewrite of README\.md as changing what the text says/);
  assert.match(note, /meaning_preserved 0\.12/);
  assert.match(note, /last deslop note for this file/);
});

test("a rewrite that keeps a pattern lists what is left", async () => {
  const state = createDeslopState();
  await observeEdit(state, write("README.md", SLOP), { judgeFindings: confirmed });
  const half = "This is a seamless upgrade.";
  const note = await observeEdit(state, edit("README.md", SLOP, half), {
    judgeRewrite: async ({ remainingReportable }) => ({
      judged: true,
      verdict: remainingReportable ? "still_slop" : "clean",
      signals: {},
    }),
  });
  assert.match(note, /still carries these patterns/);
  assert.match(note, /marketing adjective/);
  assert.doesNotMatch(note, /filler phrase/);
});

test("a rewrite Jev still reads as formula prose is reported without a list", async () => {
  const state = createDeslopState();
  await observeEdit(state, write("README.md", SLOP), { judgeFindings: confirmed });
  const note = await observeEdit(state, edit("README.md", SLOP, PLAIN), {
    judgeRewrite: async () => ({
      judged: true,
      verdict: "still_slop",
      signals: { still_formulaic: 0.81 },
    }),
  });
  assert.match(note, /still reads the rewrite of README\.md as formula prose/);
  assert.match(note, /still_formulaic 0\.81/);
});

test(`a file gets at most ${MAX_REPORTS} notes however many rewrites fail`, async () => {
  const state = createDeslopState();
  const still = async () => ({ judged: true, verdict: "still_slop", signals: {} });
  const notes = [await observeEdit(state, write("README.md", SLOP), { judgeFindings: confirmed })];
  notes.push(await observeEdit(state, write("README.md", SLOP), { judgeRewrite: still }));
  // Past the budget nothing is reported and nothing is asked.
  for (let round = 0; round < 2; round++) {
    notes.push(
      await observeEdit(state, write("README.md", SLOP), {
        judgeFindings: never,
        judgeRewrite: never,
      }),
    );
  }
  assert.equal(notes.filter(Boolean).length, MAX_REPORTS);
  assert.deepEqual(notes.slice(2), [null, null]);
  assert.match(notes[1], /last deslop note for this file/);
});

test("an edit elsewhere in a flagged file is a first pass, not a rewrite", async () => {
  const state = createDeslopState();
  await observeEdit(state, write("README.md", SLOP), { judgeFindings: confirmed });
  const note = await observeEdit(state, edit("README.md", "Install it.", PLAIN), {
    judgeFindings: never,
    judgeRewrite: never,
  });
  assert.equal(note, null);
  assert.equal(state.reports.get("README.md"), 1);
});

test("clean rewrites do not replenish the per-prompt note budget", async () => {
  const state = createDeslopState();
  const options = { verify: false };
  const notes = [];
  for (let round = 0; round < 4; round++) {
    notes.push(await observeEdit(state, write("README.md", SLOP), options));
    await observeEdit(state, write("README.md", PLAIN), options);
  }
  assert.equal(notes.filter(Boolean).length, MAX_REPORTS);
});

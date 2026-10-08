// Offline tests: a fake `ask` stands in for Jev, keyed on the question ids the
// real code sends. What is pinned: hard rules beat scores, uncertainty keeps,
// a coverage failure re-includes the segment, and nothing unverifiable ships.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import safeCompact from "../index.ts";
import { judgeMoment, relevantLines } from "../judge.mjs";
import {
  buildBoundaryCompaction,
  classify,
  composeHandoff,
  decideTrigger,
  planBoundary,
} from "../plan.mjs";
import { segmentMessages } from "../segment.mjs";

const noul = (value) => ({ type: "noul", noul: value });

/** Canned Jev. `coverage` decides the reverse check; markers steer segment scoring. */
function fakeAsk({ coverage = () => 0.9, faithful = () => 0.9 } = {}) {
  return async ({ state, questions }) => {
    const answers = {};
    if ("disposition" in questions) {
      const text = state.segment.text;
      const constraint = text.includes("ALWAYS");
      const noise = text.includes("NOISE");
      const mid = text.includes("MIDMARK");
      const file = state.segment.tool === "read";
      Object.assign(answers, {
        load_bearing: noul(mid ? 0.9 : noise ? 0.05 : 0.3),
        user_constraint: noul(constraint ? 0.95 : 0.02),
        decision: noul(0.05),
        unresolved: noul(0.02),
        recoverable: noul(file ? 0.9 : 0.1),
        disposition: {
          type: "choice",
          choice: noise ? "drop" : "excerpt",
          confidence: 0.9,
        },
      });
      return { answers };
    }
    if ("rating" in questions) {
      answers.rating = noul(/GOALMARK|retry/.test(state.candidate) ? 0.9 : 0.1);
    } else if ("faithful" in questions) {
      answers.faithful = noul(faithful(state));
    } else if ("covered" in questions) {
      answers.covered = noul(coverage(state.segment, state.handoff));
    }
    return { answers };
  };
}

const user = (text) => ({ role: "user", content: text });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

const transcript = () => [
  user("GOALMARK please fix the retry logic in the client"),
  user("ALWAYS use tabs, never spaces"),
  assistant("NOISE ok sure, looking now"),
  assistant("Reading the client file."),
];

test("segmentMessages pairs tool results with their call's path and offset", () => {
  const segments = segmentMessages([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts", offset: 101 } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "line" }],
    },
  ]);
  assert.equal(segments[1].path, "src/a.ts");
  assert.equal(segments[1].offset, 101);
  assert.equal(segments[1].tool, "read");
});

test("classify: hard rules beat the model, uncertainty keeps", () => {
  const seg = { tool: "read", path: "a.ts", role: "toolResult" };
  const base = { load_bearing: 0.1, recoverable: 0, disposition: "drop", confidence: 0.9 };
  assert.equal(classify(null, seg), "keep_verbatim");
  assert.equal(classify({ ...base, user_constraint: 0.5 }, { role: "user" }), "keep_verbatim");
  assert.equal(
    classify({ ...base, unresolved: 0.5 }, { role: "toolResult", tool: "bash" }),
    "keep_verbatim",
  );
  // Role scoping: a file that merely mentions a bug is not an unresolved error.
  assert.equal(classify({ ...base, unresolved: 0.9, user_constraint: 0.9 }, seg), "drop");
  assert.equal(classify(base, seg), "drop");
  assert.equal(classify({ ...base, confidence: 0.3 }, seg), "excerpt");
  assert.equal(classify({ ...base, load_bearing: 0.8 }, seg), "excerpt");
  assert.equal(classify({ ...base, disposition: "excerpt", recoverable: 0.9 }, seg), "point");
  assert.equal(
    classify({ ...base, disposition: "point" }, { tool: "bash", role: "toolResult" }),
    "excerpt",
  );
});

test("decideTrigger: below soft nothing, above hard always, between defers to the moment", () => {
  const args = { soft: 50, hard: 70 };
  assert.equal(decideTrigger({ ...args, percent: 40 }), "none");
  assert.equal(decideTrigger({ ...args, percent: null }), "none");
  assert.equal(decideTrigger({ ...args, percent: 75 }), "compact");
  assert.equal(decideTrigger({ ...args, percent: 60, moment: { clean: true } }), "compact");
  assert.equal(decideTrigger({ ...args, percent: 60, moment: { clean: false } }), "wait");
  assert.equal(decideTrigger({ ...args, percent: 60 }), "wait");
});

test("judgeMoment: mid-flight or debugging is not clean, unknown is not clean", async () => {
  const ask = (values) => async () => ({
    answers: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, v === null ? noul(null) : noul(v)]),
    ),
  });
  const run = (values) => judgeMoment({ recentText: "x", ask: ask(values) });
  assert.equal((await run({ mid_flight: 0.9, completed: 0.1, debugging: 0.1 })).clean, false);
  assert.equal((await run({ mid_flight: 0.1, completed: 0.1, debugging: 0.9 })).clean, false);
  assert.equal((await run({ mid_flight: 0.1, completed: 0.1, debugging: 0.1 })).clean, true);
  assert.equal((await run({ mid_flight: 0.9, completed: 0.9, debugging: 0.1 })).clean, true);
  assert.equal((await run({ mid_flight: null, completed: 0.9, debugging: 0.1 })).clean, false);
});

test("judgeMoment: a task switch that needs little history is clean even while unfinished", async () => {
  const answer = (v) => ({
    mid_flight: noul(0.1),
    completed: noul(0.1),
    debugging: noul(0.1),
    ...v,
  });
  const run = (values, extra = { currentRequest: "new", previousWork: "old" }) =>
    judgeMoment({ recentText: "x", ...extra, ask: async () => ({ answers: values }) });
  const switched = { switched_gears: noul(0.9), needs_history: { type: "score", score: 0.2 } };
  // Not finished (completed low) but mid_flight above the plain-clean bar of 0.4.
  const unsettled = answer({ mid_flight: noul(0.5), ...switched });
  assert.equal((await run(unsettled)).clean, true);
  assert.equal(
    (
      await run(
        answer({
          mid_flight: noul(0.5),
          ...switched,
          needs_history: { type: "score", score: 1.6 },
        }),
      )
    ).clean,
    false,
  );
  assert.equal((await run(answer({ mid_flight: noul(0.8), ...switched }))).clean, false);
  assert.equal(
    (await run(answer({ mid_flight: noul(0.5), ...switched, switched_gears: noul(0.3) }))).clean,
    false,
  );
  assert.equal(
    (
      await run(
        answer({
          mid_flight: noul(0.5),
          ...switched,
          needs_history: { type: "score", score: null },
        }),
      )
    ).clean,
    false,
  );
  // Without both sides to compare, the switch route is unavailable.
  assert.equal((await run(unsettled, {})).clean, false);
});

test("judgeMoment only sends the switch questions when there is something to compare", async () => {
  let sent;
  const ask = async ({ questions }) => ((sent = Object.keys(questions)), { answers: {} });
  await judgeMoment({ recentText: "x", ask });
  assert.deepEqual(sent, ["mid_flight", "completed", "debugging"]);
  await judgeMoment({ recentText: "x", currentRequest: "a", previousWork: "b", ask });
  assert.ok(sent.includes("switched_gears") && sent.includes("needs_history"));
});

test("composeHandoff keeps the constraint verbatim, drops noise, carries the note", async () => {
  const result = await composeHandoff({
    messages: transcript(),
    note: "next: run the client tests",
    tokensBefore: 100000,
    ask: fakeAsk(),
  });
  assert.match(result.summary, /## Goal\nGOALMARK/);
  assert.match(result.summary, /ALWAYS use tabs, never spaces/);
  assert.doesNotMatch(result.summary, /NOISE/);
  assert.match(result.summary, /## Agent note \(verbatim\)\nnext: run the client tests/);
  assert.equal(result.details.safeCompact.rounds, 1);
});

test("a coverage failure re-includes the segment verbatim on the next round", async () => {
  const long = `${"a".repeat(500)} MIDMARK ${"b".repeat(500)}`;
  const result = await composeHandoff({
    messages: [...transcript(), assistant(long)],
    tokensBefore: 100000,
    ask: fakeAsk({ coverage: (segment, handoff) => (handoff.includes("MIDMARK") ? 0.9 : 0.1) }),
  });
  assert.match(result.summary, /MIDMARK/);
  assert.equal(result.details.safeCompact.rounds, 2);
  assert.equal(result.details.safeCompact.forced, 1);
});

test("a huge flagged segment is re-included as a capped verbatim excerpt, not re-flagged forever", async () => {
  // Over VERBATIM_MAX, so the re-included copy is itself truncated. Comparing
  // that copy against its source would fail forever and never compact.
  const huge = `${"a".repeat(3000)} MIDMARK ${"b".repeat(3000)}`;
  const result = await composeHandoff({
    messages: [...transcript(), assistant(huge)],
    tokensBefore: 100000,
    ask: fakeAsk({ faithful: () => 0.1 }),
  });
  assert.ok(result);
  assert.match(result.summary, /a{100}/);
  assert.equal(result.details.safeCompact.forced, 1);
  assert.equal(result.details.safeCompact.rounds, 2);
});

test("an unusable verifier answer is not treated as a failure", async () => {
  const long = `${"a".repeat(500)} MIDMARK ${"b".repeat(500)}`;
  const result = await composeHandoff({
    messages: [...transcript(), assistant(long)],
    tokensBefore: 100000,
    ask: fakeAsk({ coverage: () => null }),
  });
  assert.ok(result);
});

test("a handoff not smaller than the transcript falls back with a size diagnostic", async () => {
  const reasons = [];
  assert.equal(
    await composeHandoff({
      messages: transcript(),
      tokensBefore: 10,
      ask: fakeAsk(),
      onRejected: (reason) => reasons.push(reason),
    }),
    null,
  );
  assert.equal(reasons.length, 1);
  assert.match(
    reasons[0],
    /handoff estimates \d+ tokens; must be below 6 \(60% of 10 replaced tokens\)/,
  );
});

test("composeHandoff throws when Jev is unreachable, so the caller falls back", async () => {
  const ask = async () => {
    throw new Error("TYPESAFE_API_KEY is not set");
  };
  await assert.rejects(
    composeHandoff({ messages: transcript(), tokensBefore: 100000, ask }),
    /TYPESAFE_API_KEY/,
  );
});

test("file pointers name real line ranges from the read offset", async () => {
  const lines = Array.from({ length: 60 }, (_, i) =>
    i === 29 ? "function retry() {" : `line ${i}`,
  );
  const result = await composeHandoff({
    messages: [
      user("GOALMARK fix it"),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "read",
            arguments: { path: "src/a.ts", offset: 101 },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text: lines.join("\n") }],
      },
    ],
    tokensBefore: 100000,
    ask: fakeAsk(),
  });
  assert.match(result.summary, /src\/a\.ts:126-150 \(starts: "line 25"\)/);
});

test("the extension registers its tools, commands and flags", () => {
  const seen = { tools: [], commands: [], flags: [], events: [] };
  safeCompact({
    registerTool: (d) => seen.tools.push(d.name),
    registerCommand: (name) => seen.commands.push(name),
    registerFlag: (name) => seen.flags.push(name),
    on: (name) => seen.events.push(name),
    getFlag: () => undefined,
  });
  assert.deepEqual(seen.tools, ["self_compact", "view_context"]);
  assert.deepEqual(seen.commands, ["safe-compact", "safe-compact-plan", "safe-compact-info"]);
  assert.deepEqual(seen.flags, ["compact-soft-at", "compact-at"]);
  assert.deepEqual(seen.events.sort(), ["session_before_compact", "session_compact", "turn_end"]);
});

test("relevantLines keeps the lines a segment matches, even from the middle of a huge handoff", () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `- unrelated filler line number ${i}`);
  const handoff = [...filler(400), "- retry backoff lives in client.ts", ...filler(400)].join("\n");
  assert.ok(handoff.length > 12000);
  const shown = relevantLines(handoff, "retry backoff in client.ts");
  assert.ok(shown.includes("retry backoff lives in client.ts"));
  assert.ok(shown.length <= 12000);
  assert.equal(relevantLines("short", "anything"), "short");
});

// --- Inline boundary compaction -------------------------------------------

const project = (id, messages) => ({ sourceEntry: { id, type: "message" }, messages });
const projectCompaction = (id, summary, details, messages) => ({
  sourceEntry: { id, type: "compaction", summary, details },
  messages,
});
const readCall = (id, path) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
});
const readResult = (callId, text) => ({
  role: "toolResult",
  toolCallId: callId,
  toolName: "read",
  content: [{ type: "text", text }],
});

/** `count` entries of roughly 950 estimated tokens each. */
const largeEntries = (count) =>
  Array.from({ length: count }, (_, i) =>
    project(`e${i}`, [user(`work ${i} ${"x".repeat(3800)}`)]),
  );

test("planBoundary: the kept span never starts at a tool result", () => {
  const entries = largeEntries(30);
  // A huge tool result sits just inside the budget boundary: the cut must land
  // after it, or the kept span begins with a result whose call was summarized.
  entries[25] = project("t25", [readResult("c25", "y".repeat(80000))]);
  const plan = planBoundary({ entries, keepRecentTokens: 20000 });
  assert.ok(plan);
  assert.equal(plan.firstKeptEntryId, "e26");
  assert.equal(
    entries.find((entry) => entry.sourceEntry.id === plan.firstKeptEntryId).messages[0].role,
    "user",
  );
});

test("planBoundary: carries the previous summary and file lists and skips hidden entries", () => {
  const entries = [
    projectCompaction(
      "c1",
      "OLD SUMMARY",
      { readFiles: ["src/old.ts"], modifiedFiles: ["src/changed.ts"] },
      [{ role: "compactionSummary", summary: "OLD SUMMARY" }],
    ),
    { sourceEntry: { id: "c0", type: "compaction", summary: "OLDER" }, messages: [] },
    ...largeEntries(30),
  ];
  const plan = planBoundary({ entries, keepRecentTokens: 20000 });
  assert.ok(plan);
  assert.equal(plan.previousSummary, "OLD SUMMARY");
  assert.deepEqual(plan.fileLists.readFiles, ["src/old.ts"]);
  assert.deepEqual(plan.fileLists.modifiedFiles, ["src/changed.ts"]);
  assert.ok(plan.firstKeptEntryId.startsWith("e"));
  assert.ok(!plan.messages.some((message) => message.role === "compactionSummary"));
});

test("planBoundary: nothing to compact when small or cut-point-free", () => {
  assert.equal(
    planBoundary({
      entries: [project("u1", [user("hi")]), project("a1", [assistant("hello")])],
      keepRecentTokens: 20000,
    }),
    null,
  );
  assert.equal(
    planBoundary({
      entries: [project("t1", [readResult("c1", "y".repeat(8000))])],
      keepRecentTokens: 1,
    }),
    null,
  );
});

test("planBoundary: refuses a compaction that would summarize almost nothing", () => {
  // The huge tool result sits in the kept tail, so the cut falls back to the
  // assistant call and the summarized range is only the tiny user prompt.
  const entries = [
    project("u1", [user("read the big file")]),
    project("a1", [readCall("c1", "big.txt")]),
    project("r1", [readResult("c1", "y".repeat(80000))]),
  ];
  assert.equal(planBoundary({ entries, keepRecentTokens: 20000 }), null);
});

test("buildBoundaryCompaction: verified draft carries the note and file lists", async () => {
  const entries = largeEntries(30);
  entries[0] = project("e0", [user(`GOALMARK fix the retry logic ${"x".repeat(3600)}`)]);
  entries[1] = project("e1", [user(`ALWAYS use tabs ${"x".repeat(3600)}`)]);
  entries[2] = project("e2", [readCall("c2", "src/client.ts")]);
  entries[3] = project("e3", [readResult("c2", `retry code ${"x".repeat(3600)}`)]);
  const result = await buildBoundaryCompaction({
    entries,
    keepRecentTokens: 20000,
    note: "next: run the tests",
    ask: fakeAsk(),
  });
  assert.ok(result);
  assert.match(result.summary, /GOALMARK fix the retry logic/);
  assert.match(result.summary, /ALWAYS use tabs/);
  assert.match(result.summary, /next: run the tests/);
  assert.deepEqual(result.details.readFiles, ["src/client.ts"]);
  assert.equal(result.details.safeCompact.segments, 8);
});

test("buildBoundaryCompaction: shrinkage includes the previous summary being replaced", async () => {
  const previousSummary = "earlier context ".repeat(400);
  const entries = [
    projectCompaction("old", previousSummary, {}, [
      { role: "compactionSummary", summary: previousSummary },
    ]),
    ...largeEntries(6),
  ];
  const result = await buildBoundaryCompaction({
    entries,
    keepRecentTokens: 2000,
    ask: fakeAsk(),
  });
  assert.ok(result, "a handoff replacing the old summary and new messages should compact");
});

test("buildBoundaryCompaction: nothing worth compacting returns null, not a failed handoff", async () => {
  const result = await buildBoundaryCompaction({
    entries: [project("u1", [user("hi")]), project("a1", [assistant("hello")])],
    keepRecentTokens: 20000,
    ask: fakeAsk(),
  });
  assert.equal(result, null);
});

test("planBoundary: a long history is summarized in capped chunks, not refused", () => {
  const entries = largeEntries(500);
  const plan = planBoundary({ entries, keepRecentTokens: 20000 });
  assert.ok(plan);
  // One handoff must stay within the segment budget composeHandoff can verify;
  // the next boundary compacts the rest.
  assert.equal(plan.messages.length, 400);
  assert.equal(plan.firstKeptEntryId, "e400");
});

test("an ambiguous faithfulness score keeps the excerpt instead of forcing it verbatim", async () => {
  const long = `${"a".repeat(500)} MIDMARK ${"b".repeat(500)}`;
  const result = await composeHandoff({
    messages: [...transcript(), assistant(long)],
    tokensBefore: 100000,
    ask: fakeAsk({ faithful: () => 0.4 }),
  });
  assert.ok(result);
  assert.equal(result.details.safeCompact.forced, 0);
});

test("turn_end commits a compaction draft instead of aborting through ctx.compact", async () => {
  const { handlers, tools, ctx, cleanup } = wiring();
  try {
    const event = { entries: [], context: { contextEntries: largeEntries(30) }, toolResults: [] };
    const result = await handlers.get("turn_end")(event, ctx);

    assert.equal(ctx.compacted, false);
    assert.equal(result.continue, undefined);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].type, "compaction");
    assert.equal(typeof result.entries[0].firstKeptEntryId, "string");
    assert.ok(result.entries[0].details.safeCompact);
    assert.ok(readdirSync(join(ctx.cwd, ".pi", "safe-compact")).length > 0);

    // The tool schedules the same boundary compaction even below the soft
    // threshold, and still never aborts.
    ctx.getContextUsage = () => ({ tokens: 30000, contextWindow: 40000, percent: 5 });
    await tools
      .get("self_compact")
      .execute("id", { note: "next: ship it" }, undefined, undefined, ctx);
    const requested = await handlers.get("turn_end")(event, ctx);
    assert.equal(ctx.compacted, false);
    assert.match(requested.entries[0].summary, /next: ship it/);

    // Below soft with no request, the handler leaves the turn alone.
    assert.equal(await handlers.get("turn_end")(event, ctx), undefined);
  } finally {
    cleanup();
  }
});

test("session_before_compact merges previous details into the handoff file lists", async () => {
  const { handlers, ctx, cleanup } = wiring();
  try {
    const result = await handlers.get("session_before_compact")(
      {
        preparation: {
          messagesToSummarize: [user(`GOALMARK fix the retry ${"x".repeat(200)}`)],
          turnPrefixMessages: [],
          previousSummary: undefined,
          tokensBefore: 100000,
          firstKeptEntryId: "keep-1",
          fileOps: { read: new Set(["src/new.ts"]), written: new Set(), edited: new Set() },
        },
        branchEntries: [
          {
            type: "compaction",
            details: {
              safeCompact: { segments: 1 },
              readFiles: ["src/old.ts"],
              modifiedFiles: ["src/changed.ts"],
            },
          },
        ],
      },
      ctx,
    );
    assert.deepEqual(result.compaction.details.readFiles, ["src/new.ts", "src/old.ts"]);
    assert.deepEqual(result.compaction.details.modifiedFiles, ["src/changed.ts"]);
  } finally {
    cleanup();
  }
});

/** A stub pi whose snapshots land under a temp cwd instead of the repo. */
function wiring() {
  const handlers = new Map();
  const tools = new Map();
  const notices = [];
  safeCompact(
    {
      registerTool: (definition) => tools.set(definition.name, definition),
      registerCommand: () => {},
      registerFlag: () => {},
      on: (name, handler) => handlers.set(name, handler),
      getFlag: () => undefined,
      getSettings: () => ({ compaction: { keepRecentTokens: 20000 } }),
    },
    { ask: fakeAsk() },
  );
  const cwd = mkdtempSync(join(tmpdir(), "safe-compact-"));
  const ctx = {
    cwd,
    compacted: false,
    compact() {
      this.compacted = true;
    },
    getContextUsage: () => ({ tokens: 30000, contextWindow: 40000, percent: 80 }),
    ui: { notify: (title, level) => notices.push({ title, level }) },
    sessionManager: { getBranch: () => [] },
  };
  return {
    handlers,
    tools,
    ctx,
    notices,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test("turn_end stays silent when there is nothing worth compacting", async () => {
  const { handlers, ctx, notices, cleanup } = wiring();
  try {
    const event = { entries: [], context: { contextEntries: [project("u1", [user("hi")])] } };
    assert.equal(await handlers.get("turn_end")(event, ctx), undefined);
    assert.deepEqual(notices, []);
  } finally {
    cleanup();
  }
});

test("turn_end warns when a planned handoff cannot be verified", async () => {
  const { handlers, ctx, notices, cleanup } = wiring();
  try {
    // A planned span whose handoff is almost all verbatim constraints: the
    // size guard rejects it, which is the case the warning exists for.
    const entries = [
      project("c0", [user(`ALWAYS keep tabs ${"x".repeat(4000)}`)]),
      project("c1", [user(`ALWAYS keep tabs ${"x".repeat(4000)}`)]),
      project("e2", [assistant("y".repeat(6100))]),
      project("e3", [assistant("y".repeat(6100))]),
      project("e4", [assistant("y".repeat(6100))]),
      project("e5", [assistant("y".repeat(6100))]),
    ];
    const event = { entries: [], context: { contextEntries: entries } };
    assert.equal(await handlers.get("turn_end")(event, ctx), undefined);
    const warnings = notices.filter((notice) => notice.level === "warning");
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0].title,
      /safe-compact: handoff estimates \d+ tokens; must be below \d+ \(60% of \d+ replaced tokens\), keeping context/,
    );
  } finally {
    cleanup();
  }
});

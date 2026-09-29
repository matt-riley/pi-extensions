// Offline tests: a fake `ask` stands in for Jev, keyed on the question ids the
// real code sends. What is pinned: hard rules beat scores, uncertainty keeps,
// a coverage failure re-includes the segment, and nothing unverifiable ships.

import { test } from "node:test";
import assert from "node:assert/strict";

import safeCompact from "../index.ts";
import { judgeMoment } from "../judge.mjs";
import { classify, composeHandoff, decideTrigger } from "../plan.mjs";
import { excerpt, segmentMessages, splitWindows } from "../segment.mjs";

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
        dead_end: noul(noise ? 0.9 : 0.05),
        recoverable: noul(file ? 0.9 : 0.1),
        disposition: {
          type: "choice",
          choice: noise ? "drop" : "excerpt",
          confidence: 0.9,
        },
      });
      return { answers };
    }
    for (const id of Object.keys(questions)) {
      if (id.startsWith("c")) {
        const c = state.candidates[Number(id.slice(1))];
        answers[id] = noul(/GOALMARK|retry/.test(c) ? 0.9 : 0.1);
      } else if (id.startsWith("e")) {
        answers[id] = noul(faithful(state.entries[Number(id.slice(1))]));
      } else if (id.startsWith("g")) {
        answers[id] = noul(coverage(state.segments[Number(id.slice(1))], state.handoff));
      }
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

test("splitWindows uses 1-based inclusive bounds and coarsens past the cap", () => {
  const text = Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n");
  const windows = splitWindows(text);
  assert.deepEqual([windows[0].start, windows[0].end, windows[2].end], [1, 25, 60]);
  assert.ok(splitWindows(text, { size: 1, maxWindows: 5 }).length <= 5);
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

test("a lossy entry still flagged after re-inclusion returns null instead of shipping", async () => {
  const huge = `${"a".repeat(3000)} MIDMARK ${"b".repeat(3000)}`; // over the verbatim cap
  const result = await composeHandoff({
    messages: [...transcript(), assistant(huge)],
    tokensBefore: 100000,
    ask: fakeAsk({ faithful: () => 0.1 }),
  });
  assert.equal(result, null);
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

test("a handoff not smaller than the transcript falls back", async () => {
  assert.equal(
    await composeHandoff({ messages: transcript(), tokensBefore: 10, ask: fakeAsk() }),
    null,
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

test("excerpt keeps head and tail", () => {
  const out = excerpt(`${"h".repeat(100)}${"t".repeat(100)}`, 40);
  assert.ok(out.startsWith("hhhh") && out.endsWith("tttt") && out.length <= 44);
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

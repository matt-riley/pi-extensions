// Scoring sees a trimmed copy of bulky tool results; nothing else does.
import { test } from "node:test";
import assert from "node:assert/strict";

import { judgeSegment } from "../judge.mjs";
import { composeHandoff } from "../plan.mjs";
import { SCORING_TOOL_CHARS, trimForScoring } from "../scoring-text.mjs";
import { segmentMessages } from "../segment.mjs";

const big = (marker) =>
  `HEAD-LINE start of the output\n${"filler line of output\n".repeat(400)}${marker}\n${"more filler\n".repeat(400)}TAIL-LINE exit code 1`;

const capture = () => {
  const sent = [];
  const ask = async (request) => {
    sent.push(request);
    return { answers: {} };
  };
  return { sent, ask };
};

test("a large tool result is trimmed in the scoring payload: head and tail kept, marker says how much", async () => {
  const text = big("MIDMARK buried in the middle");
  const { sent, ask } = capture();
  await judgeSegment({
    goal: "g",
    segment: { id: "s1", role: "toolResult", tool: "bash", text },
    ask,
  });
  const scored = sent[0].state.segment.text;
  assert.ok(scored.length < SCORING_TOOL_CHARS + 120, `scored ${scored.length} chars`);
  assert.ok(scored.length < text.length / 5);
  assert.match(scored, /^HEAD-LINE/);
  assert.match(scored, /TAIL-LINE exit code 1$/);
  assert.doesNotMatch(scored, /MIDMARK/);
  assert.match(scored, /\[… \d+ chars trimmed for scoring …\]/);
  const omitted = Number(scored.match(/(\d+) chars trimmed/)[1]);
  const marker = scored.match(/\n\[… \d+ chars trimmed for scoring …\]\n/)[0];
  // What is shown plus what the marker says was left out is the original, give or take the whitespace at the cut.
  assert.ok(Math.abs(scored.length - marker.length + omitted - text.length) <= 2);
});

test("bashExecution messages (the user's own `!` runs) are tool output too", async () => {
  const { sent, ask } = capture();
  await judgeSegment({
    goal: "g",
    segment: { id: "s1", role: "bashExecution", text: big("MIDMARK") },
    ask,
  });
  assert.doesNotMatch(sent[0].state.segment.text, /MIDMARK/);
  assert.match(sent[0].state.segment.text, /trimmed for scoring/);
});

test("a tool result at or under the threshold is sent whole", async () => {
  const { sent, ask } = capture();
  for (const length of [50, SCORING_TOOL_CHARS - 1, SCORING_TOOL_CHARS]) {
    const text = "x".repeat(length);
    await judgeSegment({
      goal: "g",
      segment: { id: "s", role: "toolResult", tool: "read", text },
      ask,
    });
    assert.equal(sent.at(-1).state.segment.text, text, `${length} chars`);
  }
  assert.equal(
    trimForScoring({ role: "toolResult", text: "x".repeat(SCORING_TOOL_CHARS + 1) }).includes(
      "trimmed",
    ),
    true,
  );
});

test("user and assistant messages never get the tool-result trim", async () => {
  const { sent, ask } = capture();
  const text = "a".repeat(1400); // over the tool threshold, under the general 1500 cap
  for (const role of ["user", "assistant"]) {
    await judgeSegment({ goal: "g", segment: { id: "s", role, text }, ask });
    assert.equal(sent.at(-1).state.segment.text, text, role);
  }
});

test("trimming is deterministic", () => {
  const segment = { role: "toolResult", tool: "bash", text: big("M") };
  assert.equal(trimForScoring(segment), trimForScoring({ ...segment }));
});

test("secrets are masked before trimming, so a key block cut in two is not half-shown", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIEowIBAAKCAQEA\n".repeat(200)}-----END RSA PRIVATE KEY-----`;
  const text = `${"a".repeat(300)}\n${pem}\n${"b".repeat(300)}`;
  const out = trimForScoring({ role: "toolResult", tool: "bash", text });
  assert.doesNotMatch(out, /MIIEowIBAAKCAQEA/);
  assert.match(out, /<REDACTED:pem>/);
  // Masked first means the block is gone before any cut; trimmed first would
  // have kept the BEGIN line and a slice of key bytes.
  assert.doesNotMatch(out, /BEGIN RSA PRIVATE KEY-----\nMIIE/);
});

test("the segment itself is not changed, and the other judgments still see what they saw", async () => {
  const messages = [
    { role: "user", content: "GOALMARK fix the build" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: big("MIDMARK") }],
    },
    { role: "assistant", content: [{ type: "text", text: "The build fails at the end." }] },
  ];
  const segment = segmentMessages(messages).find((s) => s.role === "toolResult");
  const before = segment.text;
  const { ask } = capture();
  await judgeSegment({ goal: "g", segment, ask });
  assert.equal(segment.text, before);

  const requests = [];
  await composeHandoff({
    messages,
    tokensBefore: 100000,
    ask: async (request) => {
      requests.push(request);
      return { answers: {} };
    },
  });
  const scoring = requests.filter((r) => "disposition" in r.questions);
  const trimmed = scoring.filter((r) => /trimmed for scoring/.test(r.state.segment.text));
  assert.equal(trimmed.length, 1, "only the bulky tool result is trimmed for scoring");
  const others = requests.filter((r) => !("disposition" in r.questions));
  assert.ok(
    others.every((r) => !/trimmed for scoring/.test(JSON.stringify(r.state))),
    "the coverage and selection requests are untouched",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  extractContext,
  extractUserMessages,
  formatMessage,
  parseArgs,
} from "./mine-transcripts.mjs";

const line = (value) => JSON.stringify(value);
const sessionLine = line({
  type: "session",
  id: "s1",
  cwd: "/home/me/projects/proj",
  timestamp: "2026-10-01T10:00:00.000Z",
});
const userLine = (content, ts) =>
  line({ type: "message", timestamp: ts, message: { role: "user", content, timestamp: ts } });
const text = (value) => [{ type: "text", text: value }];

test("keeps only user-authored text and tracks the session cwd", () => {
  const events = extractUserMessages([
    sessionLine,
    userLine(text("fix   the\n\nthing"), "2026-10-01T10:01:00.000Z"),
    line({ type: "message", message: { role: "assistant", content: text("ok") } }),
    line({ type: "message", message: { role: "toolResult", content: text("out") } }),
    line({ type: "custom_message", customType: "lore", content: "injected noise" }),
    "{ not json",
    userLine(text(""), "2026-10-01T10:02:00.000Z"),
    userLine(text("and this"), "2026-10-01T10:03:00.000Z"),
  ]);

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    ts: "2026-10-01T10:01:00.000Z",
    cwd: "/home/me/projects/proj",
    text: "fix the thing",
    source: "",
    line: 2,
    id: null,
  });
  assert.equal(events[1].text, "and this");
});

test("accepts string content and non-text parts are ignored", () => {
  const events = extractUserMessages([
    userLine("plain string", "2026-10-01T10:00:00.000Z"),
    userLine([{ type: "image", data: "abc" }], "2026-10-01T10:01:00.000Z"),
    userLine(
      [
        { type: "text", text: "kept" },
        { type: "image", data: "abc" },
      ],
      "2026-10-01T10:02:00.000Z",
    ),
  ]);
  assert.deepEqual(
    events.map((event) => event.text),
    ["plain string", "kept"],
  );
});

test("falls back to a numeric message timestamp", () => {
  const events = extractUserMessages([
    line({
      type: "message",
      message: { role: "user", content: text("hi"), timestamp: 1791315639262 },
    }),
  ]);
  assert.equal(events[0].ts, new Date(1791315639262).toISOString());
  assert.equal(formatMessage(events[0]).slice(0, 10), "2026-10-06");
});

test("formatMessage truncates long text and labels the project", () => {
  const formatted = formatMessage({
    ts: "2026-10-01T10:00:00.000Z",
    cwd: "/home/me/work/proj",
    text: "x".repeat(500),
  });
  assert.match(formatted, /^2026-10-01 \[proj\] x+…$/);
  assert.ok(formatted.length < 450);
});

test("parseArgs reads flags, keeps defaults, rejects unknown flags", () => {
  assert.equal(parseArgs([]).sinceDays, 30);
  assert.equal(parseArgs([]).limit, 300);
  assert.equal(parseArgs(["--since", "90", "--limit", "5"]).sinceDays, 90);
  assert.equal(parseArgs(["--since", "90", "--limit", "5"]).limit, 5);
  assert.equal(parseArgs(["--all"]).sinceDays, Infinity);
  assert.equal(parseArgs(["--project", "workv3"]).project, "workv3");
  assert.equal(parseArgs(["--project", "workv3"]).sinceDays, Infinity);
  assert.equal(parseArgs(["--project", "workv3", "--since", "7"]).sinceDays, 7);
  assert.equal(parseArgs(["--json"]).json, true);
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/);
});

test("source pointers survive malformed lines and context retains bounded tool evidence", () => {
  const lines = [
    sessionLine,
    "bad json",
    line({
      type: "message",
      id: "a1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command: "pwd" } }],
      },
    }),
    line({
      type: "message",
      message: { role: "toolResult", toolName: "bash", content: "x".repeat(2000) },
    }),
    userLine("stop", "2026-10-01"),
  ];
  assert.equal(extractUserMessages(lines, "/tmp/session.jsonl")[0].line, 5);
  const context = extractContext(lines, 5, "/tmp/session.jsonl");
  assert.match(context[0].text, /bash.*pwd/);
  assert.equal(context[0].id, "a1");
  assert.equal(context[1].text.length, 1200);
  assert.equal(context[1].truncated, true);
  assert.equal(context[2].candidate, true);
  assert.equal(context[2].source, "/tmp/session.jsonl");
  assert.throws(() => extractContext(lines, 0), /outside/);
  assert.throws(() => parseArgs(["--context", "file"]), /requires --line/);
  assert.throws(() => parseArgs(["--context"]), /requires a source file/);
  assert.throws(() => parseArgs(["--context", "--line", "3"]), /requires a source file/);
  assert.throws(() => parseArgs(["--line", "3"]), /requires --context/);
  assert.equal(parseArgs(["--context", "file", "--line", "5"]).line, 5);
  assert.equal(extractContext(Array(30).fill(userLine("a", "2026-10-01")), 15).length, 9);
});

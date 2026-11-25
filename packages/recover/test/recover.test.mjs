import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JOURNAL_TYPE,
  NOTE_TYPE,
  LIST_CAP,
  journalEntry,
  summarizeRecovery,
  recoveryNote,
} from "../recover.mjs";

const CHECK = "check the current state before repeating";

const journal = (data) => ({ type: "custom", customType: JOURNAL_TYPE, data });
const note = (text) => ({ type: "custom", customType: NOTE_TYPE, data: { version: 1, text } });
const assistant = (stopReason) => ({
  type: "message",
  message: { role: "assistant", stopReason, provider: "openai-codex", model: "gpt-5.6-luna" },
});
const user = (text) => ({
  type: "message",
  message: { role: "user", content: text },
});
const started = (id, name = "bash") =>
  journalEntry("started", { toolCallId: id, toolName: name }, 1);
const finished = (id, name = "bash") =>
  journalEntry("finished", { toolCallId: id, toolName: name }, 2);

test("journalEntry records a start or finish and skips a call it cannot name", () => {
  assert.deepEqual(started("call-1", "write"), {
    version: 1,
    toolCallId: "call-1",
    toolName: "write",
    phase: "started",
    at: 1,
  });
  assert.equal(journalEntry("started", { toolName: "bash" }, 1), null);
  assert.equal(journalEntry("finished", { toolCallId: "call-1" }, 1), null);
  assert.equal(journalEntry("started", { toolCallId: "", toolName: "bash" }, 1), null);
});

test("an empty session is not a cutoff", () => {
  assert.deepEqual(summarizeRecovery([]), { kind: "none" });
  assert.equal(recoveryNote({ kind: "none" }), null);
});

test("a session whose tools all finished is not a cutoff", () => {
  const entries = [
    user("edit the file"),
    journal(started("a", "read")),
    journal(finished("a", "read")),
    assistant("stop"),
  ];
  assert.deepEqual(summarizeRecovery(entries), { kind: "none" });
});

test("a tool that started and never finished is listed as maybe partly run", () => {
  const entries = [
    user("edit the file"),
    journal(started("a", "read")),
    journal(finished("a", "read")),
    journal(started("b", "write")),
  ];
  const summary = summarizeRecovery(entries);
  assert.deepEqual(summary, {
    kind: "cutoff",
    finished: [{ toolCallId: "a", toolName: "read" }],
    partial: [{ toolCallId: "b", toolName: "write" }],
  });
  const text = recoveryNote(summary);
  assert.match(text, /Finished: read \(a\)/);
  assert.match(text, /May have partly run: write \(b\)/);
  assert.match(text, new RegExp(CHECK));
});

test("a multi-step turn lists every finished call before the cut-off step", () => {
  const entries = [
    user("edit the file"),
    assistant("toolUse"),
    journal(started("a", "read")),
    journal(finished("a", "read")),
    assistant("toolUse"),
    journal(started("b", "write")),
  ];
  const summary = summarizeRecovery(entries);
  assert.deepEqual(summary, {
    kind: "cutoff",
    finished: [{ toolCallId: "a", toolName: "read" }],
    partial: [{ toolCallId: "b", toolName: "write" }],
  });
  const text = recoveryNote(summary);
  assert.match(text, /Finished: read \(a\)/);
  assert.match(text, /May have partly run: write \(b\)/);
  assert.match(text, new RegExp(CHECK));
});

test("an aborted last turn with a complete journal still adds a note", () => {
  const entries = [
    user("edit the file"),
    journal(started("a", "bash")),
    journal(finished("a", "bash")),
    assistant("aborted"),
  ];
  const summary = summarizeRecovery(entries);
  assert.deepEqual(summary, {
    kind: "cutoff",
    finished: [{ toolCallId: "a", toolName: "bash" }],
    partial: [],
  });
  const text = recoveryNote(summary);
  assert.match(text, /Finished: bash \(a\)/);
  assert.match(text, /May have partly run: none/);
  assert.match(text, new RegExp(CHECK));
});

test("an aborted last turn with no journal fails closed rather than guessing", () => {
  const entries = [user("edit the file"), assistant("aborted")];
  const summary = summarizeRecovery(entries);
  assert.deepEqual(summary, { kind: "closed", reason: "missing" });
  const text = recoveryNote(summary);
  assert.match(text, /journal is missing/);
  assert.match(text, new RegExp(CHECK));
  assert.doesNotMatch(text, /Finished:/);
});

test("an unreadable journal fails closed rather than guessing", () => {
  assert.deepEqual(summarizeRecovery(undefined), { kind: "closed", reason: "unreadable" });
  const corrupt = [
    user("edit the file"),
    journal({ version: 1, toolCallId: "a" }),
    assistant("aborted"),
  ];
  assert.deepEqual(summarizeRecovery(corrupt), { kind: "closed", reason: "unreadable" });
  const text = recoveryNote({ kind: "closed", reason: "unreadable" });
  assert.match(text, /journal is unreadable/);
  assert.match(text, new RegExp(CHECK));
});

test("a recover note already recorded for this cutoff is not written again", () => {
  const entries = [
    user("edit the file"),
    journal(started("b", "write")),
    assistant("aborted"),
    note("This session was cut off mid-turn. Check the current state before repeating."),
  ];
  assert.deepEqual(summarizeRecovery(entries), { kind: "none" });
});

for (const stopReason of ["stop", "length"]) {
  test(`a stale partial followed by a clean later turn ending in ${stopReason} gives no note`, () => {
    const entries = [
      user("first crash"),
      journal(started("stale", "write")),
      assistant("aborted"),
      note("This session was cut off mid-turn. check the current state before repeating."),
      user("try again"),
      journal(started("ok", "read")),
      journal(finished("ok", "read")),
      assistant(stopReason),
    ];
    assert.deepEqual(summarizeRecovery(entries), { kind: "none" });
    assert.equal(recoveryNote(summarizeRecovery(entries)), null);
  });
}

test("a long history lists only the cut-off turn's calls", () => {
  const earlier = [
    user("old work"),
    journal(started("old1", "bash")),
    journal(finished("old1", "bash")),
    journal(started("old2", "read")),
    journal(finished("old2", "read")),
    assistant("stop"),
  ];
  const cutoff = [
    user("new work"),
    journal(started("new1", "grep")),
    journal(finished("new1", "grep")),
    journal(started("new2", "write")),
  ];
  const summary = summarizeRecovery([...earlier, ...cutoff]);
  assert.deepEqual(summary, {
    kind: "cutoff",
    finished: [{ toolCallId: "new1", toolName: "grep" }],
    partial: [{ toolCallId: "new2", toolName: "write" }],
  });
  const text = recoveryNote(summary);
  assert.doesNotMatch(text, /old1|old2|bash \(old|read \(old2/);
  assert.match(text, /Finished: grep \(new1\)/);
  assert.match(text, /May have partly run: write \(new2\)/);
});

test("a long cut-off turn caps the listed calls and says how many were hidden", () => {
  const steps = [];
  const extra = 5;
  const total = LIST_CAP + extra;
  for (let i = 1; i <= total; i++) {
    const id = `f${i}`;
    steps.push(journal(started(id, "read")), journal(finished(id, "read")));
  }
  const entries = [user("long turn"), ...steps, journal(started("partial", "write"))];
  const summary = summarizeRecovery(entries);
  assert.equal(summary.kind, "cutoff");
  assert.equal(summary.finished.length, total);
  assert.deepEqual(summary.partial, [{ toolCallId: "partial", toolName: "write" }]);
  const text = recoveryNote(summary);
  assert.match(text, new RegExp(`Finished: read \\(f${extra + 1}\\)`));
  assert.doesNotMatch(text, new RegExp(`read \\(f${extra}\\)`));
  assert.match(text, new RegExp(`\\+${extra} more`));
  assert.match(text, /May have partly run: write \(partial\)/);
});

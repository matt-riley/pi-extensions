import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  noteUncheckedEdits,
  resetEvidenceState,
  uncheckedEditsAt,
} from "../../../shared/evidence-state.mjs";
import { createStaleLookup, replyMarks, writtenAt } from "../marks.mjs";

afterEach(resetEvidenceState);

describe("evidence spans", () => {
  test("unknown until done-gate publishes", () => assert.equal(uncheckedEditsAt(5), undefined));

  test("a time is judged by the span it falls in, not by the state now", () => {
    noteUncheckedEdits(false, 0);
    noteUncheckedEdits(true, 10);
    noteUncheckedEdits(true, 15); // already open: no new span
    noteUncheckedEdits(false, 20);
    noteUncheckedEdits(true, 30);
    assert.equal(uncheckedEditsAt(5), false);
    assert.equal(uncheckedEditsAt(10), true);
    assert.equal(uncheckedEditsAt(19), true);
    assert.equal(uncheckedEditsAt(20), false, "the closing instant is checked");
    assert.equal(uncheckedEditsAt(1_000), true, "an open span covers the present");
  });

  test("only the newest spans are kept", () => {
    for (let i = 0; i < 70; i++) {
      noteUncheckedEdits(true, i * 10);
      noteUncheckedEdits(false, i * 10 + 5);
    }
    assert.equal(uncheckedEditsAt(1), false, "the oldest span was dropped");
    assert.equal(uncheckedEditsAt(691), true);
  });
});

describe("stale lookup", () => {
  test("reuses a result within its lifetime, then asks again", () => {
    let calls = 0;
    let clock = 0;
    const lookup = createStaleLookup({
      find: () => (calls++, ["gone/a.ts"]),
      now: () => clock,
      ttlMs: 100,
    });
    assert.deepEqual([...lookup("see `gone/a.ts`", "/repo")], ["gone/a.ts"]);
    lookup("see `gone/a.ts`", "/repo");
    assert.equal(calls, 1);
    clock = 100;
    lookup("see `gone/a.ts`", "/repo");
    assert.equal(calls, 2);
  });

  test("text without a code span, or no cwd, is never checked", () => {
    const lookup = createStaleLookup({
      find: () => {
        throw new Error("should not run");
      },
    });
    assert.equal(lookup("plain gone/a.ts", "/repo").size, 0);
    assert.equal(lookup("`gone/a.ts`", undefined).size, 0);
  });

  test("finds missing paths on disk and leaves existing ones", (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "emphasis-paths-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src/here.ts"), "");
    const found = createStaleLookup()("`src/here.ts` and `src/gone.ts:12`", cwd);
    assert.deepEqual([...found], ["src/gone.ts"]);
  });
});

describe("reply marks", () => {
  const stale = () => new Set(["x/y.ts"]);

  test("a saved message is judged at its own time; a live one now", () => {
    assert.equal(writtenAt({ timestamp: "1970-01-01T00:00:01.000Z" }, 99), 1000);
    assert.equal(writtenAt({}, 99), 99);
    assert.equal(writtenAt({ timestamp: "junk" }, 99), 99);
  });

  test("marks claims only when done-gate says the edits were unchecked", () => {
    const at = (answer) => replyMarks("x", {}, { uncheckedAt: () => answer }).unchecked;
    assert.equal(at(true), true);
    assert.equal(at(false), false);
    assert.equal(at(undefined), false, "no done-gate, no marks");
    assert.equal(
      replyMarks("x", {}, { uncheckedAt: () => true, evidence: false }).unchecked,
      false,
    );
  });

  test("paths are checked once a reply has finished streaming", () => {
    assert.equal(replyMarks("x", { isStreaming: true }, { stale }).stale.size, 0);
    assert.equal(replyMarks("x", {}, { stale }).stale.size, 1);
    assert.equal(replyMarks("x", {}, { stale, paths: false }).stale.size, 0);
  });
});

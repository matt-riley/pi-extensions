import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installClimb } from "../climb-run.mjs";
import { workingTreeId } from "../tree.mjs";

const metric = (value) => ({ code: 0, stdout: JSON.stringify({ value, completed: 1, cached: 0 }) });

function harness(t, { metrics, gates = [], trees }) {
  const cwd = mkdtempSync(join(tmpdir(), "climb-run-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const handlers = {};
  const commands = {};
  const sent = [];
  const notes = [];
  const pi = {
    on: (name, fn) => {
      handlers[name] = fn;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    exec: async (_sh, [, cmd]) =>
      cmd === "GATE" ? (gates.shift() ?? { code: 0 }) : metrics.shift(),
    sendUserMessage: async (text, opts) => sent.push({ text, opts }),
  };
  installClimb(pi, { treeId: async () => trees.shift() });
  const ctx = {
    cwd,
    ui: { notify: (title, level) => notes.push({ title, level }), setStatus() {} },
  };
  const settle = () => handlers.agent_before_settle({ outcome: "completed", entries: [] }, ctx);
  const say = (text) =>
    handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text }] } });
  const start = (args) => commands.climb.handler(args, ctx);
  const logRows = () => {
    const dir = join(cwd, ".pi", "runs");
    const file = readdirSync(dir).find((f) => f.startsWith("climb-"));
    return readFileSync(join(dir, file), "utf8").trim().split("\n");
  };
  return { cwd, sent, notes, settle, say, start, logRows };
}

test("baseline first, then keep, reject, require the revert, and reach the target", async (t) => {
  const h = harness(t, {
    metrics: [
      ...[40, 41, 42].map(metric), // baseline
      ...[30, 31, 32].map(metric), // kept
      ...[29, 31, 33].map(metric), // rejected: overlaps
      ...[10, 11, 12].map(metric), // kept, reaches the target
    ],
    trees: ["t0", "t1", "t2", "t9", "t1", "t3"],
  });
  await h.start("--target 20 --gate GATE METRIC");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].opts.deliverAs, "followUp");
  assert.match(h.sent[0].text, /Baseline: 41 \[40, 42\]/);
  assert.ok(existsSync(join(h.cwd, ".pi", "runs", ".gitignore")));

  h.say("Hypothesis: memoise the parser");
  const kept = await h.settle();
  assert.equal(kept.continue, true);
  assert.match(kept.entries[0].content, /^\/climb attempt 1\/20: kept \(median 41 -> 31\)/);

  const rejected = await h.settle();
  assert.match(rejected.entries[0].content, /rejected \(ranges overlap the best accepted run\)/);

  const unreverted = await h.settle(); // tree t9 is neither the attempt nor the accepted state
  assert.match(unreverted.entries[0].content, /does not match the last accepted state/);
  const reverted = await h.settle(); // back to t1
  assert.match(reverted.entries[0].content, /revert confirmed/);

  assert.equal(await h.settle(), undefined); // done
  assert.match(
    h.notes.at(-1).title,
    /^climb: target 20 reached, best 11 \[10, 12\] after 3 attempt\(s\), 2 kept$/,
  );

  const rows = h.logRows();
  assert.equal(rows[0], "ts\titeration\thypothesis\tbefore\tafter\trange\tgate\tverdict");
  assert.equal(rows[1].split("\t")[2], "baseline");
  assert.equal(rows[2].split("\t")[2], "memoise the parser");
  assert.match(rows[2], /\tkept: median 41 -> 31 \(tree t1\)$/);
  assert.equal(rows.length, 1 + 1 + 3 + 2); // header, baseline, three attempts, two revert checks
});

test("a red gate on the untouched tree starts nothing", async (t) => {
  const h = harness(t, { metrics: [], gates: [{ code: 1 }], trees: ["t0"] });
  await h.start("--target 20 --gate GATE METRIC");
  assert.equal(h.sent.length, 0);
  assert.match(h.notes.at(-1).title, /gate exits 1 on the untouched tree/);
});

test("a settle with no change counts no attempt and halts after three", async (t) => {
  const h = harness(t, { metrics: [40, 41, 42].map(metric), trees: ["t0", "t0", "t0", "t0"] });
  await h.start("--target 20 --gate GATE METRIC");
  assert.match((await h.settle()).entries[0].content, /nothing changed/);
  await h.settle();
  assert.equal(await h.settle(), undefined);
  assert.match(h.notes.at(-1).title, /no attempt counted/);
});

test("a same-size edit sharing the index entry's mtime is still seen", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "climb-racy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]).toString();
  const stamp = new Date("2020-01-01T00:00:00Z");
  git("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "one");
  utimesSync(join(cwd, "a.txt"), stamp, stamp);
  git("add", ".");
  // The entry and the index file now share one timestamp tick. A copied index
  // stamped with the current time is newer than every entry, so git would trust
  // the stat cache and miss the same-size edit below.
  utimesSync(join(cwd, ".git", "index"), stamp, stamp);
  writeFileSync(join(cwd, "a.txt"), "two");
  utimesSync(join(cwd, "a.txt"), stamp, stamp);

  // The tree of the edited content, built independently of workingTreeId.
  const blob = execFileSync("git", ["-C", cwd, "hash-object", "-w", "--stdin"], {
    input: "two",
  }).toString();
  const expected = execFileSync("git", ["-C", cwd, "mktree"], {
    input: `100644 blob ${blob.trim()}\ta.txt\n`,
  }).toString();

  assert.equal(await workingTreeId(cwd), expected.trim(), "the edit is not the old content");
});

test("the tree id ignores commits and the run logs, and sees a new file", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "climb-tree-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  git("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "one");
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(join(cwd, "a.txt"), "two");
  const edited = await workingTreeId(cwd);
  git("commit", "-qam", "accept");
  assert.equal(await workingTreeId(cwd), edited);
  mkdirSync(join(cwd, ".pi", "runs"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "runs", ".gitignore"), "*\n");
  writeFileSync(join(cwd, ".pi", "runs", "climb-x.tsv"), "row\n");
  assert.equal(await workingTreeId(cwd), edited);
  writeFileSync(join(cwd, "b.txt"), "new");
  assert.notEqual(await workingTreeId(cwd), edited);
  assert.equal(git("status", "--porcelain").toString(), "?? b.txt\n");
  assert.equal(await workingTreeId(tmpdir()), null);
});

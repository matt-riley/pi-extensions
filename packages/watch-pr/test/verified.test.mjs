import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { patchId } from "../../../shared/revision.mjs";
import {
  VERDICT_ENTRY,
  latestVerdict,
  parseVerifierVerdict,
  verdictEntry,
  verifiedLine,
} from "../../../shared/verdict.mjs";
import piWatchPrExtension from "../index.ts";

function repo(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "patch-id-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(cwd, "a.txt"), "1\n2\n3\n");
  writeFileSync(path.join(cwd, "b.txt"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return { cwd, git, write: (file, text) => writeFileSync(path.join(cwd, file), text) };
}

test("patchId survives a rebase and changes only when the change does", async (t) => {
  const { cwd, git, write } = repo(t);
  git("checkout", "-q", "-b", "feature");
  write("a.txt", "1\n2\n3\n4\n");
  git("commit", "-qam", "feature: add 4");
  const before = await patchId(cwd, "main", "HEAD");
  assert.match(before, /^[0-9a-f]{40}$/);

  git("checkout", "-q", "main");
  write("b.txt", "y\n");
  git("commit", "-qam", "main moves on");
  git("checkout", "-q", "feature");
  const oldHead = git("rev-parse", "HEAD");
  git("rebase", "-q", "main");
  assert.notEqual(git("rev-parse", "HEAD"), oldHead, "the rebase changed the SHA");
  assert.equal(await patchId(cwd, "main", "HEAD"), before, "the patch did not change");

  write("a.txt", "1\n2\n3\n4\n5\n");
  git("commit", "-q", "--amend", "-am", "feature: add 4 and 5");
  assert.notEqual(await patchId(cwd, "main", "HEAD"), before);
});

test("without head, patchId covers the working tree, untracked files included", async (t) => {
  const { cwd, git, write } = repo(t);
  git("checkout", "-q", "-b", "feature");
  assert.equal(await patchId(cwd, "main"), null, "an empty change has no patch id");
  write("a.txt", "1\n2\n3\n4\n");
  write("new.txt", "fresh\n");
  const dirty = await patchId(cwd, "main");
  assert.ok(dirty);
  git("add", "-A");
  git("commit", "-qm", "the same change, committed");
  assert.equal(await patchId(cwd, "main", "HEAD"), dirty, "committing does not change the patch");
  assert.equal(git("status", "--porcelain"), "", "the real index was not touched");
  assert.equal(await patchId(cwd, "no-such-ref"), null);
});

test("parseVerifierVerdict reads the word under the Verdict heading", () => {
  const report = (line) => `## Verdict\n${line}\n\n## Evidence\n...`;
  assert.equal(
    parseVerifierVerdict(report("**verified** — every criterion reproduced")),
    "verified",
  );
  assert.equal(
    parseVerifierVerdict(report("**Partially verified**: one gap")),
    "partially verified",
  );
  assert.equal(parseVerifierVerdict(report("Failed: the server never starts")), "failed");
  assert.equal(parseVerifierVerdict(report("It looks fine")), null);
  assert.equal(parseVerifierVerdict("verified, trust me"), null, "no heading, no verdict");
});

test("verifiedLine binds the newest verdict to the PR's current patch", () => {
  const ok = { verdict: "verified", head: "0123456789abcdef", patchId: "p1" };
  assert.equal(verifiedLine(null, "p1"), "verified: no verdict recorded");
  assert.equal(verifiedLine(ok, "p1"), "verified: yes (patch unchanged since 0123456789ab)");
  assert.equal(verifiedLine(ok, "p2"), "verified: stale (patch changed since 0123456789ab)");
  assert.match(verifiedLine(ok, null), /^verified: unknown \(could not compute this PR's patch id/);
  assert.match(verifiedLine({ ...ok, patchId: null }, "p1"), /^verified: unknown \(no patch id/);
  assert.equal(
    verifiedLine({ ...ok, verdict: "failed" }, "p1"),
    "verified: no (latest verifier verdict was failed at 0123456789ab)",
  );
  const custom = (data) => ({ type: "custom", customType: VERDICT_ENTRY, data });
  assert.equal(
    latestVerdict([custom(ok), { type: "message" }, custom({ ...ok, patchId: "p9" })]).patchId,
    "p9",
  );
  assert.equal(latestVerdict([{ type: "custom", customType: "other", data: ok }]), null);
});

test("verdictEntry records the verdict with the dirty tree's patch against the default branch", async (t) => {
  const { cwd, git, write } = repo(t);
  git("checkout", "-q", "-b", "feature");
  write("a.txt", "changed\n");
  const entry = await verdictEntry({
    text: "## Verdict\n**verified**: yes",
    cwd,
    head: "abc",
    id: "verifier",
    now: new Date(0),
  });
  assert.deepEqual(entry, {
    verdict: "verified",
    head: "abc",
    patchId: await patchId(cwd, "main"),
    base: "main",
    at: "1970-01-01T00:00:00.000Z",
    id: "verifier",
  });
  assert.ok(entry.patchId);
});

test("watch_pr adds a verified line outside its verdict, and catches an amended head", async (t) => {
  const { cwd, git, write } = repo(t);
  git("checkout", "-q", "-b", "feature");
  write("a.txt", "1\n2\n3\nverified change\n");
  const recorded = await verdictEntry({
    text: "## Verdict\nverified",
    cwd,
    head: "dirty",
    id: "v",
  });
  git("commit", "-qam", "feature");
  const branch = [{ type: "custom", customType: VERDICT_ENTRY, data: recorded }];

  async function read() {
    const head = git("rev-parse", "HEAD");
    const pr = {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      state: "OPEN",
      isDraft: false,
      headRefOid: head,
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    };
    const page = {
      data: {
        repository: {
          pullRequest: {
            headRefOid: head,
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    };
    let tool;
    piWatchPrExtension({
      registerTool: (definition) => (tool = definition),
      exec: async (_command, args) => ({
        code: 0,
        stdout: JSON.stringify(args[3] === "pr" ? pr : [page]),
      }),
    });
    const result = await tool.execute("call", { pr: "7" }, undefined, undefined, {
      cwd,
      sessionManager: { getBranch: () => branch },
    });
    return result.content[0].text.split("\n");
  }

  const fresh = await read();
  assert.equal(fresh[0], "ready", "the five-verdict contract is unchanged");
  assert.match(fresh.at(-1), /^verified: yes \(patch unchanged since dirty\)$/);

  write("a.txt", "1\n2\n3\nverified change\nunverified extra\n");
  git("commit", "-q", "--amend", "-am", "feature");
  const amended = await read();
  assert.equal(amended[0], "ready", "CI being green does not make it verified");
  assert.match(amended.at(-1), /^verified: stale \(patch changed since dirty\)$/);
});

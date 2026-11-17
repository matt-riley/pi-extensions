import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installRerun, parseFindings, rerun, RERUN_CAVEAT } from "../rerun.mjs";

const block = (findings) =>
  `I tried hard.\n\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\`\n`;
const finding = (title, command, extra = {}) => ({ title, command, observed: "pasted", ...extra });

test("parseFindings reads only a trailing json block and keeps well-formed findings", () => {
  assert.deepEqual(
    parseFindings(block([finding("a", "false"), { title: "no command" }])).findings,
    [finding("a", "false")],
  );
  assert.deepEqual(parseFindings(block([])), { findings: [] }, "no findings is a valid result");
  assert.equal(parseFindings("no block here").error, "no trailing json block");
  assert.equal(parseFindings(`${block([])}\nmore prose after`).error, "no trailing json block");
  assert.match(parseFindings("```json\n{nope}\n```").error, /^bad json: /);
  assert.equal(parseFindings('```json\n{"findings":{}}\n```').error, "findings is not an array");
});

test("rerun keeps only commands that still exit non-zero, never the pasted output", async () => {
  const exits = { "exit 0": 0, "exit 3": 3, blocked: null };
  const run = async (_cwd, command) =>
    exits[command] === null
      ? { code: null, output: "", reason: "blocked by guardrail" }
      : { code: exits[command], output: `ran ${command}\nlast line` };
  const { kept, dropped } = await rerun(
    [
      {
        source: "gemini",
        cwd: "/a",
        findings: [finding("fixed", "exit 0"), finding("real", "exit 3")],
      },
      {
        source: "gpt",
        cwd: "/b",
        findings: [finding("real too", "exit 3"), finding("b", "blocked")],
      },
    ],
    run,
  );
  assert.equal(kept.length, 1, "one command from two adversaries is one finding");
  assert.deepEqual(kept[0].sources, ["gemini", "gpt"]);
  assert.equal(kept[0].exit, 3);
  assert.equal(kept[0].output, "ran exit 3\nlast line");
  assert.deepEqual(
    dropped.map((d) => [d.source, d.title, d.reason]),
    [
      ["gemini", "fixed", "command exited 0"],
      ["gpt", "b", "blocked by guardrail"],
    ],
  );
});

test("rerun stops at the cap and says which findings were not run", async () => {
  let calls = 0;
  const run = async () => ({ code: (calls += 1), output: "" });
  const findings = [1, 2, 3].map((n) => finding(`f${n}`, `cmd ${n}`));
  const { kept, dropped } = await rerun([{ source: "s", cwd: "/", findings }], run, { max: 2 });
  assert.equal(calls, 2);
  assert.equal(kept.length, 2);
  assert.deepEqual(dropped, [
    { source: "s", title: "f3", reason: "over the 2-finding cap; not run" },
  ]);
});

function harness(executeTool) {
  const tools = {};
  installRerun({ registerTool: (def) => (tools[def.name] = def) });
  return { tool: tools.rerun_findings, ctx: { executeTool } };
}

test("rerun_findings runs each command through the bash tool from the worktree", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "rerun-it's-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const { tool, ctx } = harness(async (name, input) => {
    calls.push({ name, input });
    // A real shell, so the cd and quoting are exercised, not just the string.
    let code = 0;
    let output = "";
    try {
      output = execFileSync("sh", ["-c", input.command], { encoding: "utf8" });
    } catch (error) {
      code = error.status;
      output = String(error.stdout);
    }
    return { isError: code !== 0, result: { structuredContent: { output, exit_code: code } } };
  });
  assert.equal(tool.exposure, "deferred");
  assert.equal(tool.annotations.readOnlyHint, false, "it executes commands");
  assert.deepEqual(tool.reachesTools(), ["bash"]);

  const text = block([
    finding("cwd is the worktree", "pwd -P; exit 4", { required: "run elsewhere" }),
    finding("passes", "true"),
  ]);
  const result = await tool.execute(
    "id",
    { reports: [{ source: "seat-a", cwd: dir, text }] },
    undefined,
    undefined,
    ctx,
  );
  const out = result.content[0].text;

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.name === "bash" && call.input.timeout === 60));
  assert.match(out, /^kept: 1 finding/);
  assert.match(out, /## cwd is the worktree\nsources: seat-a/);
  assert.ok(
    out.includes(
      `exit: 4\nintent requires: run elsewhere\noutput (rerun, last lines):\n${realpathSync(dir)}\n`,
    ),
    out,
  );
  assert.doesNotMatch(out, /pasted/, "the adversary's own output is never shown as evidence");
  assert.match(out, /- seat-a: passes: command exited 0/);
  assert.ok(out.endsWith(RERUN_CAVEAT));
});

test("rerun_findings refuses a cwd that is not a directory and reports unreadable reports", async () => {
  const { tool, ctx } = harness(async () => assert.fail("nothing should run"));
  const result = await tool.execute(
    "id",
    {
      reports: [
        { source: "a", cwd: "relative/dir", text: block([finding("x", "false")]) },
        { source: "b", cwd: tmpdir(), text: "forgot the block" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  const out = result.content[0].text;
  assert.match(out, /no verified findings/);
  assert.match(out, /- a: no findings read: cwd is not an absolute directory: relative\/dir/);
  assert.match(out, /- b: no findings read: no trailing json block/);
});

test("a blocked or timed-out command is dropped, not kept", async () => {
  const { tool, ctx } = harness(async () => ({
    isError: true,
    result: { content: [{ type: "text", text: "Blocked: guardrail denied" }] },
  }));
  const result = await tool.execute(
    "id",
    { reports: [{ source: "a", cwd: tmpdir(), text: block([finding("x", "rm -rf /")]) }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0].text, /- a: x: did not run to an exit: Blocked: guardrail denied/);
  assert.deepEqual(result.details.kept, []);
});

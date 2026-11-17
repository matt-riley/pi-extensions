#!/usr/bin/env node
// Opt-in empirical workflow evals: real model, externally scored artifacts.
//
// Default: the verification-prompt pilot (HEAD verifier versus the working
// tree's, four frozen CLI cases). With --variant-a/--variant-b/--cases: a
// blinded A/B run of two prompt or skill variants (workflow-eval/variants.mjs).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  ISOLATION_FLAGS,
  MAX_RUNS,
  MAX_TURNS,
  REPORTED_COST_CEILING,
  TIMEOUT_MS,
  defaultModel,
  privateAgentDir,
  runPi,
  summarize,
} from "./workflow-eval/run-pi.mjs";
import { acceptanceExecuted as observedAcceptance } from "./workflow-eval/scoring.mjs";
import { runVariantEval } from "./workflow-eval/variants.mjs";

if (!process.argv.includes("--live")) {
  console.log(
    "Opt-in: node scripts/workflow-eval.mjs --live --output <directory>\n" +
      "        node scripts/workflow-eval.mjs --live --variant-a <dir> --variant-b <dir> --cases <dir> --output <directory>\n" +
      "8 real model runs maximum, 90s/6 turns each, $2 reported-cost ceiling; reads default pi provider auth privately. See docs/workflow-evaluation.md.",
  );
  process.exit(0);
}
const flag = (name) => {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
};
const outputFlag = flag("--output");
if (!outputFlag) throw new Error("--output is required");
const output = path.resolve(outputFlag);
const variantFlags = ["--variant-a", "--variant-b", "--cases"].map(flag);
if (variantFlags.some(Boolean)) {
  if (!variantFlags.every(Boolean))
    throw new Error("--variant-a, --variant-b and --cases go together");
  const [variantA, variantB, casesDir] = variantFlags;
  await runVariantEval({ variantA, variantB, casesDir, output, model: await defaultModel() });
  process.exit(0);
}

await mkdir(output); // Refuse overwriting an earlier pilot.
const root = path.resolve(import.meta.dirname, "..");
const { provider, model, credential } = await defaultModel();
const casesRaw = await readFile(path.join(root, "scripts/workflow-eval/cases.json"), "utf8");
const cases = JSON.parse(casesRaw);
const baseline = execFileSync("git", ["show", "HEAD:packages/subagents/agents/verifier.md"], {
  cwd: root,
  encoding: "utf8",
});
const candidate = await readFile(path.join(root, "packages/subagents/agents/verifier.md"), "utf8");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const protocol = {
  scope:
    "Verification prompt + project recipe versus pre-change verifier prompt. Not full subagent orchestration or implementation quality.",
  provider,
  model,
  thinking: "off",
  maxRuns: MAX_RUNS,
  maxTurns: MAX_TURNS,
  timeoutMs: TIMEOUT_MS,
  reportedCostCeiling: REPORTED_COST_CEILING,
  baselineRef: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  casesHash: hash(casesRaw),
  baselineHash: hash(baseline),
  candidateHash: hash(candidate),
  order: "Alternating baseline/candidate by case; no prompt tuning after run start",
  humanCorrections: null,
  rework: null,
};
await writeFile(path.join(output, "protocol.json"), JSON.stringify(protocol, null, 2));
await writeFile(path.join(output, "cases.json"), casesRaw);
await writeFile(path.join(output, "baseline.md"), baseline);
await writeFile(path.join(output, "candidate.md"), candidate);
const results = [];
let reportedCost = 0;
try {
  for (const [index, item] of cases.entries()) {
    for (const variant of index % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      if (reportedCost >= REPORTED_COST_CEILING) break;
      const dir = path.join(output, `${item.id}-${variant}`);
      await mkdir(dir);
      const config = await privateAgentDir({ provider, model, credential });
      try {
        await writeFile(path.join(dir, "main.mjs"), item.implementation + "\n");
        await writeFile(
          path.join(dir, "test.mjs"),
          `import {execFileSync} from "node:child_process"; import assert from "node:assert/strict"; assert.equal(execFileSync(process.execPath,["main.mjs",${JSON.stringify(item.ordinaryA)},${JSON.stringify(item.ordinaryB)}],{encoding:"utf8"}).trim(),${JSON.stringify(item.ordinaryExpected)});\n`,
        );
        await writeFile(
          path.join(dir, "package.json"),
          JSON.stringify({ type: "module", scripts: { test: "node test.mjs" } }),
        );
        const recipe = `Setup: existing Node, no installs. Startup/fixture: node main.mjs ${item.a} ${item.b}. Acceptance: stdout must be exactly ${item.expected}. Run the ordinary suite as supporting evidence: npm test. Cleanup: no processes remain after CLI exit. Record HEAD and the command output; do not edit files.\n`;
        await writeFile(path.join(dir, "VERIFICATION.md"), recipe);
        const git = (...args) =>
          execFileSync("git", args, { cwd: dir, stdio: "pipe", timeout: 10000 });
        git("init");
        git("-c", "user.name=Pilot", "-c", "user.email=pilot@example.test", "add", ".");
        git(
          "-c",
          "user.name=Pilot",
          "-c",
          "user.email=pilot@example.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "frozen fixture",
        );
        const prompt = `Independently verify this CLI implementation without editing files. Acceptance: running node main.mjs ${item.a} ${item.b} must print exactly ${item.expected}. A passing npm test is supporting evidence. Inspect and execute the real artifact. End with exactly VERDICT: verified or VERDICT: failed; report the observed command/output. ${variant === "candidate" ? "Project verification recipe: VERIFICATION.md. Apply it and record the exact target identity." : ""}`;
        await writeFile(path.join(output, `${item.id}-${variant}-prompt.txt`), prompt);
        const started = Date.now();
        const { events, stderr, exitCode, reason, turns } = await runPi({
          cwd: dir,
          agentDir: config,
          args: [
            ...ISOLATION_FLAGS,
            "--no-context-files",
            "--no-approve",
            "--provider",
            provider,
            "--model",
            model,
            "--thinking",
            "off",
            "--tools",
            "read,bash",
            "--append-system-prompt",
            variant === "candidate" ? candidate : baseline,
            prompt,
          ],
        });
        const { text, cost, tokens } = summarize(events);
        const verdict = text.match(/VERDICT:\s*(verified|failed)/)?.[1] ?? "unknown";
        const observed = execFileSync(process.execPath, ["main.mjs", item.a, item.b], {
          cwd: dir,
          encoding: "utf8",
        }).trim();
        const expectedVerdict = observed === item.expected ? "verified" : "failed";
        const toolCalls = events.filter(
          (event) => event.type === "tool_execution_start" && event.toolName === "bash",
        );
        const acceptanceExecuted = observedAcceptance(
          events,
          ["node", "main.mjs", item.a, item.b],
          dir,
        );
        if (cost !== null) reportedCost += cost;
        const unchanged = git("status", "--porcelain").toString().trim() === "";
        const result = {
          case: item.id,
          split: item.split,
          variant,
          verdict,
          expectedVerdict,
          accepted:
            verdict === expectedVerdict && unchanged && exitCode === 0 && acceptanceExecuted,
          observed,
          acceptanceExecuted,
          unchanged,
          exitCode,
          reason,
          turns,
          durationMs: Date.now() - started,
          cost,
          tokens,
          bashCommands: toolCalls.map((event) => event.args?.command),
          promptHash: hash(prompt),
          humanCorrections: null,
          rework: null,
        };
        await writeFile(
          path.join(output, `${item.id}-${variant}-events.json`),
          JSON.stringify(events, null, 2),
        );
        await writeFile(path.join(output, `${item.id}-${variant}-stderr.txt`), stderr);
        results.push(result);
        await writeFile(
          path.join(output, "results.json"),
          JSON.stringify({ protocol, reportedCost, results }, null, 2),
        );
        console.log(
          `${item.id} ${variant}: ${result.accepted ? "PASS" : "FAIL"}, ${verdict}/${expectedVerdict}, ${result.durationMs}ms, cost=${cost ?? "unknown"}`,
        );
      } finally {
        await rm(config, { recursive: true, force: true });
      }
    }
  }
} finally {
  console.log(
    `Pilot artifacts: ${output}; ${results.length}/${MAX_RUNS} runs; reported cost ${reportedCost}`,
  );
}

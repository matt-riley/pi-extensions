#!/usr/bin/env node
// Opt-in empirical verification-prompt pilot: real model, externally scored artifacts.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { acceptanceExecuted as observedAcceptance } from "./workflow-eval/scoring.mjs";

if (!process.argv.includes("--live")) {
  console.log(
    "Opt-in: node scripts/workflow-eval.mjs --live --output <directory>\n8 real model runs maximum, 90s/6 turns each, $2 reported-cost ceiling; reads default pi provider auth privately. See docs/workflow-evaluation.md.",
  );
  process.exit(0);
}
const outputFlag = process.argv.indexOf("--output");
if (outputFlag < 0 || !process.argv[outputFlag + 1]) throw new Error("--output is required");
const output = path.resolve(process.argv[outputFlag + 1]);
await mkdir(output); // Refuse overwriting an earlier pilot.
const root = path.resolve(import.meta.dirname, "..");
const sourceDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
const settings = JSON.parse(await readFile(path.join(sourceDir, "settings.json"), "utf8"));
const provider = settings.defaultProvider;
const model = settings.defaultModel;
if (!provider || !model || provider === "router")
  throw new Error("Configure a physical default provider/model before this pilot");
const auth = JSON.parse(await readFile(path.join(sourceDir, "auth.json"), "utf8"));
if (!auth[provider])
  throw new Error("Default provider has no auth.json credential; provision one explicitly");
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
  maxRuns: 8,
  maxTurns: 6,
  timeoutMs: 90000,
  reportedCostCeiling: 2,
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
      if (reportedCost >= 2) break;
      const dir = path.join(output, `${item.id}-${variant}`);
      await mkdir(dir);
      const config = await mkdtemp(path.join(tmpdir(), "pi-eval-config-"));
      try {
        await writeFile(
          path.join(config, "auth.json"),
          JSON.stringify({ [provider]: auth[provider] }),
          { mode: 0o600 },
        );
        await writeFile(
          path.join(config, "settings.json"),
          JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
        );
        await writeFile(
          path.join(config, "models.json"),
          JSON.stringify({
            providers: { [provider]: { modelOverrides: { [model]: { maxTokens: 2048 } } } },
          }),
        );
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
        const events = [];
        let stderr = "";
        let turns = 0;
        let reason = "exited";
        const child = spawn(
          process.env.PI_SMOKE_BIN || "pi",
          [
            "--print",
            "--mode",
            "json",
            "--offline",
            "--no-session",
            "--no-mcp",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
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
          {
            cwd: dir,
            env: {
              PATH: process.env.PATH,
              PI_CODING_AGENT_DIR: config,
              PI_OFFLINE: "1",
              PI_TELEMETRY: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const timer = setTimeout(() => {
          reason = "timeout";
          child.kill("SIGKILL");
        }, 90000);
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        createInterface({ input: child.stdout }).on("line", (line) => {
          try {
            const event = JSON.parse(line);
            events.push(event);
            if (event.type === "turn_end" && ++turns >= 6) {
              reason = "turn cap";
              child.kill("SIGKILL");
            }
          } catch {
            /* Non-JSON startup text is not evidence. */
          }
        });
        const exitCode = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        }).finally(() => clearTimeout(timer));
        const messages = events
          .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
          .map((event) => event.message);
        const text =
          messages
            .at(-1)
            ?.content?.filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n") ?? "";
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
        const costValues = messages.map((message) => message.usage?.cost?.total);
        const cost =
          costValues.length && costValues.every((value) => Number.isFinite(value))
            ? costValues.reduce((a, b) => a + b, 0)
            : null;
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
          tokens: messages.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0),
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
    `Pilot artifacts: ${output}; ${results.length}/8 runs; reported cost ${reportedCost}`,
  );
}

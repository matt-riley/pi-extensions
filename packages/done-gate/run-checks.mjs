// run-checks.mjs — run the commands the done-gate already named, when asked to.
//
// Opt-in (PI_DONE_GATE_EXEC=1, read in index.ts). Bounded three ways: each
// command has a timeout, its output keeps only the tail (where a failing check
// says why), and at most `maxCommands` run. An AbortSignal cancels the running
// command and starts no later one. Commands run one after another in `cwd`,
// each in its own process group so a timeout or abort takes the whole tree.

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 4_000;
const DEFAULT_MAX_COMMANDS = 4;

function runOne({ command, cwd, signal, timeoutMs, maxOutput }) {
  return new Promise((resolve) => {
    const started = Date.now();
    // `.pi/verify` is a path the gate names; a shell needs it as ./.pi/verify.
    const script = command === ".pi/verify" ? "./.pi/verify" : command;
    const child = spawn("bash", ["-c", script], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let truncated = false;
    let ending = null;
    const take = (chunk) => {
      output += chunk;
      if (output.length > maxOutput * 2) {
        output = output.slice(-maxOutput);
        truncated = true;
      }
    };
    child.stdout.on("data", (chunk) => take(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => take(chunk.toString("utf8")));

    const stop = (status) => {
      ending ??= status;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => stop("timed out"), timeoutMs);
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (status, code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (output.length > maxOutput) {
        output = output.slice(-maxOutput);
        truncated = true;
      }
      resolve({
        command,
        status,
        code,
        durationMs: Date.now() - started,
        output,
        truncated,
      });
    };
    child.on("error", (error) => {
      output += `${error.message}\n`;
      finish("failed", null);
    });
    // `close`, not `exit`: the output streams have ended too.
    child.on("close", (code) => finish(ending ?? (code === 0 ? "passed" : "failed"), code));
  });
}

/**
 * Run `commands` in order. Returns one result per command that ran; a
 * cancelled command is the last one reported. Never rejects.
 */
export async function runChecks({
  commands,
  cwd,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutput = DEFAULT_MAX_OUTPUT,
  maxCommands = DEFAULT_MAX_COMMANDS,
} = {}) {
  const results = [];
  for (const command of (commands ?? []).slice(0, maxCommands)) {
    if (signal?.aborted) break;
    const result = await runOne({ command, cwd, signal, timeoutMs, maxOutput });
    results.push(result);
    if (result.status === "cancelled") break;
  }
  return results;
}

const seconds = (ms) => (ms / 1000).toFixed(1);

/** The text appended to the reminder. `notRun` counts commands past the cap. */
export function formatRunReport(results, notRun = 0) {
  const lines = [
    "The gate ran these checks for you (PI_DONE_GATE_EXEC=1). That does not count as a verification run: run them yourself, or say what the output shows.",
  ];
  for (const r of results) {
    const exit = r.code === null || r.code === undefined ? "" : `exit ${r.code}, `;
    lines.push(`\`${r.command}\` — ${r.status} (${exit}${seconds(r.durationMs)}s)`);
    const body = r.output.trim();
    if (body) lines.push(`${r.truncated ? "(earlier output cut)\n" : ""}${body}`);
  }
  if (notRun > 0) lines.push(`${notRun} more command(s) not run (limit).`);
  return lines.join("\n");
}

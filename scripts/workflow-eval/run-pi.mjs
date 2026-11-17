// One bounded, isolated pi session for the workflow evals: a private agent
// directory holding only the default provider's credential, a hard turn and
// time cap, and the JSON event stream kept as evidence.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/** Hard limits per session; the run and cost caps live with each protocol. */
export const MAX_TURNS = 6;
export const TIMEOUT_MS = 90000;
export const MAX_RUNS = 8;
export const REPORTED_COST_CEILING = 2;

/** The physical default provider/model and its credential, read privately. */
export async function defaultModel(sourceDir = defaultAgentDir()) {
  const settings = JSON.parse(await readFile(path.join(sourceDir, "settings.json"), "utf8"));
  const provider = settings.defaultProvider;
  const model = settings.defaultModel;
  if (!provider || !model || provider === "router")
    throw new Error("Configure a physical default provider/model before this pilot");
  const auth = JSON.parse(await readFile(path.join(sourceDir, "auth.json"), "utf8"));
  if (!auth[provider])
    throw new Error("Default provider has no auth.json credential; provision one explicitly");
  return { provider, model, credential: auth[provider] };
}

function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

/**
 * A disposable agent directory with only this provider's credential, no
 * retries, no compaction and a 2048-token output cap. The caller removes it.
 */
export async function privateAgentDir({ provider, model, credential }, prefix = "pi-agent-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await writeFile(path.join(dir, "auth.json"), JSON.stringify({ [provider]: credential }), {
    mode: 0o600,
  });
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
  );
  await writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: { [provider]: { modelOverrides: { [model]: { maxTokens: 2048 } } } },
    }),
  );
  return dir;
}

/** pi flags that switch off every discovered resource; explicit paths still load. */
export const ISOLATION_FLAGS = [
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
];

/**
 * Run pi with `args` in `cwd` against `agentDir`, killing it at the turn or
 * time cap. Resolves with the parsed events, stderr, exit code, why it ended
 * and the number of turns.
 */
export async function runPi({
  args,
  cwd,
  agentDir,
  bin = process.env.PI_SMOKE_BIN || "pi",
  maxTurns = MAX_TURNS,
  timeoutMs = TIMEOUT_MS,
}) {
  const events = [];
  let stderr = "";
  let turns = 0;
  let reason = "exited";
  const child = spawn(bin, args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => {
    reason = "timeout";
    child.kill("SIGKILL");
  }, timeoutMs);
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === "turn_end" && ++turns >= maxTurns) {
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
  return { events, stderr, exitCode, reason, turns };
}

/** Final assistant text, summed reported cost (null when any is missing) and tokens. */
export function summarize(events) {
  const messages = events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message);
  const text =
    messages
      .at(-1)
      ?.content?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const costValues = messages.map((message) => message.usage?.cost?.total);
  const cost =
    costValues.length && costValues.every((value) => Number.isFinite(value))
      ? costValues.reduce((a, b) => a + b, 0)
      : null;
  const tokens = messages.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0);
  return { text, cost, tokens };
}

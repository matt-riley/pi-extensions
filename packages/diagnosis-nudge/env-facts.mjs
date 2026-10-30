// env-facts.mjs — learn small repo-specific command facts from repeated failures.
//
// Within a session, a bare command that fails as "not found" followed by a
// launcher-backed success becomes candidate "A fails, use B". Across sessions
// the ledger confirms or retires facts without model calls.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { flagOff } from "../../shared/env-flag.mjs";
import { messageText } from "../../shared/message-text.mjs";

export const ENV_FACTS_ENV = "PI_DIAGNOSIS_ENV_FACTS";
const LEDGER_VERSION = 1;
const CONFIRMATIONS_NEEDED = 3;
const CONTRADICTION_WEIGHT = 5;

const PATH_KEYS = new Set(["path", "file_path", "filePath", "target", "filename", "destination"]);

/** @typedef {{ version: number, facts: object[], retiredKeys: string[] }} Ledger */

export function envFactsEnabled(env = process.env) {
  return !flagOff(env?.[ENV_FACTS_ENV]);
}

export function sessionKey(ctx) {
  const id = ctx?.sessionId ?? ctx?.session?.id;
  return typeof id === "string" && id.trim() ? id.trim() : "local";
}

export function agentDirForEnv(env = process.env) {
  const override = String(env?.PI_CODING_AGENT_DIR ?? "").trim();
  return override || join(homedir(), ".pi", "agent");
}

export function ledgerPath(agentDir, repoRoot) {
  const key = createHash("sha256").update(String(repoRoot)).digest("hex").slice(0, 16);
  return join(agentDir, "diagnosis-nudge", "env-facts", `${key}.json`);
}

export async function loadLedger(filePath, fs) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== LEDGER_VERSION || !Array.isArray(parsed?.facts)) return emptyLedger();
    parsed.retiredKeys = Array.isArray(parsed.retiredKeys) ? parsed.retiredKeys : [];
    return parsed;
  } catch {
    return emptyLedger();
  }
}

export async function saveLedger(filePath, ledger, fs) {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(ledger)}\n`, "utf8");
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function emptyLedger() {
  return { version: LEDGER_VERSION, facts: [], retiredKeys: [] };
}

export function createEnvFactsSession() {
  return { pendingFails: [], editedFiles: new Set(), learnedThisSession: new Set() };
}

export function collectEditedPaths(session, event) {
  if (!session?.editedFiles || !event?.input) return;
  const mutators = new Set(["write", "edit", "apply_patch", "multiedit"]);
  if (!mutators.has(event.toolName)) return;
  collectPaths(event.input, session.editedFiles);
}

function collectPaths(input, out) {
  if (!input || typeof input !== "object") return;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && PATH_KEYS.has(key)) out.add(normalizePath(value));
    else if (value && typeof value === "object") collectPaths(value, out);
  }
}

function normalizePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
}

export function isNotFoundFailure({ isError, output = "", exitCode } = {}) {
  if (isError !== true) return false;
  const text = String(output);
  if (exitCode === 127) return true;
  if (/command not found/i.test(text)) return true;
  if (/No module named/i.test(text)) return true;
  if (/ENOENT/i.test(text) && /exec|spawn|command/i.test(text)) return true;
  return false;
}

function shellWords(command) {
  return String(command ?? "")
    .trim()
    .split(/\s+/);
}

/** @returns {{ kind: "bare", name: string } | { kind: "launcher", launcher: string, name: string }} */
function invocationTarget(command) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return null;
  const py = trimmed.match(/^python\d*(?:\.\d+)?\s+-m\s+(\S+)/i);
  if (py) return { kind: "launcher", launcher: "python -m", name: py[1] };
  const npx = trimmed.match(/^npx\s+(?:--yes\s+)?(?:(?:-p|-package)\s+\S+\s+)?(\S+)/i);
  if (npx) return { kind: "launcher", launcher: "npx", name: npx[1] };
  const bunx = trimmed.match(/^bunx\s+(\S+)/i);
  if (bunx) return { kind: "launcher", launcher: "bunx", name: bunx[1] };
  const uv = trimmed.match(/^uv\s+run\s+(\S+)/i);
  if (uv) return { kind: "launcher", launcher: "uv run", name: uv[1] };
  const word = shellWords(trimmed)[0];
  if (!word) return null;
  const bare = word.replace(/^['"]|['"]$/g, "");
  if (/^(python|node|npm|npx|bun|bunx|uv)$/i.test(bare)) return null;
  return { kind: "bare", name: bare };
}

function targetFromOutput(output) {
  const text = String(output ?? "");
  let match = text.match(/No module named ['"]([^'"]+)['"]/i);
  if (match) return match[1];
  match = text.match(/(?:^|\s)([\w./-]+):\s*(?:command not found|not found)/i);
  if (match) return match[1].replace(/^\.\//, "");
  match = text.match(/(?:command not found|not found):\s*([\w./-]+)/i);
  if (match) return match[1];
  return null;
}

function bareFailTarget(command, output) {
  const fromOutput = targetFromOutput(output);
  const inv = invocationTarget(command);
  if (inv?.kind === "bare") {
    const name = fromOutput ?? inv.name;
    return name.replace(/^\.\//, "");
  }
  if (fromOutput) return fromOutput.replace(/^\.\//, "");
  return null;
}

function normalizeOkCommand(command, targetName) {
  const inv = invocationTarget(command);
  if (inv?.kind === "launcher" && inv.name === targetName) {
    const words = shellWords(command);
    if (inv.launcher === "python -m") {
      const idx = words.findIndex((w) => w === "-m");
      return idx >= 0 ? `${words[0]} -m ${words[idx + 1]}` : command.trim();
    }
    if (inv.launcher === "npx") return `npx ${targetName}`;
    if (inv.launcher === "bunx") return `bunx ${targetName}`;
    if (inv.launcher === "uv run") return `uv run ${targetName}`;
  }
  return String(command ?? "").trim();
}

export function commandsSameJob({ failCommand, failOutput, okCommand }) {
  const target = bareFailTarget(failCommand, failOutput);
  if (!target) return null;
  const ok = invocationTarget(okCommand);
  if (!ok || ok.kind !== "launcher" || ok.name !== target) return null;
  return { fail: target, ok: normalizeOkCommand(okCommand, target) };
}

export function observeEnvFactsResult(session, event) {
  if (event?.toolName !== "bash") return;
  const command = typeof event.input?.command === "string" ? event.input.command : "";
  const output = typeof event.output === "string" ? event.output : messageText(event.content);
  const exitCode = event.exitCode ?? event.result?.structuredContent?.exit_code;
  if (isNotFoundFailure({ isError: event.isError, output, exitCode })) {
    session.pendingFails.push({ command, output, exitCode });
    return;
  }
  if (event.isError === true) return;
  recordSessionCandidate(session, event);
}

export function recordSessionCandidate(session, event) {
  if (event?.toolName !== "bash" || event.isError === true) return null;
  const command = typeof event.input?.command === "string" ? event.input.command : "";
  for (const fail of session.pendingFails) {
    const pair = commandsSameJob({
      failCommand: fail.command,
      failOutput: fail.output,
      okCommand: command,
    });
    if (!pair) continue;
    const key = factKey(pair.fail, pair.ok);
    if (session.learnedThisSession.has(key)) return null;
    session.learnedThisSession.add(key);
    return pair;
  }
  return null;
}

function factKey(fail, ok) {
  return `${fail}\u0000${ok}`;
}

function factId(fail, ok) {
  return createHash("sha256").update(factKey(fail, ok)).digest("hex").slice(0, 8);
}

function editsOverlap(a, b) {
  const left = a?.length ? a : [];
  const right = b?.length ? b : [];
  if (left.length === 0 || right.length === 0) return false;
  const set = new Set(left);
  return right.some((file) => set.has(file));
}

export function confirmationEligible(fact, { sessionId, editedFiles }) {
  if (fact.status === "retired") return false;
  if (fact.confirmations.some((c) => c.sessionId === sessionId)) return false;
  for (const existing of fact.confirmations) {
    if (editsOverlap(existing.editedFiles, editedFiles)) return false;
  }
  return true;
}

export function applyConfirmation(fact, { sessionId, editedFiles }) {
  fact.confirmations.push({
    sessionId,
    editedFiles: [...new Set((editedFiles ?? []).map(normalizePath))],
  });
  fact.score = (fact.score ?? 0) + 1;
  reconcileFactStatus(fact);
}

export function applyContradiction(fact) {
  fact.contradictions = (fact.contradictions ?? 0) + 1;
  fact.score = (fact.score ?? 0) - CONTRADICTION_WEIGHT;
  reconcileFactStatus(fact);
}

export function reconcileFactStatus(fact) {
  const score = fact.score ?? 0;
  const contradictions = fact.contradictions ?? 0;
  if (score <= 0 && (contradictions > 0 || fact.status === "retired")) {
    fact.status = "retired";
    return;
  }
  if (fact.confirmations.length >= CONFIRMATIONS_NEEDED && score > 0) {
    fact.status = "confirmed";
    return;
  }
  if (fact.status !== "retired") fact.status = "candidate";
}

function upsertCandidate(ledger, pair) {
  const key = factKey(pair.fail, pair.ok);
  if (ledger.retiredKeys.includes(key)) return null;
  let fact = ledger.facts.find((item) => item.fail === pair.fail && item.ok === pair.ok);
  if (!fact) {
    fact = {
      id: factId(pair.fail, pair.ok),
      fail: pair.fail,
      ok: pair.ok,
      confirmations: [],
      contradictions: 0,
      score: 0,
      status: "candidate",
    };
    ledger.facts.push(fact);
  }
  return fact;
}

export function confirmCandidate(ledger, pair, sessionId, editedFiles) {
  const key = factKey(pair.fail, pair.ok);
  if (ledger.retiredKeys.includes(key)) return null;
  const fact = upsertCandidate(ledger, pair);
  if (!fact || fact.status === "retired") return null;
  if (!confirmationEligible(fact, { sessionId, editedFiles })) return fact;
  applyConfirmation(fact, { sessionId, editedFiles });
  maybeRetireKey(ledger, fact);
  return fact;
}

function observeContradiction(ledger, event) {
  if (event?.toolName !== "bash") return null;
  const command = typeof event.input?.command === "string" ? event.input.command : "";
  const output = typeof event.output === "string" ? event.output : messageText(event.content);
  const exitCode = event.exitCode ?? event.result?.structuredContent?.exit_code;
  for (const fact of ledger.facts) {
    if (fact.status === "retired") continue;
    const failMatch = matchesFailCommand(command, fact);
    const okMatch = command.trim() === fact.ok || command.trim().startsWith(`${fact.ok} `);
    if (fact.status === "confirmed" || fact.confirmations.length > 0) {
      if (failMatch && event.isError === false) {
        applyContradiction(fact);
        maybeRetireKey(ledger, fact);
        return fact;
      }
      if (okMatch && isNotFoundFailure({ isError: event.isError, output, exitCode })) {
        applyContradiction(fact);
        maybeRetireKey(ledger, fact);
        return fact;
      }
    }
  }
  return null;
}

function maybeRetireKey(ledger, fact) {
  if (fact.status === "retired") {
    const key = factKey(fact.fail, fact.ok);
    if (!ledger.retiredKeys.includes(key)) ledger.retiredKeys.push(key);
  }
}

export function matchesFailCommand(command, fact) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed || !fact?.fail) return false;
  const inv = invocationTarget(trimmed);
  if (inv?.kind === "bare" && inv.name === fact.fail) return true;
  const words = shellWords(trimmed);
  return words[0] === fact.fail || words[0] === `./${fact.fail}`;
}

export function factDisplayLine(fact) {
  const sessions = fact.confirmations?.length ?? 0;
  const n = sessions === 1 ? "1 session" : `${sessions} sessions`;
  return `Repo fact (seen in ${n}): \`${fact.fail}\` isn't available here; \`${fact.ok}\` works.`;
}

export function appendFactLine(content, line) {
  if (!line) return content;
  if (!Array.isArray(content)) return content;
  return [...content, { type: "text", text: line }];
}

function matchingConfirmedFact(ledger, command) {
  return ledger.facts.find(
    (fact) => fact.status === "confirmed" && matchesFailCommand(command, fact),
  );
}

export function forgetFact(ledger, id) {
  const fact = ledger.facts.find((item) => item.id === id);
  if (!fact) return `No env fact with id ${id}.`;
  fact.status = "retired";
  fact.score = Math.min(fact.score ?? 0, 0);
  const key = factKey(fact.fail, fact.ok);
  if (!ledger.retiredKeys.includes(key)) ledger.retiredKeys.push(key);
  return `Retired env fact ${id} (\`${fact.fail}\` → \`${fact.ok}\`).`;
}

export function formatFactsList(ledger) {
  if (!ledger.facts.length) return "No repository env facts learned yet.";
  return ledger.facts
    .map(
      (fact) =>
        `${fact.id}  ${fact.status}  score=${fact.score ?? 0}  ` +
        `\`${fact.fail}\` → \`${fact.ok}\`  (${fact.confirmations?.length ?? 0} sessions)`,
    )
    .join("\n");
}

function handleDiagnosisFactsCommand(args, ledger) {
  const trimmed = args.trim();
  if (!trimmed.startsWith("facts")) return null;
  const rest = trimmed.slice("facts".length).trim();
  if (rest.startsWith("forget")) {
    const id = rest.slice("forget".length).trim();
    if (!id) return "Usage: /diagnosis facts forget <id>";
    return forgetFact(ledger, id);
  }
  return formatFactsList(ledger);
}

const defaultFs = { mkdir, readFile, writeFile, rename, rm };

/** Runtime wired from index.ts — keeps tool_result handling in one place. */
export function createEnvFactsRuntime({
  getAgentDir,
  findRepoRoot,
  exec,
  env = process.env,
  fs = defaultFs,
}) {
  let session = createEnvFactsSession();
  let ledger = emptyLedger();
  let ledgerFile = "";
  let sessionId = "local";

  async function refreshLedger(cwd, ctx) {
    if (!envFactsEnabled(env)) return;
    sessionId = sessionKey(ctx);
    const { root } = await findRepoRoot(cwd, exec);
    ledgerFile = ledgerPath(getAgentDir(), root);
    ledger = await loadLedger(ledgerFile, fs);
  }

  return {
    enabled() {
      return envFactsEnabled(env);
    },
    async onSessionStart(ctx) {
      session = createEnvFactsSession();
      await refreshLedger(ctx?.cwd ?? process.cwd(), ctx);
    },
    onToolCall(event) {
      if (!envFactsEnabled(env)) return;
      collectEditedPaths(session, event);
    },
    async onToolResult(event, ctx) {
      if (!envFactsEnabled(env)) return null;
      const output = messageText(event?.content);
      const exitCode = event?.result?.structuredContent?.exit_code;
      const wrapped = {
        toolName: event?.toolName,
        isError: event?.isError,
        input: event?.input,
        output,
        exitCode,
        content: event?.content,
        result: event?.result,
      };
      observeEnvFactsResult(session, wrapped);
      const pair = recordSessionCandidate(session, wrapped);
      let dirty = false;
      if (pair) {
        confirmCandidate(ledger, pair, sessionKey(ctx) || sessionId, [...session.editedFiles]);
        dirty = true;
      }
      if (observeContradiction(ledger, wrapped)) dirty = true;
      if (dirty && ledgerFile) await saveLedger(ledgerFile, ledger, fs);

      if (event?.toolName === "bash" && event?.isError === true) {
        const command = typeof event.input?.command === "string" ? event.input.command : "";
        const fact = matchingConfirmedFact(ledger, command);
        if (fact) return factDisplayLine(fact);
      }
      return null;
    },
    async handleDiagnosisFactsCommand(args) {
      if (!args.trim().startsWith("facts")) return null;
      const message = handleDiagnosisFactsCommand(args, ledger);
      if (args.trim().includes("forget") && ledgerFile) await saveLedger(ledgerFile, ledger, fs);
      return message;
    },
    async persistLedger() {
      if (ledgerFile) await saveLedger(ledgerFile, ledger, fs);
    },
    getLedger() {
      return ledger;
    },
  };
}

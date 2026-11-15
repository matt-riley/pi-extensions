// plan-scout.mjs: read-only scouts for plan mode.
//
// A scout is a hidden child session with fresh context. It gets file reading,
// search and outline tools and nothing else: no shell (not even the read-only
// allowlist), no editing, no web, no way to start agents. The planner sends a
// few at once, each with a brief that stands on its own, and reads what comes
// back. `/plan check` runs its reader the same way.

import { excerpt } from "../../shared/spans.mjs";

/** Scouts running at once. A fourth call waits for the planner to read the first three. */
export const MAX_SCOUTS = 3;
const SCOUT_MAX_TURNS = 8;
const SCOUT_TIMEOUT_MS = 120_000;
const REPORT_MAX_CHARS = 6000;
const MIN_BRIEF_CHARS = 40;

// Explicit allowlist, never a blocklist: a mutating tool added later cannot leak in.
const SCOUT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "repo_map",
  "code_search",
  "file_outline",
  "find_definition",
];

const SCOUT_PROMPT = [
  "You are a read-only scout for someone planning a change. You have no shell: you can read files,",
  "search, and outline code, nothing more. You cannot edit anything or start other agents.",
  "The task you were given is your only briefing; you have not seen the conversation behind it.",
  "",
  "Answer the task from what you actually read. Every path and line range you cite must be one you",
  "opened. Report findings, not file dumps, and stop as soon as the task is answered.",
  "",
  "Reply with exactly these sections:",
  "",
  "## Findings",
  "What you found, each point with `path:lines`.",
  "",
  "## Reuse",
  "Existing functions, helpers and patterns the change should build on, with paths.",
  "",
  "## Verification",
  "How this repository checks a change: the commands in package.json, a Makefile, AGENTS.md or CI",
  "config, and the tests nearest to the code in question.",
  "",
  "## Unknowns",
  "What you could not settle by reading. Write `none` if there is nothing.",
].join("\n");

/** The child definition `runChild` expects. `toolsListed` makes the list exact. */
export function buildScoutAgent() {
  return {
    name: "plan-scout",
    toolsListed: true,
    tools: [...SCOUT_TOOLS],
    thinking: "low",
    systemPrompt: SCOUT_PROMPT,
  };
}

const POINTS_AT_CHAT =
  /\b(?:as discussed|as we discussed|above|earlier in this|the conversation|you saw|as before)\b/i;

/** Why a brief cannot stand on its own, or null. The scout never sees the conversation. */
export function briefProblem(task) {
  const text = String(task ?? "").trim();
  if (!text) return "the brief is empty. Say what to find out and where to start looking.";
  if (text.length < MIN_BRIEF_CHARS) {
    return "the brief is too short to stand on its own. Give the question, the paths or symbols to start from, and what to bring back.";
  }
  if (POINTS_AT_CHAT.test(text)) {
    return "the scout cannot see this conversation. Write the context into the brief instead of pointing at it.";
  }
  return null;
}

/** A counter of places, as a closure: `take()` claims one, `release()` gives it back. */
export function createScoutSlots(max = MAX_SCOUTS) {
  let used = 0;
  return {
    take() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
    release() {
      used = Math.max(0, used - 1);
    },
  };
}

function cut(text) {
  const body = String(text ?? "").trim();
  if (body.length <= REPORT_MAX_CHARS) return body;
  const shown = excerpt(body, REPORT_MAX_CHARS);
  return `${shown}\n[${body.length - REPORT_MAX_CHARS} characters cut]`;
}

/**
 * Run one scout and return its report as text for the planner.
 * `ok` is false for anything but a finished, non-empty report, so a failed
 * scout is never read as a finding. `runChild` is injectable for tests.
 */
export async function runPlanScout({
  task,
  cwd,
  model,
  signal,
  runChild: runChildFn,
  maxTurns = SCOUT_MAX_TURNS,
  timeoutMs = SCOUT_TIMEOUT_MS,
} = {}) {
  const problem = briefProblem(task);
  if (problem) return { ok: false, text: `Rejected: ${problem}` };
  let result;
  try {
    const runChild = runChildFn ?? (await import("../subagents/spawn.mjs")).runChild;
    result = await runChild({
      cwd,
      agent: buildScoutAgent(),
      task: String(task).trim(),
      model,
      thinkingLevel: "low",
      maxTurns,
      timeoutMs,
      signal,
    });
  } catch (error) {
    return { ok: false, text: `Scout failed: ${error instanceof Error ? error.message : error}` };
  }
  const uses = `${result?.toolUses ?? 0} tool uses`;
  const finished = result?.status === "completed" || result?.status === "wrapped up";
  if (!finished) {
    const partial = cut(result?.text);
    return {
      ok: false,
      text:
        `Scout did not finish (${result?.status ?? "unknown"}, ${uses}). ` +
        `Treat what follows as partial notes, not findings.${partial ? `\n\n${partial}` : ""}`,
    };
  }
  const report = cut(result.text);
  if (!report) return { ok: false, text: `Scout returned no report (${uses}).` };
  return { ok: true, text: `Scout report (${uses}):\n\n${report}` };
}

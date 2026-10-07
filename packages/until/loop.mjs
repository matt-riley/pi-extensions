// loop.mjs — pure logic for /until: argument parsing, the per-settle decision,
// and the TSV decision-log row. index.ts owns pi wiring, exec and the filesystem.

export const DEFAULT_MAX = 20;
const TAIL_LINES = 40;
export const RULE = "A plateau is not a stop; never relax the predicate.";

/**
 * Parse `/until` arguments.
 *   ""                       → { kind: "status" }
 *   "stop"                   → { kind: "stop" }
 *   "[--max N] <cmd> [-- task]" → { kind: "start", command, task, max }
 */
export function parseArgs(raw) {
  let text = (raw ?? "").trim();
  if (text === "") return { kind: "status" };
  if (text === "stop") return { kind: "stop" };

  let max = DEFAULT_MAX;
  const maxMatch = /^--max\s+(\S+)\s*/.exec(text);
  if (maxMatch) {
    max = Number(maxMatch[1]);
    if (!Number.isInteger(max) || max < 1) {
      return { kind: "error", message: `--max needs a positive integer, got "${maxMatch[1]}"` };
    }
    text = text.slice(maxMatch[0].length);
  }

  const split = text.indexOf(" -- ");
  const command = (split === -1 ? text : text.slice(0, split)).trim();
  const task = split === -1 ? "" : text.slice(split + 4).trim();
  if (command === "")
    return { kind: "error", message: "usage: /until [--max N] <command> [-- task]" };
  return { kind: "start", command, task, max };
}

export function tail(text, lines = TAIL_LINES) {
  const all = (text ?? "").trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

/** The first prompt that starts the loop. */
export function kickoffMessage(loop) {
  const goal = loop.task || `Make \`${loop.command}\` exit 0.`;
  return `${goal}\n\nExit condition: \`${loop.command}\` exits 0. I re-run it every time you stop and send you back if it fails. ${RULE}`;
}

/**
 * Decide what happens when the agent is about to settle.
 * `outcome` is pi's activity outcome ("completed" | "aborted" | "error").
 * Returns { action: "done" | "continue" | "cap" | "halt", iteration, message?, summary }.
 */
export function decide(loop, outcome, result) {
  const iteration = loop.iteration + 1;
  if (outcome !== "completed") {
    return { action: "halt", iteration, summary: `run ${outcome}; loop stopped` };
  }
  if (result.code === 0) {
    return { action: "done", iteration, summary: "predicate passed" };
  }
  const output = tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const firstLine = output.split("\n").find((l) => l.trim() !== "") ?? "";
  const summary = `exit ${result.code}: ${firstLine}`.slice(0, 200);
  if (iteration >= loop.max) {
    return { action: "cap", iteration, summary: `${summary} (cap ${loop.max} reached)` };
  }
  const message = [
    `/until iteration ${iteration}/${loop.max}: \`${loop.command}\` exited ${result.code}. Not done.`,
    "",
    "```",
    output,
    "```",
    "",
    `Make the smallest change the evidence justifies, then stop so I can re-check. ${RULE} If this is a genuine dead end, say so plainly instead of spinning.`,
  ].join("\n");
  return { action: "continue", iteration, message, summary };
}

/** One TSV row; cells are single-line and spreadsheet-formula safe. */
export function tsvRow(cells) {
  return (
    cells
      .map((c) => {
        const s = String(c ?? "").replace(/[\t\r\n]+/g, " ");
        return /^[=+\-@]/.test(s) ? `'${s}` : s;
      })
      .join("\t") + "\n"
  );
}

export const TSV_HEADER = tsvRow(["ts", "iteration", "exit", "summary"]);

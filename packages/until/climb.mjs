// climb.mjs — pure logic for /climb, a metric loop: argument parsing, the
// keep-or-revert decision for one attempt, and the messages back to the agent.
// index.ts owns pi wiring, exec, the tree fingerprint and the filesystem.

import { tsvRow } from "../../shared/tsv.mjs";
import { RULE } from "./loop.mjs";

const DEFAULTS = { max: 20, min: 1, runs: 3, direction: "lower" };
const USAGE =
  'usage: /climb [--max N] [--min N] [--runs N] [--higher|--lower] --target <number> --gate "<cmd>" <metric-cmd> [-- task]';
/** Consecutive settles that count no attempt (no change, or no revert) before the loop halts. */
export const IDLE_LIMIT = 3;

export const CLIMB_TSV_HEADER = tsvRow([
  "ts",
  "iteration",
  "hypothesis",
  "before",
  "after",
  "range",
  "gate",
  "verdict",
]);

const FLAG = /^--(max|min|runs|target|gate|higher|lower)(?=\s|$)\s*/;
const VALUE = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))\s*/;

/**
 * Parse `/climb` arguments.
 *   ""      → { kind: "status" }
 *   "stop"  → { kind: "stop" }
 *   flags, then `<metric-cmd> [-- task]` → { kind: "start", ... }
 */
export function parseClimbArgs(raw) {
  let text = (raw ?? "").trim();
  if (text === "") return { kind: "status" };
  if (text === "stop") return { kind: "stop" };

  const opts = { ...DEFAULTS, target: undefined, gate: undefined };
  for (let flag = FLAG.exec(text); flag; flag = FLAG.exec(text)) {
    text = text.slice(flag[0].length);
    const name = flag[1];
    if (name === "higher" || name === "lower") {
      opts.direction = name;
      continue;
    }
    const value = VALUE.exec(text);
    if (!value) return { kind: "error", message: `--${name} needs a value. ${USAGE}` };
    text = text.slice(value[0].length);
    const word = value[1] !== undefined ? value[1].replace(/\\(.)/g, "$1") : (value[2] ?? value[3]);
    if (name === "gate") {
      opts.gate = word.trim();
      continue;
    }
    const n = Number(word);
    if (name === "target") {
      if (!Number.isFinite(n))
        return { kind: "error", message: `--target needs a number, got "${word}"` };
      opts.target = n;
    } else if (!Number.isInteger(n) || n < 1) {
      return { kind: "error", message: `--${name} needs a positive integer, got "${word}"` };
    } else {
      opts[name] = n;
    }
  }
  if (opts.runs < 3 || opts.runs > 10)
    return { kind: "error", message: "--runs needs 3 to 10 samples, so a range means something" };
  if (opts.min > opts.max) return { kind: "error", message: "--min cannot exceed --max" };
  if (opts.target === undefined)
    return { kind: "error", message: `--target is required. ${USAGE}` };
  if (!opts.gate) return { kind: "error", message: `--gate is required. ${USAGE}` };

  const split = text.indexOf(" -- ");
  const metric = (split === -1 ? text : text.slice(0, split)).trim();
  const task = split === -1 ? "" : text.slice(split + 4).trim();
  if (metric === "" || metric.startsWith("--")) return { kind: "error", message: USAGE };
  return { kind: "start", metric, task, ...opts };
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** `{median, min, max}` of a sample set. */
export function spread(samples) {
  return { median: median(samples), min: Math.min(...samples), max: Math.max(...samples) };
}

/** Whether `value` meets the target in the loop's direction. */
export function reachesTarget(direction, value, target) {
  return direction === "lower" ? value <= target : value >= target;
}

/**
 * Decide one measured attempt against the best accepted run. An attempt is kept
 * only when its whole range clears the best range in the loop's direction.
 * @param {{best:{median:number,min:number,max:number}, direction:"lower"|"higher",
 *          target:number, min:number, max:number, iteration:number, kept:number}} loop
 * @param {{gateCode:number, samples:number[], workOk:boolean, why?:string}} obs
 */
export function decideClimb(loop, obs) {
  const iteration = loop.iteration + 1;
  const measured = obs.workOk && obs.samples.length > 0;
  const {
    median: m,
    min: lo,
    max: hi,
  } = measured ? spread(obs.samples) : { median: NaN, min: NaN, max: NaN };
  const better = loop.direction === "lower" ? hi < loop.best.min : lo > loop.best.max;
  const reached = reachesTarget(loop.direction, m, loop.target);

  let verdict;
  if (obs.gateCode !== 0) verdict = { keep: false, why: `gate exited ${obs.gateCode}` };
  else if (!measured)
    verdict = { keep: false, why: obs.why ?? "metric did not report completed work" };
  else if (!better) verdict = { keep: false, why: "ranges overlap the best accepted run" };
  else verdict = { keep: true, why: `median ${loop.best.median} -> ${m}` };

  const kept = loop.kept + (verdict.keep ? 1 : 0);
  const out = { iteration, kept, verdict, m, lo, hi };
  // A target met before the attempt floor does not end the run: one lucky sample is not a result.
  if (verdict.keep && reached && iteration >= loop.min) return { action: "done", ...out };
  if (iteration >= loop.max) return { action: "cap", ...out };
  return { action: "continue", ...out };
}

/** `33.1 [32.4, 35.0]` */
export function formatRange(r) {
  return Number.isFinite(r.median) ? `${r.median} [${r.min}, ${r.max}]` : "no measurement";
}

/** The hypothesis the agent named in its last message, or its first line. */
export function hypothesisOf(text) {
  const named = /^[\s*_>-]*hypothesis[*_]*\s*:\s*(.+)$/im.exec(text ?? "");
  const line = named ? named[1] : ((text ?? "").split("\n").find((l) => l.trim()) ?? "");
  return line.replace(/[*_`]/g, "").trim().slice(0, 160);
}

const NEXT =
  "Make one change that names its mechanism, start your last message with `Hypothesis: <mechanism>`, then stop so I can measure it.";

/** The first prompt, sent once the baseline is measured and the gate is green. */
export function climbKickoff(loop) {
  const goal =
    loop.task ||
    `Move \`${loop.metric}\` ${loop.direction === "lower" ? "down" : "up"} to ${loop.target}.`;
  return [
    goal,
    "",
    `Baseline: ${formatRange(loop.best)} · target ${loop.target} (${loop.direction} is better) · gate \`${loop.gate}\``,
    "",
    `${NEXT} Each time you stop I run the gate and the metric ${loop.runs} times; an attempt is kept only when the gate passes and its whole range clears the best one. ${RULE}`,
  ].join("\n");
}

/** The message after a measured attempt that did not end the loop. */
export function attemptMessage(loop, decision) {
  const head = `/climb attempt ${decision.iteration}/${loop.max}`;
  const now = formatRange({ median: decision.m, min: decision.lo, max: decision.hi });
  if (decision.verdict.keep) {
    return [
      `${head}: kept (${decision.verdict.why}).`,
      `best ${now} · target ${loop.target}`,
      "",
      `This tree is the new accepted state. /climb never commits; commit it only if the user has authorised commits. ${NEXT}`,
    ].join("\n");
  }
  return [
    `${head}: rejected (${decision.verdict.why}).`,
    `best ${formatRange(loop.best)} · this attempt ${now} · target ${loop.target}`,
    "",
    "Revert this attempt in full, then stop so I can confirm the tree matches the last accepted state.",
    "Three rejects in a row: change category, combine near-misses, or re-read the source.",
    RULE,
  ].join("\n");
}

/** The message for a settle that counted no attempt. */
export function idleMessage(reason) {
  if (reason === "reverted") return `/climb: revert confirmed. ${NEXT}`;
  if (reason === "unreverted")
    return `/climb: the tree does not match the last accepted state, so no attempt was counted. Revert the rejected attempt in full (including new files), then stop.`;
  return `/climb: nothing changed since the last accepted state, so no attempt was counted. ${NEXT}`;
}

#!/usr/bin/env node
// promote-corrections.mjs — turn a repeated correction into the cheapest fix
// that would have stopped it.
//
// /mine finds the clusters; this decides what to do with each one. The
// judgement is a Choice over the promotion tiers, in the order a maintainer
// should try them: a test or lint that catches it mechanically beats a policy
// that interrupts, which beats a line of prose the model may not read.
//
// A second question separates "the guidance is missing" from "the guidance was
// there and was ignored", which is the difference between writing a new line and
// fixing why the old one did not land.
//
// Read-only: it prints, and changes nothing.
//
//   node scripts/promote-corrections.mjs --corrections clusters.json \
//     --guidance AGENTS.md

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { askSystemOne, usableNumber } from "../shared/systemone.mjs";

export const MAX_CORRECTIONS = 12;
const MAX_CORRECTION_CHARS = 500;
const MAX_GUIDANCE_CHARS = 8000;

export const PROMOTIONS = {
  test: "A test or assertion would catch it: the correction is a behaviour the checks can exercise.",
  lint: "A lint rule, type check or script check would catch it: the correction is a rule about shape.",
  guardrail:
    "A tool-call policy would catch it: the correction is about an action that must be confirmed or refused.",
  agents:
    "A line in AGENTS.md would change the behaviour: the correction is a standing preference.",
  prompt:
    "A prompt template or skill would make the right steps the default: the correction is a repeated workflow.",
  none: "Nothing durable applies: the correction was task-specific and would mislead later work.",
};

/** A backticked reference to a state path, the way these prompts name their input. */
const q = (name) => "`" + name + "`";

/** One correction, whatever the caller called its text field. */
export function normalizeCluster(item) {
  const text = typeof item === "string" ? item : (item?.correction ?? item?.text ?? "");
  return {
    text: String(text).trim().slice(0, MAX_CORRECTION_CHARS),
    occurrences: Math.max(1, Number(item?.occurrences) || 1),
  };
}

/**
 * Accept the two shapes the mining step produces: a JSON array (strings or
 * {correction, occurrences}) or one correction per line.
 */
export function parseClusters(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("the JSON must be an array of corrections");
    return parsed.map(normalizeCluster).filter((item) => item.text);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => ({ text: line.slice(0, MAX_CORRECTION_CHARS), occurrences: 1 }));
}

export function buildQuestions(count, { guidance } = {}) {
  const questions = {};
  for (let index = 0; index < count; index += 1) {
    const path = "corrections." + index + ".text";
    questions["promotion_" + index] = {
      type: "choice",
      instructions:
        "Read " +
        q(path) +
        " and its " +
        q("corrections." + index + ".occurrences") +
        " in the state: a correction the user had to give more than once. What is the cheapest " +
        "durable fix that would have stopped it recurring? Prefer a check over an interruption, " +
        "and an interruption over prose. Answer 'none' when the correction was specific to that " +
        "task and a durable rule would misfire later.",
      criteria: PROMOTIONS,
    };
    if (guidance) {
      questions["already_covered_" + index] = {
        type: "noul",
        instructions:
          "Read " +
          q(path) +
          " and " +
          q("guidance") +
          ". Does the guidance already state " +
          "this, or come close enough that a reader would have applied it? The correction then " +
          "points at guidance that was ignored or unavailable, not at guidance that is missing.",
        criteria: {
          true: "The guidance already says this, or close enough that it applies.",
          false: "Nothing in the guidance covers it.",
        },
      };
    }
  }
  return questions;
}

/**
 * Ask once for every cluster. One request: the corrections share one state, and
 * a per-cluster request would pay for the guidance over and over.
 */
export async function promoteCorrections({
  corrections,
  guidance,
  model,
  env,
  ask = askSystemOne,
} = {}) {
  // Normalized here, not left to the caller: a `{correction}` item straight
  // from the mining step is the common shape, and `text: undefined` in the
  // state is rejected before a request is ever sent.
  const list = (corrections ?? [])
    .map(normalizeCluster)
    .filter((item) => item.text)
    .slice(0, MAX_CORRECTIONS);
  if (list.length === 0) {
    return { rows: [], judged: false, reason: "no corrections to promote" };
  }
  const questions = buildQuestions(list.length, { guidance });
  const state = {
    corrections: list.map((item) => ({ text: item.text, occurrences: item.occurrences ?? 1 })),
    guidance: guidance ? String(guidance).slice(0, MAX_GUIDANCE_CHARS) : null,
  };
  try {
    const result = await ask({ state, questions, model, env });
    const rows = list.map((item, index) => {
      const choice = result?.answers?.["promotion_" + index];
      const promotion =
        choice?.type === "choice" && Object.hasOwn(PROMOTIONS, choice.choice)
          ? choice.choice
          : null;
      const covered = usableNumber(result?.answers?.["already_covered_" + index]?.noul);
      return { ...item, promotion, covered, judged: promotion !== null };
    });
    const judged = rows.some((row) => row.judged);
    return {
      rows,
      judged,
      reason: judged ? undefined : "the model returned no usable promotion",
      model: result?.model,
      usage: result?.usage ?? null,
    };
  } catch (error) {
    return {
      rows: list.map((item) => ({ ...item, promotion: null, covered: null, judged: false })),
      judged: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatPromotions({ rows, judged, reason } = {}) {
  const lines = [];
  if (!judged) lines.push("Not promoted: " + (reason ?? "no judgment"));
  for (const [index, row] of (rows ?? []).entries()) {
    const where = row.promotion ? row.promotion.padEnd(9) : "?".padEnd(9);
    const covered =
      typeof row.covered === "number" ? " · already covered " + row.covered.toFixed(2) : "";
    lines.push(index + 1 + ". " + where + covered + " — " + row.text);
    if (row.promotion) lines.push("   " + PROMOTIONS[row.promotion]);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const flags = { corrections: null, guidance: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--corrections") flags.corrections = argv[++index];
    else if (argv[index] === "--guidance") flags.guidance = argv[++index];
  }
  return flags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = parseArgs(process.argv.slice(2));
  const raw =
    flags.corrections && flags.corrections !== "-"
      ? fs.readFileSync(flags.corrections, "utf8")
      : fs.readFileSync(0, "utf8");
  const guidance = flags.guidance ? fs.readFileSync(flags.guidance, "utf8") : undefined;
  const corrections = parseClusters(raw);
  const result = await promoteCorrections({ corrections, guidance });
  if (!result.judged) {
    console.error("promote-corrections: " + result.reason);
    process.exitCode = 1;
  } else {
    console.log(formatPromotions(result));
  }
}

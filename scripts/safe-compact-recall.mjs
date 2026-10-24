// safe-compact-recall — does a handoff still carry what the session knew, and
// does it claim things the session never said?
//
// Point it at a session that has been compacted (or at a handoff file) and it
// asks Jev two things: for every instruction the user gave before the cut, does
// the handoff still convey it or point at where it is written; and for every
// line of the handoff, does the replaced session support it.
//
//   node scripts/safe-compact-recall.mjs --session newest [--max 12] [--json]
//   node scripts/safe-compact-recall.mjs --handoff handoff.md --session <file>
//
// The first number is retention, the second is grounding: a handoff that keeps
// everything and invents half of it is worse than one that keeps less.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { memoizeAsk } from "../packages/safe-compact/plan.mjs";
import { mapPool, yes } from "../shared/spans.mjs";
import { askSystemOne } from "../shared/systemone.mjs";
import { validateRequest } from "../shared/systemone-request.mjs";

// The handoff rides in the state beside the fact being checked, and a state past
// Jev's 60000-character limit fails whole. Measured handoffs run 10-58k
// characters; the guard is for the ones that do not.
const MAX_STATE_CHARS = 60_000;
const MAX_FACT_CHARS = 1_500;
const EXCERPT_CHARS = 40_000;
const CONCURRENCY = 8;

const BULLET = /^\s*(?:[-*+]|\d+\.)\s+/;

/**
 * At most max items, first and last included: in a handoff the opening is the
 * task and the end is where the work got to, so a sample that stops short of
 * either reads as a gap in the handoff rather than in the sample.
 */
function sampleEvenly(items, max) {
  if (items.length <= max) return items;
  if (max <= 1) return items.slice(0, Math.max(max, 0));
  return Array.from(
    { length: max },
    (_, index) => items[Math.round((index * (items.length - 1)) / (max - 1))],
  );
}

/** Lines worth asking about: long enough to carry a fact, and not duplicates. */
export function meaningfulLines(text, { minChars = 20, max = 0, onlyBullets = false } = {}) {
  const seen = new Set();
  const lines = [];
  for (const raw of String(text ?? "").split("\n")) {
    const bullet = BULLET.test(raw);
    if (onlyBullets && !bullet) continue;
    const line = (bullet ? raw.replace(BULLET, "") : raw).trim();
    if (line.length < minChars || seen.has(line)) continue;
    seen.add(line);
    lines.push(line.slice(0, MAX_FACT_CHARS));
  }
  return max > 0 ? sampleEvenly(lines, max) : lines;
}

/**
 * Instructions the user gave in the replaced part of the session.
 *
 * The most recent ones, and deliberately not the opening request: by the time a
 * session is long enough to compact, its original task is usually finished, so
 * a handoff that no longer mentions it is right rather than forgetful. What is
 * being measured is the instructions still in force when the handoff was
 * written — dropping one of those is what makes the next agent get it wrong.
 */
export function constraintsFrom(messages, { max = 12 } = {}) {
  const lines = messages
    .filter((message) => message.role === "user")
    .flatMap((message) => meaningfulLines(message.text, { minChars: 25 }));
  return lines.slice(-max);
}

/**
 * What the handoff asserts: its bullet lines, sampled across its length, or
 * every long line if it was written without bullets.
 */
export function claimsFrom(handoff, { max = 12 } = {}) {
  const bullets = meaningfulLines(handoff, { minChars: 30, max, onlyBullets: true });
  return bullets.length > 0 ? bullets : meaningfulLines(handoff, { minChars: 40, max });
}

export function retentionQuestion() {
  return {
    conveyed: {
      type: "noul",
      instructions:
        "The state holds a `handoff`: a summary written to replace the earlier part of a working " +
        "session, and a `constraint`: an instruction the user gave before that summary was written. " +
        "Does the handoff carry it — stating it, pointing at where it is written, or showing that the " +
        "work it asked for was done? An instruction the handoff neither carries nor shows to be " +
        "finished cannot be followed or safely skipped by the agent that reads it.",
      criteria: {
        true: "The instruction is stated, pointed at, or shown to be carried out and no longer open.",
        false: "The handoff says nothing about it and nothing about the work it asked for.",
      },
    },
  };
}

export function groundingQuestion() {
  return {
    supported: {
      type: "choice",
      instructions:
        "The state holds an `excerpt` of a session's messages and a `claim` taken from a handoff " +
        "written about that session. Is the claim supported by the excerpt, contradicted by it, or " +
        "about something the excerpt does not cover? Choose not_in_excerpt when the excerpt is " +
        "silent — silence is not evidence either way.",
      criteria: {
        supported: "The excerpt states or implies this.",
        contradicted:
          "The excerpt says otherwise, or the claim misattributes who said or did what.",
        not_in_excerpt: "The excerpt does not cover this.",
      },
    },
  };
}

/**
 * Retention counts what the handoff still conveys, as text or as a pointer;
 * grounding counts what the session supports. not_in_excerpt is not a failure:
 * the excerpt is a sample, so the fact may simply be outside it.
 */
export function summarise({ constraints, claims, retention, grounding }) {
  const scored = retention.filter((value) => typeof value === "number");
  const kept = scored.filter((value) => value >= 0.5).length;
  const counts = { supported: 0, contradicted: 0, not_in_excerpt: 0 };
  const contradictedClaims = [];
  claims.forEach((claim, index) => {
    if (grounding[index] === "supported") counts.supported += 1;
    else if (grounding[index] === "contradicted") {
      counts.contradicted += 1;
      contradictedClaims.push(claim);
    } else counts.not_in_excerpt += 1;
  });
  const missed = constraints.filter(
    (_, index) => typeof retention[index] === "number" && retention[index] < 0.5,
  );
  const unreadable = retention.filter((value) => typeof value !== "number").length;
  return {
    missed,
    unreadable,
    retention: {
      kept,
      of: scored.length,
      // A null is an answer nobody could read, not a constraint Jev said was
      // dropped: it is reported rather than counted as either.
      unreadable,
      mean: scored.length
        ? Number((scored.reduce((sum, value) => sum + value, 0) / scored.length).toFixed(3))
        : null,
      dropped: missed.length,
    },
    // Claims outside the excerpt are unscored, not failed: the excerpt is a
    // sample of the replaced session, and the checkable set is what grounding
    // can be judged on. Coverage says how much of the session it stood for.
    grounding: {
      ...counts,
      of: claims.length,
      checkable: counts.supported + counts.contradicted,
      contradictedClaims,
    },
  };
}

/** Text of one message entry, whatever shape its content took. */
export function messageText(message) {
  const content = message?.content ?? message?.summary ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => (typeof part === "string" ? part : (part?.text ?? part?.output ?? "")))
    .filter(Boolean)
    .join("\n");
}

export function readSession(file) {
  const entries = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const compactions = entries.filter((entry) => entry?.type === "compaction");
  return { entries, compactions };
}

/**
 * The part of a session a compaction replaced, and the handoff that replaced
 * it: the messages before that entry, and its summary. Index -1 is the newest.
 */
export function splitAtCompaction({ entries }, index = -1) {
  const positions = entries
    .map((entry, position) => (entry?.type === "compaction" ? position : -1))
    .filter((position) => position >= 0);
  const position = positions.at(index);
  if (position === undefined) return null;
  const replaced = entries
    .slice(0, position)
    .filter((entry) => entry?.type === "message" && entry.message)
    .map((entry) => ({ role: entry.message.role, text: messageText(entry.message) }));
  const entry = entries[position];
  return {
    replaced,
    handoff: String(entry.summary ?? ""),
    details: entry.details ?? null,
    tokensBefore: entry.tokensBefore ?? null,
  };
}

/**
 * The replaced messages as one excerpt, sampled evenly across the whole span
 * rather than from the head: a claim in a handoff usually comes from the end of
 * the session, and answering "not_in_excerpt" for claims the excerpt never
 * reached would read as a grounding failure when it is a sampling one.
 */
export function excerptOf(replaced, { budget = EXCERPT_CHARS, perMessage = 2_000 } = {}) {
  const pieces = [];
  for (const message of replaced) {
    const text = String(message.text ?? "").trim();
    if (!text) continue;
    pieces.push(message.role + ": " + text.slice(0, perMessage));
  }
  if (pieces.length === 0) return "";
  const wanted = Math.max(1, Math.floor(budget / perMessage));
  return sampleEvenly(pieces, wanted).join("\n\n").slice(0, budget);
}

/** Newest session with a compaction, or the named one. */
export function findSession(selector = "newest") {
  const root = path.join(homedir(), ".pi", "agent", "sessions");
  const files = readdirSync(root).flatMap((dir) => {
    const base = path.join(root, dir);
    if (!statSync(base).isDirectory()) return [];
    return readdirSync(base)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(base, name));
  });
  if (selector && selector !== "newest") {
    const match = files.find((file) => path.basename(file) === selector || file === selector);
    if (!match) throw new Error("no session file matching " + selector);
    return match;
  }
  const compacted = files.filter((file) => readSession(file).compactions.length > 0);
  if (compacted.length === 0) throw new Error("no compacted session found");
  compacted.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return compacted[0];
}

export async function examine({
  replaced,
  handoff,
  max = 12,
  ask = askSystemOne,
  signal,
  coverage = null,
}) {
  const constraints = constraintsFrom(replaced, { max });
  const claims = claimsFrom(handoff, { max });
  const budget = MAX_STATE_CHARS - MAX_FACT_CHARS - 4_000;
  if (handoff.length > budget) {
    throw new Error(
      "handoff is " +
        handoff.length +
        " characters; the exam holds it beside each fact, so it has to be under " +
        budget,
    );
  }
  const answered = memoizeAsk(ask);
  const retention = await mapPool(
    constraints,
    async (constraint) => {
      const { answers } = await answered({
        state: { handoff, constraint },
        questions: retentionQuestion(),
        signal,
      });
      return yes(answers?.conveyed);
    },
    CONCURRENCY,
  );
  const excerpt = excerptOf(replaced);
  const grounding = await mapPool(
    claims,
    async (claim) => {
      const { answers } = await answered({
        state: { excerpt, claim },
        questions: groundingQuestion(),
        signal,
      });
      return typeof answers?.supported?.choice === "string" ? answers.supported.choice : null;
    },
    CONCURRENCY,
  );
  const summary = summarise({ constraints, claims, retention, grounding });
  return { constraints, claims, retention, grounding, coverage, summary };
}

const oneLine = (text, limit) => String(text).replace(/\s+/g, " ").slice(0, limit);

function report({ target, split, result, handoffChars, userLines }) {
  const safeCompact = split.details?.safeCompact ?? null;
  const lines = ["# Recall exam — " + path.basename(target), ""];
  lines.push(
    safeCompact
      ? "handoff: " +
          handoffChars +
          " chars from " +
          safeCompact.segments +
          " segments, " +
          safeCompact.kept +
          " entries (" +
          safeCompact.forced +
          " forced by verification), replacing ~" +
          (split.tokensBefore ?? "?") +
          " tokens"
      : "handoff: " + handoffChars + " chars (not written by safe-compact)",
  );
  lines.push("");
  lines.push(
    "retention   " +
      result.summary.retention.kept +
      "/" +
      result.summary.retention.of +
      " instructions still in force are conveyed (mean p=" +
      result.summary.retention.mean +
      "), sampled from the last " +
      result.summary.retention.of +
      " of " +
      userLines +
      " user lines before the cut" +
      (result.summary.retention.unreadable
        ? ", " + result.summary.retention.unreadable + " unreadable"
        : ""),
  );
  lines.push(
    "grounding   " +
      result.summary.grounding.contradicted +
      " of " +
      result.summary.grounding.checkable +
      " checkable claims contradicted (" +
      result.summary.grounding.supported +
      " supported, " +
      result.summary.grounding.not_in_excerpt +
      " outside a " +
      (result.coverage ? Math.round(result.coverage * 100) + "%" : "partial") +
      " excerpt of the session)",
  );
  for (const missed of result.summary.missed) {
    lines.push("  dropped: " + oneLine(missed, 110));
  }
  for (const claim of result.summary.grounding.contradictedClaims) {
    lines.push("  unsupported: " + oneLine(claim, 110));
  }
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      session: { type: "string", default: "newest" },
      handoff: { type: "string" },
      max: { type: "string", default: "12" },
      json: { type: "boolean", default: false },
    },
  });
  const target = findSession(values.session);
  const split = splitAtCompaction(readSession(target));
  if (!split) throw new Error(path.basename(target) + " has no compaction entry");
  const handoff = values.handoff ? readFileSync(values.handoff, "utf8") : split.handoff;
  const excerptChars = excerptOf(split.replaced).length;
  const replacedChars = split.replaced.reduce(
    (sum, message) => sum + String(message.text ?? "").length,
    0,
  );
  const coverage = replacedChars > 0 ? excerptChars / replacedChars : null;
  const result = await examine({
    replaced: split.replaced,
    handoff,
    max: Number(values.max),
    coverage,
  });
  const userLines = split.replaced.filter((message) => message.role === "user").length;
  if (values.json) {
    console.log(
      JSON.stringify(
        {
          target,
          replacedMessages: split.replaced.length,
          handoffChars: handoff.length,
          ...result,
        },
        null,
        1,
      ),
    );
    return;
  }
  console.log(report({ target, split, result, handoffChars: handoff.length, userLines }));
}

// Only when run as a script: the tests import this module, and an import that
// quietly starts a paid exam is the kind of thing that survives review.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The question sets are checked by the same validator the transport uses, so
  // this script cannot ask about state it did not send.
  validateRequest({ state: { handoff: "x", constraint: "y" }, questions: retentionQuestion() });
  validateRequest({ state: { excerpt: "x", claim: "y" }, questions: groundingQuestion() });
  try {
    await main();
  } catch (error) {
    // A handoff too big to fit in the state is a refusal, not a crash: the
    // operator needs the size and the limit, not a stack trace.
    console.error(error.message);
    process.exitCode = 1;
  }
}

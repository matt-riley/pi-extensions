// plan-check.mjs — fresh-context plan comprehension check (/plan check).
//
// One hidden read-only child reads only the plan file (and files the plan
// names), restates it under two headings, lists gaps, then Jev judges whether
// the restatement matches the plan goal and whether steps assume unstated
// facts. Opt-in and advisory: it never blocks /plan approve.

import { askSystemOne, usableNumber } from "../../shared/systemone.mjs";
import { CROSS_FAMILY, resolveCrossFamily } from "../subagents/cross-family.mjs";
import { physicalParentKeyForCrossFamily } from "../router/parent-physical.mjs";

const READER_MAX_TURNS = 8;
const READER_TIMEOUT_MS = 120_000;
const JEV_TIMEOUT_MS = 12_000;
const MISSING = 0.5;

const q = (name) => "`" + name + "`";

export function buildReaderAgent() {
  return {
    name: "plan-reader",
    model: CROSS_FAMILY,
    systemPrompt: [
      "You are an isolated plan reviewer with no conversation history.",
      "You may read files and run read-only inspection commands only.",
      "You cannot edit, write, install, or spawn other agents.",
      "",
      "Read the plan file path you are given. You may also read files the plan references.",
      "",
      "Reply with exactly these Markdown sections:",
      "",
      "## What the plan changes",
      "Plain-language summary of the user-visible or behavioral change.",
      "",
      "## How it will be done",
      "The main steps and touchpoints, in order, without inventing details.",
      "",
      "## Gaps",
      "Bullet list of: undefined terms, steps that assume facts the plan never states,",
      "and missing verification. If you find none, write a single bullet: - (none identified).",
    ].join("\n"),
  };
}

/** Task text for runChild — only the plan path, no chat or inlined plan body. */
export function buildReaderTask(planPath) {
  return [
    "Read the implementation plan at this path:",
    String(planPath ?? "").trim(),
    "",
    "Produce your report using the required section headings from your instructions.",
    "You have no other briefing.",
  ].join("\n");
}

/** First Markdown H1, or the first non-empty line. */
export function extractPlanGoal(plan) {
  const body = String(plan ?? "");
  const title = body.match(/^#\s+(.+)$/m);
  if (title?.[1]) return title[1].trim();
  const line = body
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find(Boolean);
  return line ?? "";
}

function sectionBody(text, heading) {
  const lines = String(text ?? "").split(/\r?\n/);
  const marker = `## ${heading}`.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().toLowerCase() === marker) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

function hasSectionHeading(text, heading) {
  const marker = `## ${heading}`.toLowerCase();
  return String(text ?? "")
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase() === marker);
}

function gapBullets(gapsSection) {
  const lines = String(gapsSection ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 0);
  return lines;
}

function readerReportUsable(parsed) {
  if (!parsed) return false;
  return Boolean(parsed.whatChanges?.trim() && parsed.howDone?.trim());
}

export function parseReaderReport(text) {
  const whatChanges = sectionBody(text, "What the plan changes");
  const howDone = sectionBody(text, "How it will be done");
  const hasGapsSection = hasSectionHeading(text, "Gaps");
  const gaps = gapBullets(sectionBody(text, "Gaps"));
  return { whatChanges, howDone, gaps, hasGapsSection, raw: String(text ?? "").trim() };
}

export function buildComprehensionQuestions() {
  return {
    same_as_goal: {
      type: "noul",
      instructions:
        "Compare " +
        q("goal") +
        " with " +
        q("whatChanges") +
        ". Does the restatement under whatChanges describe the same change the plan goal names?",
      criteria: {
        true: "The restatement matches the plan goal in scope and intent.",
        false: "The restatement misses, narrows, or changes what the plan goal says.",
      },
    },
    unstated_dependency: {
      type: "noul",
      instructions:
        "Read " +
        q("howDone") +
        ", " +
        q("gaps") +
        ", and " +
        q("goal") +
        ". Does any step or gap show that implementation depends on a fact, file, API, or decision the plan text never states?",
      criteria: {
        true: "At least one step relies on something unstated in the plan.",
        false: "Nothing in the report points to an unstated dependency.",
      },
    },
  };
}

function formatVerdictLine(label, value) {
  const score = usableNumber(value);
  if (score === null) {
    return `- ${label}: not run (no verdict)`;
  }
  const word = score >= MISSING ? "yes" : "no";
  return `- ${label}: ${word} (TypeSafe ${score.toFixed(2)})`;
}

export function formatComprehensionAppendix({
  goal,
  readerOk,
  readerStatus,
  readerReason,
  parsed,
  jev,
} = {}) {
  const lines = ["## Plan comprehension check", ""];
  if (!readerOk) {
    const reason = readerReason || readerStatus || "unknown";
    lines.push(`Fresh-context reader: not run (${reason}).`);
    lines.push("");
    lines.push("TypeSafe verdict: not run (reader did not finish).");
    return lines.join("\n");
  }

  lines.push("### What the plan changes");
  lines.push("");
  lines.push(parsed?.whatChanges || "(reader did not supply this section)");
  lines.push("");
  lines.push("### How it will be done");
  lines.push("");
  lines.push(parsed?.howDone || "(reader did not supply this section)");
  lines.push("");
  lines.push("### Gaps");
  lines.push("");
  if (parsed?.gaps?.length) {
    for (const gap of parsed.gaps) lines.push(`- ${gap}`);
  } else if (parsed?.hasGapsSection) {
    lines.push("- (reader listed no gaps)");
  } else {
    lines.push("- (reader gave no Gaps section)");
  }
  lines.push("");
  if (!jev?.judged) {
    const why = jev?.reason ? ` (${jev.reason})` : "";
    lines.push(`TypeSafe verdict: not run${why}.`);
    return lines.join("\n");
  }
  lines.push("TypeSafe verdict:");
  lines.push(formatVerdictLine("Same change as the plan goal", jev.answers?.same_as_goal?.noul));
  lines.push(
    formatVerdictLine(
      "Depends on something the plan never states",
      jev.answers?.unstated_dependency?.noul,
    ),
  );
  if (goal) {
    lines.push("");
    lines.push(`Plan goal read for judgment: ${goal}`);
  }
  return lines.join("\n");
}

/** Resolve the cross-family model for the hidden plan reader. */
export async function resolvePlanCheckModel(modelRegistry, parentModel, ctx, routerFile) {
  const file = String(routerFile ?? "").trim();
  if (!file) {
    throw new Error("routerFile is required to resolve the plan reader model");
  }
  const { model } = await resolveCrossFamily(modelRegistry, parentModel, file, {
    physicalParentKey: physicalParentKeyForCrossFamily(parentModel, ctx, file),
  });
  return model;
}

/**
 * Run the comprehension check. Returns { appendix, notify }.
 * appendix is null only when there is no plan to check.
 */
export async function runPlanComprehensionCheck({
  planPath,
  planText,
  cwd = process.cwd(),
  env = process.env,
  modelRegistry,
  parentModel,
  ctx,
  routerFile,
  runChild: runChildFn,
  ask = askSystemOne,
  resolveModel,
  maxTurns = READER_MAX_TURNS,
  timeoutMs = READER_TIMEOUT_MS,
  feature = "plan-check",
} = {}) {
  const pathValue = typeof planPath === "string" ? planPath.trim() : "";
  const text = String(planText ?? "").trim();
  if (!pathValue || !text) {
    return { appendix: null, notify: "No plan file yet — finish planning first." };
  }

  const goal = extractPlanGoal(text);
  const agent = buildReaderAgent();
  const task = buildReaderTask(pathValue);

  let readerResult;
  try {
    const runChild = runChildFn ?? (await import("../subagents/spawn.mjs")).runChild;
    const pickModel =
      resolveModel ??
      ((registry, parent, commandCtx) =>
        resolvePlanCheckModel(registry, parent, commandCtx, routerFile));
    const model = await pickModel(modelRegistry, parentModel, ctx);
    readerResult = await runChild({
      cwd,
      agent,
      task,
      model,
      maxTurns,
      timeoutMs,
    });
  } catch (error) {
    readerResult = {
      status: "error",
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const readerFinished =
    readerResult?.status === "completed" || readerResult?.status === "wrapped up";
  const parsed = readerFinished ? parseReaderReport(readerResult.text) : null;
  const readerUsable = readerFinished && readerReportUsable(parsed);
  let readerReason =
    readerResult?.error || (readerFinished ? null : readerResult?.status || "failed");
  if (readerFinished && !readerUsable) {
    readerReason = "reader returned no usable report";
  }

  let jev = { judged: false, reason: null, answers: null };
  if (readerUsable && parsed) {
    try {
      const judged = await ask({
        state: {
          goal,
          whatChanges: parsed.whatChanges,
          howDone: parsed.howDone,
          gaps: parsed.gaps.join("\n"),
        },
        questions: buildComprehensionQuestions(),
        env,
        feature,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      const same = usableNumber(judged?.answers?.same_as_goal?.noul);
      const dep = usableNumber(judged?.answers?.unstated_dependency?.noul);
      jev = {
        judged: same !== null || dep !== null,
        reason: null,
        answers: judged?.answers,
        model: judged?.model,
      };
    } catch (error) {
      jev = {
        judged: false,
        reason: error instanceof Error ? error.message : String(error),
        answers: null,
      };
    }
  }

  const appendix = formatComprehensionAppendix({
    goal,
    readerOk: readerUsable,
    readerStatus: readerResult?.status,
    readerReason,
    parsed,
    jev,
  });

  return { appendix, notify: "Plan comprehension check appended to the plan file." };
}

#!/usr/bin/env node
// ci-triage.mjs — classify one CI failure from its log.
//
// /triage --ci does the mechanical half in bash and gh: which run, which
// attempt, which job, which step. This is the judgment half, and it is the same
// judgment every time: is this a flake to re-run, a regression to fix, a broken
// runner, a configuration gap, or a dependency that moved?
//
// Read-only: it reads a log file (or stdin) and prints.
//
//   gh run view <id> --job <job> --log-failed > /tmp/job.log
//   node scripts/ci-triage.mjs --log /tmp/job.log --step "npm run check" --reruns 1
//
// A re-run count is evidence, not decoration: the same commit failing twice is a
// different diagnosis from failing once.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { askSystemOne } from "../shared/systemone.mjs";

/** The tail matters most: a log names the error where it stops. */
export const MAX_LOG_CHARS = 6000;

export const CLASSES = {
  flaky:
    "Non-deterministic: a timeout, a network blip, a race, or the same commit failed and then passed on a re-run.",
  regression:
    "This change broke it: the failing step exercises code the branch changed, and the error names a real defect.",
  infra:
    "The runner failed: out of disk or memory, rate limited, a service outage, a cancelled job, or a machine that died.",
  configuration:
    "The workflow or repository is misconfigured: a missing secret, a bad path, an unsupported action version, or a permission the job lacks.",
  dependency:
    "Something upstream moved: a new release, a lockfile resolution, a removed API, or a version that pins to nothing.",
};

export function logTail(text, max = MAX_LOG_CHARS) {
  const body = String(text ?? "");
  if (body.length <= max) return { text: body, truncated: false };
  return { text: body.slice(body.length - max), truncated: true };
}

/**
 * The state the question reads. Named fields, not prose: the model gets the
 * step, the attempt history and the log, and nothing has to be inferred from
 * how the caller phrased the request.
 */
export function buildTriageState({ step, log, reruns = 0 } = {}) {
  const tail = logTail(log);
  return {
    state: {
      failing_step: step ?? null,
      prior_reruns: Math.max(0, Number(reruns) || 0),
      log: tail.text,
      log_truncated: tail.truncated,
    },
    truncated: tail.truncated,
  };
}

/** A backticked reference to a state path, the way these prompts name their input. */
const q = (name) => "`" + name + "`";

export function buildQuestionSet() {
  return {
    kind: {
      type: "choice",
      instructions:
        "Read " +
        q("log") +
        ", " +
        q("failing_step") +
        " and " +
        q("prior_reruns") +
        " in the state. What kind of failure is this? Judge the evidence in the log, not how " +
        "the job is named. When the log shows a real defect and also a retry, the defect is " +
        "the answer.",
      criteria: CLASSES,
    },
  };
}

/** The class a person can act on, with its confidence, or null. */
export function routeTriage(answers) {
  const answer = answers?.kind;
  if (!answer || answer.type !== "choice") return null;
  const kind = typeof answer.choice === "string" ? answer.choice : "";
  if (!Object.hasOwn(CLASSES, kind)) return null;
  const confidence = Number(answer.confidence);
  return {
    kind,
    confidence: Number.isFinite(confidence) ? confidence : null,
    probabilities: answer.probabilities ?? {},
  };
}

export function formatTriage({ kind, confidence, probabilities } = {}) {
  if (!kind) return "No usable classification.";
  const sure = confidence === null ? "" : " (confidence " + confidence.toFixed(2) + ")";
  const distribution = Object.entries(probabilities ?? {})
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([name, value]) => name + " " + Number(value).toFixed(2))
    .join(" · ");
  return (
    "kind: " + kind + sure + "\n" + (distribution ? "  " + distribution + "\n" : "") + CLASSES[kind]
  );
}

/**
 * Ask. Returns a classification or a reason it could not be made — the caller
 * prints, and an explicit request that fails says so rather than guessing.
 */
export async function classifyCi({ step, log, reruns = 0, model, env, ask = askSystemOne } = {}) {
  const { state, truncated } = buildTriageState({ step, log, reruns });
  if (!state.log.trim()) {
    return { judged: false, reason: "the log is empty", truncated };
  }
  try {
    const result = await ask({ state, questions: buildQuestionSet(), model, env });
    const routed = routeTriage(result?.answers);
    if (!routed) {
      return { judged: false, reason: "the model returned no usable classification", truncated };
    }
    return {
      ...routed,
      judged: true,
      truncated,
      model: result?.model,
      usage: result?.usage ?? null,
    };
  } catch (error) {
    return {
      judged: false,
      reason: error instanceof Error ? error.message : String(error),
      truncated,
    };
  }
}

function parseArgs(argv) {
  const flags = { log: null, step: null, reruns: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--log") flags.log = argv[++index];
    else if (arg === "--step") flags.step = argv[++index];
    else if (arg === "--reruns") flags.reruns = Number(argv[++index]) || 0;
    else if (arg.startsWith("--")) {
      console.error("ci-triage: unknown flag " + arg);
      process.exit(2);
    }
  }
  return flags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = parseArgs(process.argv.slice(2));
  const log =
    flags.log && flags.log !== "-"
      ? fs.readFileSync(flags.log, "utf8")
      : fs.readFileSync(0, "utf8");
  const result = await classifyCi({ step: flags.step, log, reruns: flags.reruns });
  if (!result.judged) {
    console.error("ci-triage: " + result.reason);
    process.exitCode = 1;
  } else {
    console.log(formatTriage(result));
    if (result.truncated) {
      console.log("(log cut to its last " + MAX_LOG_CHARS + " characters)");
    }
  }
}

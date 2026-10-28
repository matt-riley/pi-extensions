// timing.mjs — when to compact: measured boundary thresholds (precision over recall).
//
// safe-compact decides what survives compaction in plan.mjs; this module decides
// whether now is a safe task boundary. Only call it safe when confident — a
// deferred turn is cheap; compacting mid-task is not.

import { TUNED_MODEL } from "../../shared/jev-ledger.mjs";

/** Lines measured with replay-corpus / judge-thresholds on tunedModel. */
export const THRESHOLDS = Object.freeze({
  tunedModel: TUNED_MODEL,
  /** Subtask just finished. */
  completed: 0.55,
  /** Mid-change and debugging must sit below these to count as settled. */
  midFlightMax: 0.35,
  debuggingMax: 0.35,
  /** Task switch route. */
  switchedMin: 0.75,
  /** Score index: below 1 means the new task needs little of the old work. */
  needsHistoryMax: 1,
  midFlightSwitchMax: 0.55,
});

const envTruthy = (env, name) => {
  const value = typeof env?.[name] === "string" ? env[name].trim().toLowerCase() : "";
  return value === "1" || value === "true" || value === "yes" || value === "on";
};

/** Opt-in boundary timing: flag `--compact-boundary-timing` or PI_SAFE_COMPACT_BOUNDARY_TIMING. */
export function boundaryTimingEnabled(pi, env = process.env) {
  const flag = pi?.getFlag?.("compact-boundary-timing");
  if (flag === true || flag === "true") return true;
  if (flag === false || flag === "false") return false;
  return envTruthy(env, "PI_SAFE_COMPACT_BOUNDARY_TIMING");
}

/**
 * Is this moment safe to compact? Unknown scores count as not safe.
 * `moment` is the raw output of judgeMoment (without its legacy `clean` bit).
 */
export function isSafeBoundary(moment, thresholds = THRESHOLDS) {
  if (!moment || typeof moment !== "object") return false;
  const midFlight = moment.midFlight;
  const debugging = moment.debugging;
  if (
    midFlight === null ||
    midFlight === undefined ||
    debugging === null ||
    debugging === undefined
  ) {
    return false;
  }
  const completed = moment.completed ?? 0;
  const finished =
    completed >= thresholds.completed ||
    (midFlight <= thresholds.midFlightMax && debugging <= thresholds.debuggingMax);
  const switched = moment.switched;
  const needsHistory = moment.needsHistory;
  const switchedAway =
    moment.compared === true &&
    (switched ?? 0) >= thresholds.switchedMin &&
    needsHistory !== null &&
    needsHistory !== undefined &&
    needsHistory < thresholds.needsHistoryMax &&
    midFlight <= thresholds.midFlightSwitchMax &&
    debugging <= thresholds.debuggingMax;
  return finished || switchedAway;
}

/**
 * Whether to compact, wait, or do nothing at this context level.
 * `overflow` is true for pi overflow recovery — never defer past that ceiling.
 */
export function decideCompactionTiming({
  percent,
  soft,
  hard,
  timingEnabled = false,
  safe = false,
  judgeFailed = false,
  overflow = false,
}) {
  if (percent === null || percent === undefined || percent < soft) return "none";
  if (overflow || percent >= hard) return "compact";
  if (!timingEnabled) return "compact";
  if (judgeFailed) return "wait";
  if (safe) return "compact";
  return "wait";
}

import { DIFFICULTY_THRESHOLD, routeFromDifficulty } from "../packages/router/model-battery.mjs";

/**
 * Whether the router would leave the base at `threshold` for this rating.
 * Reuses routeFromDifficulty so the report cannot drift from production.
 */
export function routerWouldCatchTurn(difficulty, thresholds = {}) {
  if (!Number.isFinite(difficulty)) return false;
  const route = routeFromDifficulty(
    { difficulty: { type: "score", score: difficulty } },
    thresholds,
  );
  return route.escalate === true;
}

/** Label for an expensive-turn row in the report output. */
export function turnCatchLabel(row, thresholds = {}) {
  if (!Number.isFinite(row?.difficulty)) return null;
  return routerWouldCatchTurn(row.difficulty, thresholds) ? "caught" : "MISSED";
}

/**
 * Per-session escalation metrics using max difficulty and the router threshold.
 *
 * A session is predicted positive when any judged turn in it clears the threshold.
 */
export function sessionEscalationMetrics(rows, thresholds = {}) {
  const threshold = Number.isFinite(thresholds.threshold)
    ? thresholds.threshold
    : DIFFICULTY_THRESHOLD;
  const bySession = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row?.difficulty)) continue;
    const entry = bySession.get(row.file) ?? { frontier: false, maxDifficulty: -Infinity };
    entry.frontier ||= row.frontier === true;
    entry.maxDifficulty = Math.max(entry.maxDifficulty, row.difficulty);
    bySession.set(row.file, entry);
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const entry of bySession.values()) {
    const predicted = entry.maxDifficulty >= threshold;
    if (entry.frontier && predicted) tp++;
    else if (entry.frontier) fn++;
    else if (predicted) fp++;
  }
  return {
    sessions: bySession.size,
    tp,
    fp,
    fn,
    threshold,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
  };
}

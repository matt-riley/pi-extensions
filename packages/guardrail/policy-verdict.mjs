// policy-verdict.mjs — how two verdicts combine: the worst wins, so one bad segment
// condemns the whole command.

const VERDICT_RANK = { allow: 0, judge: 1, confirm: 2, block: 3 };

/** The more severe of two verdicts. */
export function worst(a, b) {
  return (VERDICT_RANK[b] ?? 0) > (VERDICT_RANK[a] ?? 0) ? b : a;
}

/** The most severe verdict in a list. */
export function worstOf(verdicts) {
  return verdicts.reduce((acc, v) => worst(acc, v), "allow");
}

// ---------------------------------------------------------------------------
// Path classification

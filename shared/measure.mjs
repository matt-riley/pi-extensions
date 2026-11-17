// measure.mjs — the measurement contract shared by done-gate's measure_command
// and until's /climb: a command prints one JSON line of counters, a sample counts
// only when it reports real, uncached work, and a comparison looks at spread, not
// one number.

/**
 * Parse one command's output as counters `{completed, cached, value?}`.
 * `expected` is the exact work count required; leave it undefined to accept any
 * positive count. Throws with the reason a sample does not count.
 */
export function parseCounters(output, expected) {
  let sample;
  try {
    sample = JSON.parse(String(output ?? "").trim());
  } catch {
    throw new Error("Measurement command must emit only JSON counters.");
  }
  if (
    !sample ||
    typeof sample !== "object" ||
    Array.isArray(sample) ||
    !Number.isSafeInteger(sample.completed) ||
    sample.completed <= 0 ||
    (expected !== undefined && sample.completed !== expected)
  )
    throw new Error("Expected completed work must be nonzero and exactly match expected_work.");
  if (sample.cached !== 0)
    throw new Error("Cached or unknown-cache work is not an executed sample.");
  return sample;
}

/** Count, mean, min, max and sample standard deviation of at least two values. */
export function summarize(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const stdev = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1),
  );
  const result = {
    count: values.length,
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    stdev,
  };
  if (!Object.values(result).every(Number.isFinite)) throw new Error("Non-finite summary.");
  return result;
}

/** Whether two `{min, max}` ranges share any value. */
export function rangesOverlap(a, b) {
  return b.min <= a.max && a.min <= b.max;
}

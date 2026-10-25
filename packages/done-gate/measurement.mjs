// Controlled local observations. No inference of causality or real-world task quality.
import { Type } from "typebox";
import { LOCAL_DESTRUCTIVE } from "../../shared/tool-annotations.mjs";
import { revisionSnapshot } from "../../shared/revision.mjs";

function summarize(samples) {
  const values = samples.map((sample) => sample.value);
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

function measurementOptions(params) {
  const {
    command,
    baseline_command: baseline,
    expected_work: expected,
    runs = 3,
    metric = "duration",
    unit,
    timeout = 30,
  } = params ?? {};
  const validCommand = (value) => typeof value === "string" && value.trim() && value.length <= 4000;
  if (
    !validCommand(command) ||
    (baseline !== undefined && !validCommand(baseline)) ||
    !Number.isSafeInteger(expected) ||
    expected <= 0 ||
    !Number.isInteger(runs) ||
    runs < 3 ||
    runs > 10 ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 60 ||
    !["duration", "value"].includes(metric) ||
    (metric === "value" && (typeof unit !== "string" || !unit.trim() || unit.length > 80))
  )
    throw new Error(
      "Supply commands, positive expected_work, 3–10 runs, and a unit for value metrics.",
    );
  return { command, baseline, expected, runs, metric, unit, timeout };
}

/**
 * The whole run must fit one deadline, and the schema allows 10 runs of two arms
 * at 60s each. Derive it from what was asked for instead of a fixed 120s, which
 * could not finish the defaults (3 runs x 2 arms x 30s) on a slow command.
 */
export function measurementDeadlineMs({ runs, timeout, baseline }) {
  const arms = baseline === undefined ? 1 : 2;
  return runs * arms * timeout * 1000 + 30_000;
}

const sampleSchema = Type.Object({
  value: Type.Number(),
  elapsed_ms: Type.Number(),
  completed: Type.Integer(),
  cached: Type.Literal(0),
});
const armSchema = Type.Object({
  command: Type.String(),
  samples: Type.Array(sampleSchema, { minItems: 3 }),
  summary: Type.Object({
    count: Type.Integer(),
    mean: Type.Number(),
    min: Type.Number(),
    max: Type.Number(),
    stdev: Type.Number(),
  }),
});
const reportSchema = Type.Object({
  revision: Type.Object({ head: Type.String(), fingerprint: Type.String() }),
  metric: Type.Union([Type.Literal("duration"), Type.Literal("value")]),
  unit: Type.String(),
  expected_work: Type.Integer(),
  scope: Type.String(),
  arms: Type.Object({ candidate: armSchema, baseline: Type.Optional(armSchema) }),
  comparison: Type.Optional(
    Type.Object({
      difference: Type.Number(),
      percent_change: Type.Union([Type.Number(), Type.Null()]),
      ranges_overlap: Type.Boolean(),
      interpretation: Type.String(),
    }),
  ),
});

export function installMeasurement(pi) {
  let measuring = false;
  pi.registerTool({
    name: "measure_command",
    label: "measure_command",
    exposure: "deferred",
    annotations: LOCAL_DESTRUCTIVE,
    outputSchema: reportSchema,
    reachesTools: () => ["bash"],
    description:
      "Execute 3–10 bounded trials through normal bash hooks on an unchanged Git revision. " +
      "Each command must print only JSON {completed: <expected_work>, cached: 0, value?: <finite number>}. " +
      "Report count, spread and raw samples; optionally compare interleaved baseline/candidate commands. " +
      "Counters are a command contract, not independently verified work. No claim of causal improvement.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 4000 }),
      baseline_command: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      expected_work: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      runs: Type.Optional(Type.Integer({ minimum: 3, maximum: 10, default: 3 })),
      metric: Type.Optional(Type.Union([Type.Literal("duration"), Type.Literal("value")])),
      unit: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, default: 30 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (measuring) throw new Error("A measurement is already running.");
      const { command, baseline, expected, runs, metric, unit, timeout } =
        measurementOptions(params);
      measuring = true;
      const boundedSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(measurementDeadlineMs({ runs, timeout, baseline })),
      ]);
      try {
        boundedSignal.throwIfAborted();
        const cwd = ctx.cwd ?? process.cwd();
        const revision = await revisionSnapshot(cwd);
        if (!revision) throw new Error("Known Git revision required for measurement.");
        const arms = {
          candidate: { command, samples: [] },
          ...(baseline === undefined ? {} : { baseline: { command: baseline, samples: [] } }),
        };
        for (let i = 0; i < runs; i++) {
          const order =
            baseline === undefined
              ? ["candidate"]
              : i % 2 === 0
                ? ["baseline", "candidate"]
                : ["candidate", "baseline"];
          for (const name of order) {
            boundedSignal.throwIfAborted();
            const before = await revisionSnapshot(cwd);
            if (before?.fingerprint !== revision.fingerprint)
              throw new Error("Revision changed during measurement.");
            const started = performance.now();
            const execution = await ctx.executeTool(
              "bash",
              { command: arms[name].command, timeout },
              { signal: boundedSignal },
            );
            const elapsed_ms = performance.now() - started;
            const result = execution.result?.structuredContent;
            boundedSignal.throwIfAborted();
            if (
              execution.isError !== false ||
              result?.exit_code !== 0 ||
              result.truncated !== false ||
              typeof result.output !== "string"
            )
              throw new Error("Measurement command failed or was blocked, truncated, or unknown.");
            const after = await revisionSnapshot(cwd);
            boundedSignal.throwIfAborted();
            if (after?.fingerprint !== revision.fingerprint)
              throw new Error("Revision changed during measurement.");
            let sample;
            try {
              sample = JSON.parse(result.output);
            } catch {
              throw new Error("Measurement command must emit only JSON counters.");
            }
            if (
              !sample ||
              typeof sample !== "object" ||
              Array.isArray(sample) ||
              !Number.isSafeInteger(sample.completed) ||
              sample.completed !== expected
            )
              throw new Error(
                "Expected completed work must be nonzero and exactly match expected_work.",
              );
            if (sample.cached !== 0)
              throw new Error("Cached or unknown-cache work is not an executed sample.");
            const value = metric === "duration" ? elapsed_ms : sample.value;
            if (!Number.isFinite(value))
              throw new Error("Measurement value must be a finite number.");
            arms[name].samples.push({ value, elapsed_ms, completed: sample.completed, cached: 0 });
          }
        }
        const report = {
          revision,
          metric,
          unit: metric === "duration" ? "ms" : unit,
          expected_work: expected,
          arms: Object.fromEntries(
            Object.entries(arms).map(([name, arm]) => [
              name,
              { ...arm, summary: summarize(arm.samples) },
            ]),
          ),
          scope:
            "Local command-contract observations, including process/tool overhead for duration. " +
            "Counters are self-reported; no verified bottleneck, task quality or causal improvement.",
        };
        if (baseline !== undefined) {
          const a = report.arms.baseline.summary;
          const b = report.arms.candidate.summary;
          report.comparison = {
            difference: b.mean - a.mean,
            percent_change: a.mean === 0 ? null : ((b.mean - a.mean) / Math.abs(a.mean)) * 100,
            ranges_overlap: b.min <= a.max && a.min <= b.max,
            interpretation:
              "Observed difference only; not a statistical or causal improvement claim.",
          };
          if (
            ![report.comparison.difference, report.comparison.percent_change ?? 0].every(
              Number.isFinite,
            )
          )
            throw new Error("Non-finite comparison.");
        }
        return {
          content: [{ type: "text", text: JSON.stringify(report) }],
          structuredContent: report,
          details: report,
        };
      } finally {
        measuring = false;
      }
    },
  });
}

const SOURCE = /\.(?:[cm]?[jt]sx?|go|rs|lua)$/i;
const CHECKS = [
  { tool: "crap", args: [".", "--format", "json", "--fail-above"] },
  { tool: "deadwood", args: [".", "--format", "json", "--fail-on", "high"] },
];

/** Each check reports passed, findings, or error; skipped discovery is never a pass. */
export async function runQuality({ cwd, exec, signal }) {
  let root;
  try {
    const repo = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: 5000,
      signal,
    });
    root = String(repo.stdout ?? "").trim();
    if (repo.code !== 0 || !root || /[\r\n]/.test(root) || repo.killed || repo.truncated)
      return { ok: false, checks: [], note: "Skipped: no readable Git repository root." };
    const inventory = await exec(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        signal,
      },
    );
    if (inventory.code !== 0 || inventory.killed || inventory.truncated)
      return { ok: false, checks: [], note: "Error: Git source inventory is incomplete." };
    const files = String(inventory.stdout ?? "").split("\0");
    if (
      !files.some(
        (file) =>
          SOURCE.test(file) &&
          !/\.d\.[cm]?ts$/i.test(file) &&
          !/(?:^|\/)(?:node_modules|vendor|target|dist|build)\//.test(file),
      )
    )
      return {
        root,
        ok: false,
        checks: [],
        note: "Skipped: no supported JS/TS, Go, Rust or Lua source files.",
      };
  } catch (error) {
    return { ok: false, checks: [], note: `Error: repository discovery failed: ${String(error)}` };
  }
  const outcomes = await Promise.allSettled(
    CHECKS.map(async ({ tool, args }) => {
      const result = await exec(tool, args, {
        cwd: root,
        timeout: 120000,
        maxBuffer: 128 * 1024,
        signal,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      let status = "error";
      if (!result.killed && !result.truncated && (result.code === 0 || result.code === 1)) {
        try {
          const data = JSON.parse(result.stdout);
          if (
            data?.v === 1 &&
            typeof data.ok === "boolean" &&
            Number.isInteger(data.summary?.files) &&
            data.summary.files > 0 &&
            (tool !== "deadwood" || data.complete === true) &&
            (tool !== "crap" || Number.isInteger(data.summary?.functions))
          )
            status = result.code === 0 && data.ok ? "passed" : "findings";
        } catch {
          // Invalid CLI output is an error, even with exit 0.
        }
      }
      return {
        tool,
        status,
        code: result.code,
        output: output.slice(0, 16000),
        truncated: Boolean(result.truncated || output.length > 16000),
        killed: Boolean(result.killed),
      };
    }),
  );
  const checks = outcomes.map((outcome, index) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { tool: CHECKS[index].tool, status: "error", output: String(outcome.reason) },
  );
  return { root, checks, ok: checks.every((check) => check.status === "passed") };
}

export function formatQuality(report) {
  if (report.note) return `Quality: ${report.note}`;
  return [
    `Quality: ${report.root}`,
    ...report.checks.map(
      (check) =>
        `${check.tool}: ${check.status}${check.code === undefined ? "" : ` (exit ${check.code})`}` +
        `${check.killed ? " [terminated]" : ""}${check.truncated ? " [output truncated]" : ""}\n${check.output}`,
    ),
    "CRAP without matched coverage is an unmeasured upper bound; a pass is not proof of full analysis coverage.",
  ].join("\n");
}

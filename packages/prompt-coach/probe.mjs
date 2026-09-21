// probe.mjs — the light repository probe.
//
// The cheapest rewrite value is naming what a referent actually is: which
// branch, which changed files, which commit, which CI run. Facts only — names,
// never file contents or diff bodies — and every command fails silently into
// absence, because a probe that breaks a turn costs more than it adds.

/** A prompt that mentions these gets one `gh run list` call; nothing else does. */
const CI_PATTERN = /\b(ci|workflows?|github actions?|checks?|failing|build|tests?)\b/i;

const DEFAULT_TIMEOUT_MS = 800;
const MAX_FILES = 20;
const MAX_COMMIT = 80;

async function run(exec, cmd, args, timeout) {
  try {
    const result = await exec(cmd, args, { timeout });
    if (!result || Number(result.code) !== 0) return null;
    const stdout = String(result.stdout ?? "").trim();
    return stdout || null;
  } catch {
    return null;
  }
}

/**
 * Collect bounded facts about the working tree. `exec` matches pi.exec:
 * (cmd, args, { timeout }) => { code, stdout, stderr }. Never throws.
 */
export async function collectProbe(exec, text, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const [branch, status, commit] = await Promise.all([
    run(exec, "git", ["rev-parse", "--abbrev-ref", "HEAD"], timeout),
    run(exec, "git", ["status", "--porcelain", "--untracked-files=no"], timeout),
    run(exec, "git", ["log", "-1", "--format=%h %s"], timeout),
  ]);

  const files = status
    ? status
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
    : [];
  const probe = {
    branch: branch || null,
    dirty: files.length ? { count: files.length, files: files.slice(0, MAX_FILES) } : null,
    commit: commit ? commit.slice(0, MAX_COMMIT) : null,
    ci: null,
  };

  if (CI_PATTERN.test(String(text ?? ""))) {
    const raw = await run(
      exec,
      "gh",
      ["run", "list", "-L", "1", "--json", "workflowName,status,conclusion"],
      timeout,
    );
    if (raw) {
      try {
        const [latest] = JSON.parse(raw);
        if (latest) {
          probe.ci = {
            workflowName: latest.workflowName ?? null,
            status: latest.status ?? null,
            conclusion: latest.conclusion ?? null,
          };
        }
      } catch {
        // A malformed gh payload is simply no CI fact.
      }
    }
  }

  return probe;
}

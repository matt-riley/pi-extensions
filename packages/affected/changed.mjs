// changed.mjs — the files a change touches, from git, read-only.
//
// Working-tree edits (tracked changes against HEAD plus untracked files) and, when
// a base ref is given, everything the branch changed since it forked from it. Each
// git command runs as an argument vector through the injected `exec`, never a shell,
// and the base ref is checked first so it can be neither an option nor a shell word.

const REF = /^[A-Za-z0-9_][A-Za-z0-9_./@^~-]*$/;
const TIMEOUT_MS = 15_000;

const split = (stdout) =>
  String(stdout ?? "")
    .split("\0")
    .filter(Boolean);

/**
 * @param {{
 *   exec: (cmd: string, args: string[], opts?: { timeout?: number }) =>
 *     Promise<{ code: number, stdout: string, stderr: string }>,
 *   root: string,
 *   base?: string,
 * }} input
 * @returns {Promise<{ files: string[], error: string | null }>}
 */
export async function changedFiles({ exec, root, base }) {
  if (base !== undefined && !REF.test(base)) {
    return { files: [], error: `"${base}" is not a usable ref` };
  }
  const commands = [
    ["diff", "--name-only", "-z", "HEAD"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ...(base === undefined ? [] : [["diff", "--name-only", "-z", `${base}...HEAD`]]),
  ];
  const files = new Set();
  for (const args of commands) {
    let result;
    try {
      result = await exec("git", ["-C", root, ...args], { timeout: TIMEOUT_MS });
    } catch (error) {
      return { files: [], error: `git ${args[0]} failed: ${error.message}` };
    }
    if (result?.code !== 0) {
      return {
        files: [],
        error: `git ${args.join(" ")} failed: ${String(result?.stderr ?? "").trim()}`,
      };
    }
    for (const file of split(result.stdout)) files.add(file);
  }
  return { files: [...files].sort(), error: null };
}

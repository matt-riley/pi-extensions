import path from "node:path";
import { findRepoRoot, listRepoFiles } from "../code-search/inventory.mjs";

export async function projectFiles(cwd, exec) {
  const { root } = await findRepoRoot(cwd, exec);
  return { root, ...(await listRepoFiles({ root, exec })) };
}

async function git(root, args, exec, diff = false) {
  const result = await exec(
    "git",
    ["--no-optional-locks", "--literal-pathspecs", "-C", root, ...args],
    { timeout: 10000 },
  );
  if (result.code !== 0 && !(diff && result.code === 1)) {
    throw new Error(result.stderr?.trim() || "Git could not read this repository.");
  }
  return result.stdout;
}

/** Porcelain -z preserves arbitrary filenames; rename source follows destination. */
export async function changedFiles(root, exec) {
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], exec);
  const records = status.split("\0");
  const changes = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const xy = record.slice(0, 2);
    const file = record.slice(3);
    const original = /[RC]/.test(xy) ? records[++i] : undefined;
    if (xy === "??") {
      changes.push({ scope: "untracked", file });
    } else {
      if (xy[0] !== " ") changes.push({ scope: "staged", file, original });
      if (xy[1] !== " ") changes.push({ scope: "unstaged", file, original });
    }
  }
  return changes;
}

export async function previewChange(root, change, exec) {
  const options = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
  const args =
    change.scope === "untracked"
      ? ["diff", "--no-index", ...options, "--", "/dev/null", path.resolve(root, change.file)]
      : [
          "diff",
          ...options,
          ...(change.scope === "staged" ? ["--cached"] : []),
          "--",
          change.file,
          ...(change.original ? [change.original] : []),
        ];
  const text = await git(root, args, exec, change.scope === "untracked");
  return text.length > 20000
    ? text.slice(0, 20000) + "\n[preview truncated at 20,000 characters]"
    : text || "(No textual diff; the file may have changed since the list opened.)";
}

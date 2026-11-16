import { isAbsolute, relative, resolve, sep } from "node:path";

/** `path` relative to `cwd`, or null when it resolves outside it. Without a cwd, `path` unchanged. */
export function repoRelativePath(cwd, path) {
  if (typeof cwd !== "string" || !cwd) return path;
  const rel = relative(resolve(cwd), resolve(cwd, path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

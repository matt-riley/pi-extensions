// readtools.mjs — the only tools the rewrite model can call.
//
// Three read-only tools, implemented with node:fs and no child process, so the
// model cannot run a command or change a file whatever it asks for. Anything
// else it calls is refused. Paths are confined to the working directory, and
// files that look like secrets are never opened: their contents would leave
// the machine for the model provider.

import fs from "node:fs/promises";
import path from "node:path";

const MAX_READ_CHARS = 20_000;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_FILES = 400;
const MAX_SEARCH_MATCHES = 40;
const MAX_LINE_CHARS = 200;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "target"]);
const SECRET_NAME =
  /^(\.env.*|\.npmrc|\.netrc|auth\.json|credentials.*|secrets?(\..*)?|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|p12|pfx))$/i;

const tool = (name, description, properties, required) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const READ_TOOLS = [
  tool(
    "read_file",
    "Read one text file in the repository. Paths are relative to the working directory.",
    { path: { type: "string", description: "Relative path of the file." } },
    ["path"],
  ),
  tool(
    "list_dir",
    "List the entries of one directory (directories end in /).",
    { path: { type: "string", description: "Relative directory; use . for the root." } },
    ["path"],
  ),
  tool(
    "search_text",
    "Case-insensitive literal text search across the repository. Returns file:line: text.",
    { query: { type: "string", description: "Text to find (not a regular expression)." } },
    ["query"],
  ),
];

const ok = (text, extra = {}) => ({ ok: true, text, ...extra });
const fail = (text) => ({ ok: false, text });
const isSecret = (name) => SECRET_NAME.test(name);

/** Resolve inside root, following symlinks, or return null when it escapes. */
async function confine(root, relative) {
  const base = await fs.realpath(root);
  const target = path.resolve(base, String(relative ?? "."));
  const within = (candidate) => candidate === base || candidate.startsWith(base + path.sep);
  let real;
  try {
    real = await fs.realpath(target);
  } catch {
    return within(target) ? { base, missing: true } : null;
  }
  return within(real) ? { base, real } : null;
}

async function readFile(args, root) {
  const spot = await confine(root, args.path);
  if (!spot) return fail("refused: that path is outside the repository");
  if (spot.missing) return fail("not found");
  if (isSecret(path.basename(spot.real))) return fail("refused: that looks like a secret file");
  let text;
  try {
    text = await fs.readFile(spot.real, "utf8");
  } catch {
    return fail("could not read that path as a file");
  }
  if (text.includes("\u0000")) return fail("binary file");
  const shown =
    text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n[truncated]` : text;
  return ok(shown, { file: path.relative(spot.base, spot.real) });
}

async function listDir(args, root) {
  const spot = await confine(root, args.path);
  if (!spot) return fail("refused: that path is outside the repository");
  if (spot.missing) return fail("not found");
  let entries;
  try {
    entries = await fs.readdir(spot.real, { withFileTypes: true });
  } catch {
    return fail("not a directory");
  }
  const lines = entries
    .filter((entry) => !SKIP_DIRS.has(entry.name) && !isSecret(entry.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()
    .slice(0, MAX_LIST_ENTRIES);
  return ok(lines.join("\n") || "(empty)");
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRS.has(entry.name) || isSecret(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function searchText(args, root) {
  const query = String(args.query ?? "").toLowerCase();
  if (!query) return fail("empty query");
  const base = await fs.realpath(root);
  const matches = [];
  let files = 0;
  for await (const file of walk(base)) {
    if (++files > MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES) break;
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (text.includes("\u0000")) continue;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(query)) continue;
      const line = lines[index].trim().slice(0, MAX_LINE_CHARS);
      matches.push(`${path.relative(base, file)}:${index + 1}: ${line}`);
      if (matches.length >= MAX_SEARCH_MATCHES) break;
    }
  }
  return ok(matches.join("\n") || "no matches");
}

const HANDLERS = { read_file: readFile, list_dir: listDir, search_text: searchText };

/** Run one tool call. Never throws; an unknown tool is refused, not run. */
export async function runReadTool(name, args, root) {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  if (!handler) return fail(`tool "${name}" is not available; only read-only tools are`);
  try {
    return await handler(args && typeof args === "object" ? args : {}, root);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

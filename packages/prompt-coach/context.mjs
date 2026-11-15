// context.mjs — the key files read for a probe that only names the repository.
//
// A probe with no changed files and no CI run says which repo it is and
// nothing about what is in it, and the rewrite model has been seen refusing
// on that. So before the model call we read a small fixed set of files through
// the same read-only tools the model gets: the README, the package scripts,
// an entry file or two, and a test or two. It is a bounded local read: no
// network, no new model call, no write, and secret-looking files stay closed.

import { runReadTool } from "./readtools.mjs";

const MAX_FILES = 6;
const MAX_ENTRY_FILES = 2;
const MAX_TEST_FILES = 2;
const MAX_FILE_CHARS = 3_000;
const MAX_TOTAL_CHARS = 12_000;

const TRUNCATED = "\n[truncated]";
const README = /^readme(\.(md|markdown|txt))?$/i;
const TEST_DIRS = ["test", "tests", "__tests__", "spec"];
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^test_.*\.py$)|(_test\.(go|py)$)/;
const ENTRY_FILES = [
  "index.ts",
  "index.js",
  "index.mjs",
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/main.ts",
  "src/main.tsx",
  "src/main.js",
  "src/App.tsx",
  "src/app/page.tsx",
  "app/page.tsx",
  "pages/index.tsx",
  "pages/index.js",
  "index.html",
  "public/index.html",
  "main.py",
  "app.py",
  "main.go",
  "src/main.rs",
  "src/lib.rs",
];

const names = (listing) => (listing.ok ? listing.text.split("\n").filter(Boolean) : []);

/** Scripts and the declared entry points are enough of package.json; dependency lists are not. */
function packageSummary(text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return { text: null, entries: [] };
  }
  const bin = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
  const entries = [pkg.main, pkg.module, ...bin].filter((entry) => typeof entry === "string");
  const summary = JSON.stringify(
    { name: pkg.name, main: pkg.main, module: pkg.module, bin: pkg.bin, scripts: pkg.scripts },
    null,
    2,
  );
  return { text: summary, entries: entries.map((entry) => entry.replace(/^\.\//, "")) };
}

/**
 * Read the key files of the project at `cwd`. Returns [{ file, text }] in a
 * fixed order, or [] when nothing was readable. Never throws.
 */
export async function gatherProjectContext(cwd) {
  if (!cwd) return [];
  const context = [];
  let used = 0;

  const add = (file, text) => {
    const room = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - used);
    if (context.length >= MAX_FILES || room <= 0 || !text.trim()) return false;
    const shown =
      text.length > room ? `${text.slice(0, room - TRUNCATED.length)}${TRUNCATED}` : text;
    context.push({ file, text: shown });
    used += shown.length;
    return true;
  };

  const read = async (file) => {
    const result = await runReadTool("read_file", { path: file }, cwd);
    return result.ok ? result.text : null;
  };

  const root = names(await runReadTool("list_dir", { path: "." }, cwd));

  const readme = root.find((entry) => README.test(entry));
  if (readme) {
    const text = await read(readme);
    if (text) add(readme, text);
  }

  let declared = [];
  if (root.includes("package.json")) {
    const raw = await read("package.json");
    const summary = raw ? packageSummary(raw) : { text: null, entries: [] };
    if (summary.text) add("package.json", summary.text);
    declared = summary.entries;
  }

  let entries = 0;
  for (const file of new Set([...declared, ...ENTRY_FILES])) {
    if (entries >= MAX_ENTRY_FILES) break;
    const text = await read(file);
    if (text && add(file, text)) entries += 1;
  }

  let tests = [];
  for (const dir of TEST_DIRS) {
    if (!root.includes(`${dir}/`)) continue;
    tests = names(await runReadTool("list_dir", { path: dir }, cwd))
      .filter((entry) => TEST_FILE.test(entry))
      .map((entry) => `${dir}/${entry}`);
    if (tests.length) break;
  }
  if (!tests.length) tests = root.filter((entry) => TEST_FILE.test(entry));
  for (const file of tests.slice(0, MAX_TEST_FILES)) {
    const text = await read(file);
    if (text) add(file, text);
  }

  return context;
}

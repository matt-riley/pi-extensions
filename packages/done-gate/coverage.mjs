// coverage.mjs — did a passing unit-test run reach the code that changed?
//
// A green test run says nothing about a file no test touches. This reads the
// test files the run covered and looks, as plain text, for an import, require
// or mention of a changed file. It walks no dependency graph: a test that
// reaches the change only through another module does not count. When the run's
// test files cannot be worked out the answer is "unknown", never a guess.

import { dirname, posix } from "node:path";
import { isVerifyCommand } from "./gate.mjs";

const PREFIX = String.raw`^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:rtk\s+)?(?:(?:npx|bunx|pnpm\s+exec|uv\s+run|python3?\s+-m)\s+)?`;
const TEST_COMMANDS = [
  String.raw`node\s+--test\b`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b`,
  String.raw`go\s+test\b`,
  String.raw`cargo\s+test\b`,
  String.raw`make\s+test\b`,
  String.raw`deno\s+test\b`,
  String.raw`dotnet\s+test\b`,
  String.raw`mvn\s+test\b`,
  String.raw`(?:\.\/)?gradlew?\s+test\b`,
  String.raw`(?:bundle\s+exec\s+)?rspec\b`,
  String.raw`playwright\s+test\b`,
  String.raw`(?:pytest|py\.test|vitest|jest|mocha|phpunit|busted)\b`,
].map((body) => new RegExp(PREFIX + body));

/** True when a command runs unit tests, as opposed to a build, lint or whole-repo gate. */
export function isTestCommand(command) {
  return isVerifyCommand(command) && TEST_COMMANDS.some((pattern) => pattern.test(command.trim()));
}

// Runners that find the tests themselves when given no path.
const DISCOVERS = new RegExp(
  PREFIX + String.raw`(?:node\s+--test|deno\s+test|pytest|py\.test|vitest|jest|mocha)\b`,
);
const PACKAGE_TEST = /^(?:rtk\s+)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(test(?::[\w-]+)?)(?![\w:-])/;

const TEST_FILE =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go|lua)$|_spec\.lua$|(?:^|\/)(?:tests?|__tests__)\/[^/]+\.(?:[cm]?[jt]sx?|py)$/;

// Files a test can import or name. Prose and config are not judged: no test imports them.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|lua|rb|java|kt|swift|php|cs|cc?|cpp|hpp?|sh)$/;

const MODULE_EXT = /\.(?:[cm]?[jt]sx?|py|lua|go|rs)$/;

const clean = (path) => String(path).replace(/^\.\//, "").replace(/\/+$/, "");

/** A file path without its extension and without a trailing index-style module name. */
const stem = (path) =>
  clean(path)
    .replace(MODULE_EXT, "")
    .replace(/\/(?:index|__init__|init)$/, "");

/** Every module specifier in a source file: JS and TS import forms, require, Python and Lua. */
export function scanSpecifiers(source) {
  const text = String(source ?? "");
  const found = new Set();
  const take = (pattern, group = 1) => {
    for (const match of text.matchAll(pattern)) found.add(match[group]);
  };
  take(/\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g);
  take(/\bimport\s*['"]([^'"]+)['"]/g);
  take(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  take(/^[ \t]*from\s+(\.*[\w.]*)\s+import\b/gm);
  for (const match of text.matchAll(/^[ \t]*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm))
    for (const name of match[1].split(",")) found.add(name.trim());
  return [...found];
}

const isRelativeJs = (spec) => spec === "." || spec === ".." || /^\.\.?\//.test(spec);

// The stem a specifier points at: exact for a relative one, a trailing path for a module name.
function resolveSpec(spec, testPath) {
  if (isRelativeJs(spec)) return { exact: stem(posix.join(dirname(testPath), spec)) };
  const dots = /^(\.+)(\w[\w.]*)$/.exec(spec);
  if (dots) {
    const up = "../".repeat(dots[1].length - 1);
    return { exact: stem(posix.join(dirname(testPath), up, dots[2].replaceAll(".", "/"))) };
  }
  let name = spec.replace(/^[@~]\//, "");
  if (!name.includes("/") && name.includes(".") && !MODULE_EXT.test(name))
    name = name.replaceAll(".", "/");
  return name.includes("/") && !name.startsWith(".") ? { tail: stem(name) } : null;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function named(source, path) {
  if (source.includes(path)) return true;
  const parts = clean(path).split("/");
  const needle = /^(?:index|__init__|init)\./.test(parts.at(-1))
    ? parts.slice(-2).join("/")
    : parts.at(-1);
  return new RegExp("(?<=[/'\"`\\s])" + escape(needle) + "(?!\\w)").test(source);
}

/**
 * How a test file reaches a changed file: "imports" when one of its import or
 * require specifiers points at it, "names" when its text mentions the path or
 * file name, or null.
 */
export function testReach({ testPath, source, changed }) {
  const targets = changed.map(stem);
  const specs = scanSpecifiers(source).map((spec) => resolveSpec(spec, testPath));
  const imports = specs.some(
    (spec) =>
      spec &&
      targets.some((target) =>
        spec.exact !== undefined
          ? target === spec.exact
          : target === spec.tail || target.endsWith(`/${spec.tail}`),
      ),
  );
  if (imports) return "imports";
  return changed.some((path) => named(String(source ?? ""), clean(path))) ? "names" : null;
}

const globToRegex = (glob) =>
  new RegExp(
    "^" +
      escape(glob)
        .replaceAll("\\*\\*/", "(?:.*/)?")
        .replaceAll("\\*\\*", ".*")
        .replaceAll("\\*", "[^/]*") +
      "$",
  );

function matchTests(token, all) {
  const path = clean(token.replace(/^['"]|['"]$/g, ""));
  if (!path || path.startsWith("-")) return [];
  if (path.includes("*")) return all.filter((file) => globToRegex(path).test(file));
  if (all.includes(path)) return [path];
  const under = all.filter((file) => file.startsWith(`${path}/`));
  if (under.length > 0) return under;
  return TEST_FILE.test(path) ? [path] : [];
}

function fromLog(log, cwd) {
  const files = new Set();
  const prefix = `${String(cwd).replace(/\/+$/, "")}/`;
  for (const raw of String(log ?? "").split(/[\s()'"]+/)) {
    const path = raw
      .replace(/^file:\/\//, "")
      .replace(/:\d+(?::\d+)?$/, "")
      .replace(prefix, "");
    if (TEST_FILE.test(path) && !path.startsWith("/")) files.add(clean(path));
  }
  return [...files];
}

// The command, or for `npm test` the script behind it. null when there is nothing to read.
async function commandText(command, read) {
  const text = command.trim();
  const name = PACKAGE_TEST.exec(text)?.[1];
  if (!name) return text;
  try {
    const script = JSON.parse((await read("package.json")) ?? "null")?.scripts?.[name];
    return typeof script === "string" ? script : "";
  } catch {
    return "";
  }
}

const GO_TEST = new RegExp(PREFIX + String.raw`go\s+test\b`);

// `go test` takes packages, and a package's tests are the _test.go files in its directory.
function goPackageTests(text, all) {
  const args = text.replace(/^.*?\bgo\s+test\b/, "").split(/\s+/);
  const packages = args.filter((arg) => arg && !arg.startsWith("-")).map(clean);
  const files = new Set();
  for (const pkg of packages.length > 0 ? packages : ["."]) {
    const recursive = /(?:^|\/)\.\.\.$/.test(pkg);
    const dir = pkg.replace(/\/?\.\.\.$/, "");
    for (const file of all.filter((name) => name.endsWith("_test.go"))) {
      const at = dirname(file) === "." ? "" : dirname(file);
      const base = dir === "." ? "" : dir;
      if (recursive ? base === "" || at === base || at.startsWith(`${base}/`) : at === base)
        files.add(file);
    }
  }
  return [...files];
}

async function testFilesRun({ command, log, cwd, all, read }) {
  const text = await commandText(command, read);
  if (GO_TEST.test(text)) return { files: goPackageTests(text, all), exact: true };
  const files = new Set(fromLog(log, cwd));
  if (DISCOVERS.test(text)) {
    for (const token of text.split(/\s+/))
      for (const file of matchTests(token, all)) files.add(file);
    if (files.size === 0) for (const file of all) files.add(file);
  }
  return { files: [...files], exact: false };
}

/**
 * Whether a passing check reached the code that changed: "yes", "no" (the test
 * files it ran neither import nor name any changed file), or "unknown" (which
 * test files it ran, or what is in them, cannot be told). A check that is not a
 * unit-test run, and a change tests cannot import, are "yes".
 *
 * `read(path)` gives a file's text or null; `listTests()` the repo's test files.
 */
export async function coverageForRun({ command, log, edited, cwd, read, listTests }) {
  if (!isTestCommand(command)) return "yes";
  const changed = [...edited].map(clean).filter((path) => CODE_FILE.test(path));
  if (changed.length === 0) return "yes";
  const all = ((await listTests()) ?? []).map(clean).filter((file) => TEST_FILE.test(file));
  const { files, exact } = await testFilesRun({ command, log, cwd, all, read });
  if (files.length === 0) return exact ? "no" : "unknown";
  if (files.some((file) => changed.includes(file))) return "yes";
  let unreadable = false;
  for (const file of files) {
    if (exact) {
      // A Go package is judged by directory alone: its tests are not read.
      if (changed.some((path) => dirname(path) === dirname(file))) return "yes";
      continue;
    }
    const source = await read(file);
    if (source === null || source === undefined) unreadable = true;
    else if (testReach({ testPath: file, source, changed })) return "yes";
  }
  return unreadable ? "unknown" : "no";
}

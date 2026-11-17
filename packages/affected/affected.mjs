// affected.mjs — which test files can reach a change.
//
// Pure over { files, readFile, changed }. It reads the repository's import graph
// (shared/import-graph.mjs, TypeScript and JavaScript only), walks it backwards
// from each changed file, and names the test files it reaches. It runs nothing.
//
// A selection is only as good as the graph, so the result says where the graph
// is thin. Changed files no test reaches, non-JS files and deleted files are
// listed as gaps. A computed import(), an import that names no file, or a file cap
// somewhere a test can reach means any test might reach any change, so the answer
// is "fallback": run the package-level test command instead. Whatever was found
// is still reported, as a floor.

import { collectEdges, loadImportGraph } from "../../shared/import-graph.mjs";
import { isTsFile, parseTsSource } from "../code-search/ts-parser.mjs";

const MAX_CHANGED = 500;
const LIST_LIMIT = 25;
const HINT_LIMIT = 50;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/.*\.[cm]?[jt]sx?$/;

/** A test file by name (`*.test.*`, `*.spec.*`) or by living in `__tests__/`. */
export function isTestFile(rel) {
  return TEST_FILE.test(rel);
}

function walk(start, next) {
  const seen = new Set(start);
  const queue = [...start];
  for (let at = 0; at < queue.length; at += 1) {
    for (const target of next.get(queue[at]) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

/** The package-level test command for each package that holds a changed file. */
async function packageCommands(changed, fileSet, readFile) {
  const scripts = new Map();
  const testScript = async (dir) => {
    if (scripts.has(dir)) return scripts.get(dir);
    const rel = dir ? `${dir}/package.json` : "package.json";
    let value = null;
    if (fileSet.has(rel)) {
      try {
        const test = JSON.parse(await readFile(rel))?.scripts?.test;
        value = typeof test === "string" ? test : null;
      } catch {
        value = null;
      }
    }
    scripts.set(dir, value);
    return value;
  };
  const found = new Map();
  for (const file of changed) {
    let nearest = null;
    let chosen = null;
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
      if (nearest === null && fileSet.has(dir ? `${dir}/package.json` : "package.json")) {
        nearest = dir;
      }
      if (await testScript(dir)) {
        chosen = dir;
        break;
      }
      if (dir === "") break;
    }
    const dir = chosen ?? nearest ?? "";
    let command;
    if (chosen === null) command = null;
    else if (chosen === "") command = "npm test";
    else command = `npm test --workspace ${chosen}`;
    found.set(dir, command);
  }
  return [...found]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([dir, command]) => ({ dir, command }));
}

const quote = (file) => (/^[\w./@+-]+$/.test(file) ? file : `'${file.replaceAll("'", "'\\''")}'`);

async function runHint(tests, fileSet, readFile) {
  if (tests.length === 0 || tests.length > HINT_LIMIT || !fileSet.has("package.json")) return null;
  let script = "";
  try {
    script = String(JSON.parse(await readFile("package.json"))?.scripts?.test ?? "");
  } catch {
    return null;
  }
  const list = tests.map(quote).join(" ");
  if (/\bnode\s+(--\S+\s+)*--test\b/.test(script)) return `node --test ${list}`;
  if (/\bvitest\b/.test(script)) return `npx vitest run ${list}`;
  if (/\bjest\b/.test(script)) return `npx jest ${list}`;
  return null;
}

/**
 * @param {{
 *   files: string[],
 *   readFile: (rel: string) => Promise<string | null>,
 *   changed: string[],
 *   inventoryCapped?: boolean,
 *   limits?: { maxFiles?: number, maxBytes?: number },
 * }} input
 */
export async function selectAffected({
  files,
  readFile,
  changed,
  inventoryCapped = false,
  limits = {},
}) {
  const all = [...new Set(files)].sort();
  const fileSet = new Set(all);
  const wanted = [...new Set(changed)].sort();
  const source = all.filter((file) => isTsFile(file));
  const tests = source.filter((file) => isTestFile(file));

  const graph = await loadImportGraph({ files: all, readFile });
  const { edges, incomplete } = await collectEdges({
    graph,
    files: source,
    readFile,
    parse: parseTsSource,
    ...limits,
  });
  const forward = new Map();
  const backward = new Map();
  for (const { from, to } of edges) {
    if (!forward.has(from)) forward.set(from, new Set());
    forward.get(from).add(to);
    if (!backward.has(to)) backward.set(to, new Set());
    backward.get(to).add(from);
  }

  // A gap matters only where a test can get to it: code no test reaches cannot
  // change which tests reach a change.
  const testReach = walk(tests, forward);
  const open = (entry) => entry.kind !== "dynamic-import" || !entry.literal || !entry.resolved;
  const candidates = incomplete.filter(open);
  const graphGaps = candidates.filter((entry) => entry.file === null || testReach.has(entry.file));
  if (inventoryCapped) {
    graphGaps.push({
      kind: "inventory-cap",
      file: null,
      line: null,
      detail: "the repository has more files than the inventory limit",
    });
  }

  const gaps = { unreached: [], nonJs: [], deleted: [], graph: graphGaps };
  const selected = new Set();
  const testSet = new Set(tests);
  const present = wanted.filter((file) => fileSet.has(file));
  for (const file of wanted) if (!fileSet.has(file)) gaps.deleted.push(file);
  const walkable = present.length <= MAX_CHANGED ? present : [];
  for (const file of walkable) {
    const reaching = [...walk([file], backward)].filter((reached) => testSet.has(reached));
    for (const test of reaching) selected.add(test);
    if (reaching.length > 0) continue;
    if (isTsFile(file)) gaps.unreached.push(file);
    else gaps.nonJs.push(file);
  }

  const reasons = [];
  if (wanted.length > MAX_CHANGED) {
    reasons.push(`${wanted.length} changed files is more than the ${MAX_CHANGED} it will walk`);
  }
  for (const entry of graphGaps) {
    const where = entry.file
      ? `${entry.file}${entry.line ? `:${entry.line}` : ""}`
      : "(repository)";
    reasons.push(`${entry.kind} ${where} ${entry.detail}`);
  }
  let mode = "selected";
  if (wanted.length === 0) mode = "nothing";
  else if (reasons.length > 0) mode = "fallback";
  const selection = [...selected].sort();
  const complete =
    mode === "selected" && gaps.unreached.length + gaps.nonJs.length + gaps.deleted.length === 0;

  const uncovered = [...gaps.unreached, ...gaps.nonJs, ...gaps.deleted];
  const commandFor = mode === "fallback" ? wanted : uncovered;
  return {
    mode,
    complete,
    changed: wanted,
    tests: selection,
    gaps,
    ignoredGaps:
      candidates.length - graphGaps.filter((entry) => entry.kind !== "inventory-cap").length,
    fallback:
      mode === "fallback" || uncovered.length > 0
        ? {
            reasons,
            commands: await packageCommands(commandFor, fileSet, readFile),
          }
        : null,
    runHint: await runHint(selection, fileSet, readFile),
  };
}

function section(title, lines) {
  const shown = lines.slice(0, LIST_LIMIT);
  const left = lines.length - shown.length;
  return [
    title,
    ...shown.map((line) => `  ${line}`),
    ...(left > 0 ? [`  ... and ${left} more`] : []),
  ];
}

/** The report as text for the command and the tool. */
export function formatAffected(report) {
  const { mode, changed, tests, gaps, fallback } = report;
  const out = [];
  const commands = (fallback?.commands ?? []).map((entry) => entry.command).filter(Boolean);
  if (mode === "nothing") return "Affected tests: no changed files. Nothing was run.";
  if (mode === "fallback") {
    out.push(
      `Affected tests: the import graph is incomplete, so a selection cannot be trusted. ${
        commands.length > 0
          ? `Run ${commands.join(" and ")} instead.`
          : "No package-level test script was found to fall back to."
      } Nothing was run.`,
    );
    out.push(...section("Why:", fallback.reasons));
    out.push(...section(`Tests that definitely reach a change (at least ${tests.length}):`, tests));
  } else {
    out.push(
      `Affected tests: ${tests.length} test files reach the ${changed.length} changed files${
        report.complete ? "" : ", but not all changed files are covered (see below)"
      }. Nothing was run.`,
    );
    if (tests.length > 0) out.push(...section("Tests:", tests));
    if (report.runHint) out.push(`To run them: ${report.runHint}`);
  }
  if (gaps.unreached.length > 0) {
    out.push(...section("No test reaches these changed files:", gaps.unreached));
  }
  if (gaps.nonJs.length > 0) {
    out.push(...section("Not TypeScript or JavaScript, and no test imports them:", gaps.nonJs));
  }
  if (gaps.deleted.length > 0) out.push(...section("Deleted, so not traced:", gaps.deleted));
  if (mode === "selected" && commands.length > 0) {
    out.push(`For the uncovered files, run ${commands.join(" and ")}.`);
  }
  return out.join("\n");
}

// check.mjs — the architecture check: boundary rules and import cycles.
//
// Pure over { files, readFile, rulesText }, so tests run it on an in-memory
// repository. It reads TypeScript and JavaScript only, follows imports through
// shared/import-graph.mjs, and says what it could not follow: a check that
// quietly skips what it cannot see would report "clean" for a repository it
// never looked at. No model, no key, no network, no write.

import { collectEdges, findCycles, loadImportGraph } from "../../shared/import-graph.mjs";
import { isTsFile, parseTsSource } from "../code-search/ts-parser.mjs";
import { matchGlob } from "./glob.mjs";
import { parseRules } from "./rules.mjs";

const LIST_LIMIT = 25;
const INCOMPLETE_LIMIT = 200;

function violationsFor(edges, { rules, ignore }) {
  const found = [];
  for (const edge of edges) {
    if (ignore.some((pattern) => matchGlob(pattern, edge.from))) continue;
    for (const rule of rules) {
      const captures = matchGlob(rule.from, edge.from);
      if (!captures) continue;
      const forbidden = rule.forbid.some((pattern) => matchGlob(pattern, edge.to, captures));
      const excepted = (rule.except ?? []).some((pattern) => matchGlob(pattern, edge.to, captures));
      if (!forbidden || excepted) continue;
      found.push({
        rule: rule.name,
        from: edge.from,
        to: edge.to,
        line: edge.line,
        kind: edge.kind,
        reason: rule.reason ?? null,
      });
    }
  }
  return found;
}

/**
 * @param {{
 *   files: string[],
 *   readFile: (rel: string) => Promise<string | null>,
 *   rulesText?: string | null,
 *   inventoryCapped?: boolean,
 *   limits?: { maxFiles?: number, maxBytes?: number },
 * }} input `rulesText` is the rules file's text, or null when there is none.
 */
export async function runArchitectureCheck({
  files,
  readFile,
  rulesText = null,
  inventoryCapped = false,
  limits = {},
}) {
  const present = rulesText != null;
  const parsed = present
    ? parseRules(rulesText)
    : { rules: [], ignore: [], cycles: "report", errors: [] };

  const all = [...new Set(files)].sort();
  const source = all.filter((file) => isTsFile(file));
  const graph = await loadImportGraph({ files: all, readFile });
  const {
    edges,
    incomplete: found,
    scanned,
  } = await collectEdges({
    graph,
    files: source,
    readFile,
    parse: parseTsSource,
    ...limits,
  });
  // A gap inside a file the rules ignore is not a gap in what is being checked.
  const ignored = (file) => file && parsed.ignore.some((pattern) => matchGlob(pattern, file));
  const incomplete = found.filter((entry) => !ignored(entry.file));
  if (inventoryCapped) {
    incomplete.push({
      kind: "inventory-cap",
      file: null,
      line: null,
      detail: "the repository has more files than the inventory limit; the rest were not listed",
    });
  }

  const checked = edges.filter((edge) => !ignored(edge.from));
  const violations = violationsFor(checked, parsed);
  const cycles = parsed.cycles === "off" ? null : findCycles(checked);

  return {
    ok: parsed.errors.length === 0 && violations.length === 0 && !(cycles && cycles.length > 0),
    rules: { present, count: parsed.rules.length, errors: parsed.errors },
    violations,
    cycles,
    coverage: {
      complete: incomplete.length === 0,
      sourceFiles: source.length,
      otherFiles: all.length - source.length,
      scanned,
      edges: checked.length,
      incompleteCount: incomplete.length,
      incomplete: incomplete.slice(0, INCOMPLETE_LIMIT),
    },
  };
}

const where = (entry) =>
  entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ""}` : "(repository)";

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
export function formatReport(report) {
  const { rules, violations, cycles, coverage } = report;
  const out = [];
  const cycleCount = cycles?.length ?? 0;
  let headline;
  if (!report.ok) {
    headline = `Architecture check: ${violations.length} violations, ${cycleCount} cycles${
      rules.errors.length > 0 ? `, ${rules.errors.length} rules-file errors` : ""
    }. Coverage ${coverage.complete ? "complete" : "INCOMPLETE"}.`;
  } else if (coverage.complete) {
    headline = "Architecture check: no violations, no cycles, coverage complete.";
  } else {
    headline =
      "Architecture check: no violations or cycles in the files it could follow. Coverage is INCOMPLETE, so this is not a clean result.";
  }
  out.push(headline);
  out.push(
    rules.present
      ? `Rules: ${rules.count} applied.`
      : "Rules: no rules file found; only the cycle check ran.",
  );
  if (rules.errors.length > 0) out.push(...section("Rules file errors:", rules.errors));
  if (violations.length > 0) {
    out.push(
      ...section(
        `Violations (${violations.length}):`,
        violations.map(
          (v) =>
            `${v.rule}: ${v.from}:${v.line} -> ${v.to}${v.kind === "static" ? "" : ` (${v.kind})`}${
              v.reason ? `. ${v.reason}` : ""
            }`,
        ),
      ),
    );
  }
  if (cycleCount > 0) {
    out.push(
      ...section(
        `Cycles (${cycleCount}):`,
        cycles.map((cycle) => cycle.join(" -> ")),
      ),
    );
  }
  out.push(
    `Read ${coverage.scanned} of ${coverage.sourceFiles} TypeScript/JavaScript files (${coverage.otherFiles} other files not parsed); ${coverage.edges} import edges.`,
  );
  if (!coverage.complete) {
    out.push(
      ...section(
        `Not followed (${coverage.incompleteCount}):`,
        coverage.incomplete.map((entry) => `${entry.kind} ${where(entry)} ${entry.detail}`),
      ),
    );
  }
  return out.join("\n");
}

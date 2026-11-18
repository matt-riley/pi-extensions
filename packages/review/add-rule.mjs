// add-rule.mjs — check a proposed judgement rule against existing ones, then
// write `.agents/rules/<name>.md` on approval. Jev compares; the user decides.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { askSystemOne } from "../../shared/systemone.mjs";
import { validateRequest } from "../../shared/systemone-request.mjs";
import {
  BUILTIN_RULE_IDS,
  formatRuleFile,
  resolveRepoRules,
  validateUserRuleFields,
} from "./rules.mjs";

const RULES_DIR = ".agents/rules";
const RELATIONS = new Set(["distinct", "covered", "clarification", "conflict"]);
const DEFAULT_TIMEOUT_MS = 12_000;

const RELATION_CRITERIA = {
  distinct: "The proposed rule addresses a different concern than this existing rule",
  covered: "This existing rule already covers what the proposed rule requires",
  clarification: "The proposed rule clarifies or narrows this existing rule without replacing it",
  conflict: "The proposed rule contradicts or cannot hold together with this existing rule",
};

export function ruleFilePath(repoRoot, name) {
  return join(String(repoRoot ?? ""), RULES_DIR, `${String(name).trim()}.md`);
}

function existingEntry(rule) {
  return {
    id: rule.id,
    subject: rule.label,
    instructions: rule.question?.instructions ?? "",
  };
}

function proposedEntry(fields, body) {
  const applicability = String(fields.applicability ?? "").trim();
  return {
    name: String(fields.name).trim(),
    subject: String(fields.subject).trim(),
    requirement: String(fields.requirement).trim(),
    purpose: String(fields.purpose).trim(),
    applicability: applicability || null,
    context: String(body ?? "").trim() || null,
  };
}

function compareQuestion(rule) {
  return {
    type: "choice",
    instructions:
      "Read `proposed` and `existing`. Each entry in `existing` has id, subject and instructions. " +
      `For the existing rule \`${rule.id}\`, how does \`proposed\` relate?`,
    criteria: { ...RELATION_CRITERIA },
  };
}

function buildRuleCompareQuestions(rules) {
  return Object.fromEntries(rules.map((rule) => [`cmp_${rule.id}`, compareQuestion(rule)]));
}

export function buildRuleCompareRequest(repoRoot, fields, body = "") {
  const { rules } = resolveRepoRules(repoRoot);
  const state = {
    proposed: proposedEntry(fields, body),
    existing: rules.map(existingEntry),
  };
  const questions = buildRuleCompareQuestions(rules);
  validateRequest({ state, questions });
  return { state, questions, ruleIds: rules.map((rule) => rule.id) };
}

function relationFromAnswer(answer) {
  if (answer?.type !== "choice") return null;
  const choice = String(answer.choice ?? "").trim();
  return RELATIONS.has(choice) ? choice : null;
}

export function analyzeComparisons(answers, ruleIds) {
  const relations = [];
  for (const id of ruleIds) {
    const relation = relationFromAnswer(answers?.[`cmp_${id}`]);
    if (!relation) return { ok: false, reason: "unusable-answer" };
    relations.push({ id, relation });
  }
  const blocking = relations.filter(
    (entry) => entry.relation === "covered" || entry.relation === "conflict",
  );
  const clarifications = relations.filter((entry) => entry.relation === "clarification");
  return {
    ok: true,
    relations,
    blocking,
    clarifications,
    canWrite: blocking.length === 0,
  };
}

export function formatCompareReport(analysis) {
  if (!analysis?.ok) return "Could not read Jev's comparison.";
  const lines = [];
  for (const entry of analysis.blocking) {
    lines.push(`${entry.id}: ${entry.relation}`);
  }
  for (const entry of analysis.clarifications) {
    lines.push(`${entry.id}: clarification`);
  }
  const distinct = (analysis.relations ?? []).filter((entry) => entry.relation === "distinct");
  if (distinct.length > 0 && lines.length === 0) {
    lines.push("Distinct from every existing rule.");
  }
  return lines.join("\n") || "No comparison result.";
}

function validationProblem(fields) {
  const problem = validateUserRuleFields(fields);
  if (problem) return problem;
  const name = String(fields.name).trim();
  if (BUILTIN_RULE_IDS.has(name)) return `built-in rule "${name}" already defines this id`;
  return null;
}

/**
 * Compare against built-in and user rules, show the report, and write on approval
 * when nothing is covered or in conflict. Fail closed on errors, rejection, or
 * unusable answers.
 */
export async function addUserRule({
  repoRoot,
  fields,
  body = "",
  ask = askSystemOne,
  approve = async () => false,
  env,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const problem = validationProblem(fields);
  if (problem) return { written: false, reason: "invalid", detail: problem };

  const path = ruleFilePath(repoRoot, fields.name);
  if (existsSync(path)) return { written: false, reason: "exists", path };

  let ruleIds;
  let state;
  let questions;
  try {
    ({ state, questions, ruleIds } = buildRuleCompareRequest(repoRoot, fields, body));
  } catch (error) {
    return {
      written: false,
      reason: "request-invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let answers;
  try {
    const result = await ask({
      state,
      questions,
      env,
      signal: signal ?? AbortSignal.timeout(timeoutMs),
      feature: "review",
    });
    answers = result?.answers;
  } catch (error) {
    return {
      written: false,
      reason: "jev-error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const analysis = analyzeComparisons(answers, ruleIds);
  if (!analysis.ok) return { written: false, reason: analysis.reason, analysis };
  if (!analysis.canWrite) {
    return { written: false, reason: "blocking-relation", analysis };
  }

  if (!(await approve(analysis))) {
    return { written: false, reason: "rejected", analysis };
  }

  try {
    mkdirSync(join(String(repoRoot), RULES_DIR), { recursive: true });
    writeFileSync(path, formatRuleFile(fields, body), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    return {
      written: false,
      reason: "write-failed",
      detail: error instanceof Error ? error.message : String(error),
      analysis,
    };
  }

  return { written: true, path, analysis };
}

/** Parse `/rules add` flags for non-interactive use and tests. */
function parseRulesAddArgs(raw) {
  const text = String(raw ?? "").trim();
  if (!/^add\b/.test(text)) {
    return {
      ok: false,
      message: "Usage: /rules add [--name … --subject … --requirement … --purpose …]",
    };
  }
  const fields = {};
  let body = "";
  const rest = text.replace(/^add\s*/, "");
  const pattern = /--([\w-]+)(?:=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?/g;
  for (let match = pattern.exec(rest); match; match = pattern.exec(rest)) {
    const key = match[1];
    let value = (match[2] ?? match[3] ?? "").trim();
    value = value.replace(/^(['"])(.*)\1$/, "$2");
    if (key === "body") body = value;
    else fields[key] = value;
  }
  const missing = ["name", "subject", "requirement", "purpose"].filter(
    (key) => !String(fields[key] ?? "").trim(),
  );
  if (missing.length > 0) {
    return { ok: false, message: `Missing field(s): ${missing.join(", ")}` };
  }
  return { ok: true, fields, body };
}

async function collectRuleFields(ui) {
  const name = (await ui.input("Rule name (kebab-case id)"))?.trim() ?? "";
  const subject = (await ui.input("Subject (short finding label)"))?.trim() ?? "";
  const requirement = (await ui.input("Requirement (what the diff must satisfy)"))?.trim() ?? "";
  const purpose = (await ui.input("Purpose (why the rule exists)"))?.trim() ?? "";
  const applicability =
    (await ui.input("Applicability (message, task, tests, or leave empty)"))?.trim() ?? "";
  return { name, subject, requirement, purpose, applicability };
}

/**
 * `/rules add` handler: parse flags or prompt, compare through Jev, confirm, write.
 */
export async function runRulesAdd({
  args = "",
  repoRoot = process.cwd(),
  ui,
  ask = askSystemOne,
  env,
  signal,
} = {}) {
  let fields;
  let body = "";
  const parsed = parseRulesAddArgs(args);
  if (parsed.ok) {
    fields = parsed.fields;
    body = parsed.body ?? "";
  } else if (ui?.input) {
    fields = await collectRuleFields(ui);
    body = (await ui.input("Optional body (examples or context)", "")) ?? "";
  } else {
    return { ok: false, message: parsed.message };
  }

  const result = await addUserRule({
    repoRoot,
    fields,
    body,
    ask,
    env,
    signal,
    approve: async (analysis) => {
      if (!ui?.confirm) return false;
      const report = formatCompareReport(analysis);
      const detail = [
        report,
        "",
        `name: ${fields.name}`,
        `subject: ${fields.subject}`,
        `requirement: ${fields.requirement}`,
        `purpose: ${fields.purpose}`,
      ].join("\n");
      return ui.confirm("Save this rule under .agents/rules?", detail);
    },
  });

  if (result.written) {
    return { ok: true, message: `Wrote ${result.path}`, path: result.path };
  }

  if (result.reason === "blocking-relation") {
    return {
      ok: false,
      message: `Not saved — overlaps an existing rule:\n${formatCompareReport(result.analysis)}`,
    };
  }
  if (result.reason === "rejected") {
    return { ok: false, message: "Not saved — declined." };
  }
  if (result.reason === "exists") {
    return {
      ok: false,
      message: `Not saved — ${ruleFilePath(repoRoot, fields.name)} already exists.`,
    };
  }
  if (result.reason === "invalid") {
    return { ok: false, message: `Not saved — ${result.detail}` };
  }
  if (result.reason === "unusable-answer") {
    return { ok: false, message: "Not saved — Jev returned an unusable comparison." };
  }
  if (result.reason === "jev-error") {
    return { ok: false, message: `Not saved — Jev error: ${result.detail}` };
  }
  return { ok: false, message: result.detail ? `Not saved — ${result.detail}` : "Not saved." };
}

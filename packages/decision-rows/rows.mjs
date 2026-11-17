// rows.mjs — one transcript row per saved decision entry.
//
// Several packages record their judgements with pi.appendEntry. Those entries
// never enter model context and, without a renderer, never show anywhere. This
// module turns the ones that carry news into a single collapsed line (expanded
// adds detail lines), and returns null for the rest so pi draws nothing.
//
// Only fields the entry already stores are read, and only the ones listed here
// are printed: prompt-coach's prompt text, probe and file names are never shown,
// and a Jev entry has no prompt or state to show. Every printed string is
// stripped of control characters, because a stored value could hold an ANSI
// escape that would repaint the terminal.

import { flagOff } from "../../shared/env-flag.mjs";
import { VERDICT_ENTRY } from "../../shared/verdict.mjs";

export const ROUTER_DECISION = "router-decision";
export const ROUTER_PLAYBOOK = "router-playbook";
export const JEV_DECISION = "jev-decision";
export const PROMPT_COACH_DECISION = "prompt-coach-decision";
export const ENTRY_TYPES = [
  ROUTER_DECISION,
  ROUTER_PLAYBOOK,
  JEV_DECISION,
  VERDICT_ENTRY,
  PROMPT_COACH_DECISION,
];

/** How much to show: "off", "changes" (the default) or "all". */
export function rowMode(value) {
  if (flagOff(value)) return "off";
  return String(value ?? "")
    .trim()
    .toLowerCase() === "all"
    ? "all"
    : "changes";
}

const MAX_TEXT = 80;

/** A stored value as one short, printable line. */
function clean(value) {
  const text = String(value ?? "")
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fixed(value, digits = 2) {
  const numeric = number(value);
  return numeric === null ? null : numeric.toFixed(digits);
}

/** The model id after its provider prefix: "anthropic/claude-x" → "claude-x". */
function shortModel(key) {
  const text = clean(key);
  return text ? text.split("/").pop() : "?";
}

function ms(value) {
  const numeric = number(value);
  return numeric === null ? null : `${Math.round(numeric)}ms`;
}

function join(parts) {
  return parts.filter(Boolean).join(" · ");
}

function detail(label, value) {
  if (value === null || value === undefined || value === "") return null;
  return `${label}: ${typeof value === "string" ? clean(value) : value}`;
}

function details(list) {
  return list.filter(Boolean);
}

// Router outcomes that change nothing: the turn stayed where it was.
const QUIET_ROUTER = new Set(["held", "no-rating", "aborted"]);

function routerDecision(data, mode) {
  const outcome = clean(data.outcome) || "unknown";
  const quiet = QUIET_ROUTER.has(outcome) || /^no-.+-model$/.test(outcome);
  if (quiet && mode !== "all") return null;
  const difficulty = fixed(data.difficulty);
  const to = data.to
    ? `${shortModel(data.to)}${data.toThinking ? `@${clean(data.toThinking)}` : ""}`
    : null;
  let head;
  if (outcome === "judge-failed") head = `judge failed, stayed on ${shortModel(data.from)}`;
  else if (to) head = `${outcome} → ${to}`;
  else head = `${outcome} on ${shortModel(data.from)}`;
  const tone = outcome === "judge-failed" || outcome === "failover" ? "warning" : "muted";
  return {
    tag: "router",
    tone,
    head: join([head, difficulty && `difficulty ${difficulty}`, data.tier && clean(data.tier)]),
    details: details([
      detail("from", data.from),
      detail("to", data.to),
      detail("threshold", fixed(data.threshold)),
      typeof data.boundary === "boolean" && detail("new task", data.boundary ? "yes" : "no"),
      number(data.contextTokens) !== null &&
        detail("context", `${Math.round(data.contextTokens / 1000)}k tokens`),
      detail("judged in", ms(data.latencyMs)),
      detail("error", data.error),
    ]),
  };
}

function routerPlaybook(data, mode) {
  const type = clean(data.type);
  const loaded = type && type !== "none";
  if (!loaded && !data.pinned && mode !== "all") return null;
  return {
    tag: "router",
    tone: "muted",
    head: join([loaded ? `playbook ${type}` : "no playbook", data.pinned && "pinned"]),
    details: details([
      typeof data.boundary === "boolean" && detail("new task", data.boundary ? "yes" : "no"),
    ]),
  };
}

/** "destructive noul 0.08" per answer; a choice is stored as an index, never its label. */
function answerLines(answers) {
  if (!answers || typeof answers !== "object") return [];
  const lines = [];
  for (const [id, answer] of Object.entries(answers)) {
    if (!answer || typeof answer !== "object") continue;
    const parts = [];
    for (const key of ["noul", "score", "confidence"]) {
      const value = fixed(answer[key]);
      if (value !== null) parts.push(`${key} ${value}`);
    }
    if (Number.isInteger(answer.choice)) parts.push(`choice #${answer.choice}`);
    if (parts.length) lines.push(`${clean(id)}: ${parts.join(", ")}`);
  }
  return lines;
}

function jevDecision(data, mode) {
  const ok = data.outcome === "ok";
  if (ok && !data.modelDrift && mode !== "all") return null;
  const feature = clean(data.feature) || "jev";
  let state = "answered";
  if (!ok) {
    const status = Number.isInteger(data.status) ? ` (HTTP ${data.status})` : "";
    state = `failed: ${clean(data.errorClass ?? data.outcome) || "unknown"}${status}`;
  }
  const questions = Array.isArray(data.questions)
    ? data.questions.map((item) => `${clean(item?.id)} (${clean(item?.kind)})`).join(", ")
    : null;
  let tone = "error";
  if (ok) tone = data.modelDrift ? "warning" : "muted";
  return {
    tag: "jev",
    tone,
    head: join([
      `${feature} ${state}`,
      ms(data.latencyMs),
      data.modelDrift && `model drift: ${clean(data.model)}`,
    ]),
    details: details([
      detail("model", data.model),
      data.requestedModel !== data.model && detail("requested", data.requestedModel),
      data.modelDrift && detail("tuned on", data.tunedModel),
      detail("transport", data.transport),
      detail("questions", questions),
      ...answerLines(data.answers),
      number(data.redactions) !== null && detail("secrets redacted", data.redactions),
      number(data.privacyRedactions) !== null &&
        detail("private values redacted", data.privacyRedactions),
    ]),
  };
}

const VERDICT_TONE = { verified: "success", failed: "error" };

function verifierVerdict(data) {
  const verdict = clean(data.verdict) || "unreadable";
  const head = clean(data.head).slice(0, 12);
  return {
    tag: "verifier",
    tone: VERDICT_TONE[verdict] ?? "warning",
    head: join([verdict, head && `at ${head}`]),
    details: details([
      detail("patch id", clean(data.patchId).slice(0, 16) || null),
      detail("base", data.base),
      detail("run", data.id),
      detail("at", data.at),
    ]),
  };
}

const COACH_TONE = { rewritten: "success", "rewritten-confirmed": "success" };

// The entry stores the prompt as written, the candidate, the placed text, a
// repository probe and the files read. None of that is printed: the row says
// what happened, not what was said.
function promptCoachDecision(data) {
  const action = clean(data.action) || "unknown";
  const intent = fixed(data.intentProbability);
  return {
    tag: "prompt-coach",
    tone: COACH_TONE[action] ?? (data.rewriteError || data.intentError ? "warning" : "muted"),
    head: join([action, intent && `intent ${intent}`, data.model && clean(data.model)]),
    details: details([
      typeof data.concise === "boolean" && detail("concise style", data.concise ? "yes" : "no"),
      typeof data.subscription === "boolean" &&
        detail("subscription", data.subscription ? "yes" : "no"),
      Array.isArray(data.filesRead) && detail("files read", data.filesRead.length),
      data.intentError && "intent check failed",
      data.rewriteError && "rewrite failed",
    ]),
  };
}

const ROWS = {
  [ROUTER_DECISION]: routerDecision,
  [ROUTER_PLAYBOOK]: routerPlaybook,
  [JEV_DECISION]: jevDecision,
  [VERDICT_ENTRY]: verifierVerdict,
  [PROMPT_COACH_DECISION]: promptCoachDecision,
};

/**
 * The row for one entry, or null when it should not be drawn.
 * `{ tag, tone, head, details }`: tag and head make the collapsed line.
 */
export function rowFor(customType, data, mode = "changes") {
  if (mode === "off") return null;
  const build = ROWS[customType];
  if (!build || !data || typeof data !== "object") return null;
  return build(data, mode);
}

/** The terminal lines for a row: one when collapsed, the details below it when expanded. */
export function rowLines(row, { expanded = false, width = 80, theme, truncate }) {
  const paint = (color, text) => (typeof theme?.fg === "function" ? theme.fg(color, text) : text);
  const fit = (text) => (typeof truncate === "function" ? truncate(text, width) : text);
  const lines = [fit(` ${paint("accent", row.tag)} ${paint(row.tone, row.head)}`)];
  if (expanded) for (const line of row.details) lines.push(fit(`   ${paint("dim", line)}`));
  return lines;
}

/**
 * Register a renderer for each entry type. A renderer returns undefined when
 * there is no row, which pi treats as nothing to draw. `truncateToWidth` comes
 * from the host's pi-tui, injected so this module stays testable.
 */
export function installDecisionRows(pi, { truncateToWidth } = {}, env = process.env) {
  const mode = rowMode(env.PI_DECISION_ROWS);
  if (mode === "off" || typeof pi?.registerEntryRenderer !== "function") return false;
  for (const customType of ENTRY_TYPES) {
    pi.registerEntryRenderer(customType, (entry, options, theme) => {
      const row = rowFor(customType, entry?.data, mode);
      if (!row) return undefined;
      const expanded = Boolean(options?.expanded);
      return {
        render: (width) => rowLines(row, { expanded, width, theme, truncate: truncateToWidth }),
        invalidate() {},
      };
    });
  }
  return true;
}

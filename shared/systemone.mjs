// systemone.mjs — TypeSafe System One ("Jev") request logic.
//
// Lives in shared/ because three packages consume it: pi-typesafe's
// typesafe_ask tool, pi-skill-select's optional tiebreaker, and the guardrail's
// destructive-action judge. One transport, one set of validation and timeout
// rules, one place to fix a bug.
//
// Plain .mjs so node --test can cover it without a TS loader (see AGENTS.md).
// The extension entrypoint owns tool registration; everything here is pure
// request building, validation, transport and formatting so it stays testable.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { redactSecrets } from "./redact.mjs";

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
// Pinned, not `jev-latest`: the guardrail, router, safe-compact and scripts/
// thresholds were measured on this version, and TypeSafe says to send a
// versioned ID once thresholds are tuned. Re-run scripts/judge-thresholds.mjs
// and scripts/replay-corpus.mjs on a new version before moving this pin.
const DEFAULT_MODEL = "jev-1.13.0";
const DEFAULT_TIMEOUT_MS = 30000;

const MAX_ERROR_BODY_CHARS = 300;

/** Jev's state limit. Past this the request fails whole, so it is refused here. */
const MAX_STATE_CHARS = 60_000;

const QUESTION_TYPES = new Set(["choice", "noul", "score"]);

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`TYPESAFE_BASE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TYPESAFE_BASE_URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Candidate lore config paths, mirroring lore's own resolver
 * (lib/core/lore-paths.mjs): LORE_CONFIG, then LORE_HOME or
 * XDG_CONFIG_HOME/lore, with the legacy ~/.copilot fallback kept for installs
 * that have not been migrated.
 */
function loreConfigPaths(env) {
  const explicitConfig = typeof env?.LORE_CONFIG === "string" ? env.LORE_CONFIG.trim() : "";
  if (explicitConfig) {
    // An explicit override means that file, exactly as lore treats it: no
    // silent fallback that could authenticate with something else.
    return [explicitConfig];
  }
  const home = typeof env?.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : homedir();
  const copilotHome =
    typeof env?.LORE_COPILOT_HOME === "string" && env.LORE_COPILOT_HOME.trim()
      ? env.LORE_COPILOT_HOME.trim()
      : join(home, ".copilot");
  const xdgHome = typeof env?.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const configHome = xdgHome && isAbsolute(xdgHome) ? xdgHome : join(home, ".config");
  const explicitHome = typeof env?.LORE_HOME === "string" ? env.LORE_HOME.trim() : "";
  const preferredHome = explicitHome || join(configHome, "lore");
  const preferredConfig = join(preferredHome, "lore.json");
  // lore only reads the pre-migration home while nothing has been migrated, so
  // a stale legacy key cannot shadow the current config.
  const legacy = !explicitHome && !existsSync(preferredConfig);
  return legacy ? [preferredConfig, join(copilotHome, "lore.json")] : [preferredConfig];
}

/**
 * Last-resort key source: the lore config. Returns the paths checked and any
 * parse failure so the caller can say what it looked at instead of blaming the
 * environment for a config typo.
 */
function apiKeySources(env) {
  const checked = loreConfigPaths(env);
  let parseError = null;
  for (const configPath of checked) {
    let raw;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch {
      continue; // absent or unreadable: keep looking
    }
    try {
      const key = JSON.parse(raw)?.typesafe?.apiKey;
      if (typeof key === "string" && key.trim()) {
        return { key: key.trim(), checked, parseError };
      }
    } catch (error) {
      parseError = `${configPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { key: "", checked, parseError };
}

/**
 * The shared TypeSafe key, in precedence order: TYPESAFE_API_KEY, then
 * LORE_TYPESAFE_API_KEY, then the lore config file. Never throws.
 */
export function resolveApiKey(env = process.env) {
  const primaryKey = typeof env?.TYPESAFE_API_KEY === "string" ? env.TYPESAFE_API_KEY.trim() : "";
  const loreKey =
    typeof env?.LORE_TYPESAFE_API_KEY === "string" ? env.LORE_TYPESAFE_API_KEY.trim() : "";
  return primaryKey || loreKey || apiKeySources(env).key;
}

/** Resolve runtime configuration from the environment. */
export function resolveConfig(env = process.env) {
  const model = typeof env?.TYPESAFE_MODEL === "string" ? env.TYPESAFE_MODEL.trim() : "";
  return {
    apiKey: resolveApiKey(env),
    baseUrl: normalizeBaseUrl(env?.TYPESAFE_BASE_URL),
    model: model || DEFAULT_MODEL,
    timeoutMs: positiveInteger(env?.TYPESAFE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasInstructions(question) {
  const instructions = question?.instructions;
  if (typeof instructions === "string") {
    return instructions.trim().length > 0;
  }
  if (Array.isArray(instructions)) {
    return instructions.length > 0;
  }
  return isPlainObject(instructions) && Object.keys(instructions).length > 0;
}

/**
 * Validate a questions map before any network call. Throws with a message the
 * model can act on, because a malformed question is a caller bug, not a
 * provider failure.
 */
export function validateQuestions(questions) {
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    throw new Error("Provide at least one question in the questions map.");
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!isPlainObject(question)) {
      throw new Error(`Question "${id}" must be an object with type, instructions and criteria.`);
    }
    if (!QUESTION_TYPES.has(question.type)) {
      throw new Error(
        `Question "${id}" has unknown question type "${question.type}". Use choice, noul or score.`,
      );
    }
    if (!hasInstructions(question)) {
      throw new Error(`Question "${id}" needs instructions — the actual judgment to make.`);
    }
    if (question.type === "choice") {
      if (!isPlainObject(question.criteria) || Object.keys(question.criteria).length < 2) {
        throw new Error(`Choice question "${id}" needs criteria with at least two options.`);
      }
    }
    if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
        throw new Error(`Score question "${id}" needs criteria with at least two ordered levels.`);
      }
    }
  }
  return questions;
}

/**
 * Jev refuses a state past its limit, and the whole request fails with it — so
 * the size is refused here, before the round trip, where the message can name
 * the limit and the actual size instead of an error body that says the same
 * thing less clearly, and without paying for a request that cannot succeed.
 */
export function validateState(state) {
  const size = JSON.stringify(state ?? {}).length;
  if (size > MAX_STATE_CHARS) {
    throw new Error(
      `TypeSafe state is ${size} characters; the limit is ${MAX_STATE_CHARS}. Send less per request.`,
    );
  }
}

/**
 * A state reaches the model as JSON, and JSON has no way to say "undefined", a
 * function, or a Map: those keys arrive absent, so a question that names one is
 * answered from an empty state and the caller reads the null as "keep". Report
 * the first value that would not survive the trip, by path.
 */
function stateProblem(value, path, seen = new Set()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return null;
  if (type === "number") {
    return Number.isFinite(value) ? null : `${path} is ${value}, which JSON turns into null`;
  }
  if (type === "undefined") return `${path} is undefined, which JSON drops`;
  if (type !== "object") return `${path} is a ${type}, which JSON drops`;
  if (seen.has(value)) return `${path} is circular, which JSON cannot serialize`;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const problem = stateProblem(item, `${path}[${index}]`, seen);
      if (problem) return problem;
    }
    return null;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    const name = value.constructor?.name ?? "non-plain object";
    return `${path} is a ${name}, which JSON serializes as {}`;
  }
  for (const [key, item] of Object.entries(value)) {
    const problem = stateProblem(item, `${path}.${key}`, seen);
    if (problem) return problem;
  }
  return null;
}

/** A backticked reference in a question: the way these prompts name their input. */
const REFERENCE = /`([^`\n]+)`/g;
const REFERENCE_SHAPE = /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/;

/** Every string in a question that could name a state path. */
function questionStrings(question) {
  const parts = [question?.instructions];
  const criteria = question?.criteria;
  if (Array.isArray(criteria)) parts.push(...criteria);
  else if (criteria && typeof criteria === "object") parts.push(...Object.values(criteria));
  return parts.filter((part) => typeof part === "string");
}

/**
 * A question that names a path the state does not have is answered from nothing,
 * and the caller cannot tell that from a considered "no". Backticked names are
 * how these prompts refer to their input, so a reference that starts at a
 * top-level key of the state has to resolve all the way down.
 */
export function validateReferences(state, questions) {
  const keys = Object.keys(isPlainObject(state) ? state : {});
  for (const [id, question] of Object.entries(questions)) {
    for (const text of questionStrings(question)) {
      for (const match of text.matchAll(REFERENCE)) {
        const reference = match[1].trim();
        if (!REFERENCE_SHAPE.test(reference)) continue;
        const parts = reference.split(".");
        // References to things that are not state — a disposition name, a file
        // path, a command — are none of this check's business.
        if (!keys.includes(parts[0])) continue;
        let node = state;
        let walked = "";
        for (const part of parts) {
          walked = walked ? `${walked}.${part}` : part;
          if (node === null || typeof node !== "object" || !(part in node)) {
            throw new Error(
              `Question "${id}" refers to \`${reference}\`, and the state has no \`${walked}\`. ` +
                `The state has: ${keys.join(", ")}.`,
            );
          }
          node = node[part];
        }
      }
    }
  }
  return questions;
}

/**
 * Everything a request needs to be true before it is worth sending: the
 * questions, the size of the state, whether the state survives JSON, and
 * whether the questions name what the state holds. Called by askSystemOne and
 * by the sweeps that check every call site in this repo.
 */
export function validateRequest({ state, questions } = {}) {
  validateQuestions(questions);
  validateState(state);
  const problem = stateProblem(state ?? {}, "state");
  if (problem) throw new Error(`${problem}. Use null for an absent value.`);
  validateReferences(state ?? {}, questions);
  return { state, questions };
}

async function readErrorBody(response) {
  if (typeof response?.text !== "function") {
    return "";
  }
  try {
    const body = String(await response.text()).trim();
    return body ? `: ${body.slice(0, MAX_ERROR_BODY_CHARS)}` : "";
  } catch {
    return "";
  }
}

/**
 * Ask TypeSafe's System One model one or more typed questions about `state`.
 *
 * @param {{ state: unknown, questions: object, model?: string, env?: object, fetchImpl?: typeof fetch, signal?: AbortSignal }} opts
 * @returns {Promise<{ model: string, answers: object, usage: object | null, redactions: number }>}
 */
export async function askSystemOne({
  state,
  questions,
  model,
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const config = resolveConfig(env);
  // Redact before validating: the size and shape checks should describe what
  // would actually be sent, and a secret is not what makes a request too big.
  const { value: safeState, count: redactions } = redactSecrets(state, {
    literals: [config.apiKey],
  });
  validateRequest({ state: safeState, questions });
  if (!config.apiKey) {
    const sources = apiKeySources(env);
    const detail = sources.parseError ? ` (unreadable config: ${sources.parseError})` : "";
    throw new Error(
      `TYPESAFE_API_KEY is not set. Set it in the environment or as typesafe.apiKey in ${sources.checked.join(" or ")}${detail}.`,
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to call TypeSafe.");
  }
  const requestedModel = typeof model === "string" && model.trim() ? model.trim() : config.model;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);

  try {
    if (signal?.aborted) {
      throw new Error("TypeSafe request aborted");
    }
    if (signal) {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const response = await fetchImpl(`${config.baseUrl}/systemone`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify({ model: requestedModel, state: safeState, questions }),
      // Fixed remote host: refusing redirects keeps state and the bearer
      // token from following an unexpected Location.
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) {
      const detail = await readErrorBody(response);
      throw new Error(
        `TypeSafe request failed with status ${response?.status ?? "unknown"}${detail}`,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`TypeSafe returned invalid JSON: ${message}`, { cause: error });
    }
    return {
      model:
        typeof payload?.model === "string" && payload.model.trim() ? payload.model : requestedModel,
      answers: isPlainObject(payload?.answers) ? payload.answers : {},
      usage: isPlainObject(payload?.usage) ? payload.usage : null,
      redactions,
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(`TypeSafe request timed out after ${config.timeoutMs}ms`, { cause: error });
    }
    if (signal?.aborted) {
      throw new Error("TypeSafe request aborted", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener("abort", forwardAbort);
    }
  }
}

function formatProbabilities(probabilities, legend) {
  const entries = Object.entries(probabilities ?? {});
  // Score levels come back keyed "0".."n" — keep numeric order and label them.
  const numeric = entries.every(([key]) => /^\d+$/.test(key));
  const ordered = numeric
    ? [...entries].sort((left, right) => Number(left[0]) - Number(right[0]))
    : [...entries].sort((left, right) => Number(right[1]) - Number(left[1]));
  return ordered
    .map(([key, value]) => {
      const probability = Number(value).toFixed(2);
      return numeric && legend?.[key]
        ? `${key}=${legend[key]} (${probability})`
        : `${key}=${probability}`;
    })
    .join(" ");
}

/**
 * A number the answer actually gave, or null when it gave none.
 *
 * Number(null) and Number("") are both 0, and 0 is a real reading — so an
 * absent value must never come back as a confident zero. Every caller routes
 * "below the threshold" and "no answer" to opposite decisions, which is why
 * this is one function rather than a copy per package.
 */
export function usableNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && !value.trim()) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Render answers as compact text for the model to read. */
export function formatAnswers({ model, usage, answers, redactions } = {}) {
  const lines = [];
  const tokens = usage
    ? `input_tokens=${usage.input_tokens ?? "?"} output_tokens=${usage.output_tokens ?? "?"}`
    : "usage unavailable";
  // A redaction changes what the model was shown, so it belongs next to the
  // answer it shaped rather than in a log nobody reads.
  const redacted = redactions > 0 ? ` · ${redactions} redacted` : "";
  lines.push(`${model ?? DEFAULT_MODEL} (${tokens})${redacted}`);
  const entries = Object.entries(answers ?? {});
  if (entries.length === 0) {
    lines.push("(no answers)");
    return lines.join("\n");
  }
  for (const [id, answer] of entries) {
    if (answer?.type === "noul") {
      const value = usableNumber(answer.noul);
      lines.push(
        value === null
          ? `${id}: unusable answer (no noul value)`
          : `${id}: noul ${value.toFixed(2)}`,
      );
      continue;
    }
    if (answer?.type === "choice") {
      if (typeof answer.choice !== "string" || !answer.choice.trim()) {
        lines.push(`${id}: unusable answer (no choice value)`);
        continue;
      }
      const confidence = Number.isFinite(Number(answer.confidence))
        ? ` (confidence ${Number(answer.confidence).toFixed(2)})`
        : "";
      lines.push(`${id}: choice "${answer.choice}"${confidence}`);
      const probabilities = formatProbabilities(answer.probabilities);
      if (probabilities) {
        lines.push(`  probabilities: ${probabilities}`);
      }
      continue;
    }
    if (answer?.type === "score") {
      const value = usableNumber(answer.score);
      if (value === null) {
        lines.push(`${id}: unusable answer (no score value)`);
        continue;
      }
      const confidence = Number.isFinite(Number(answer.confidence))
        ? ` (confidence ${Number(answer.confidence).toFixed(2)})`
        : "";
      lines.push(`${id}: score ${value.toFixed(2)}${confidence}`);
      const probabilities = formatProbabilities(answer.probabilities, answer.legend);
      if (probabilities) {
        lines.push(`  probabilities: ${probabilities}`);
      }
      continue;
    }
    lines.push(`${id}: ${JSON.stringify(answer)}`);
  }
  return lines.join("\n");
}

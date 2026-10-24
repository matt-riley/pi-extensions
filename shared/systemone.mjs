// systemone.mjs — ask TypeSafe System One ("Jev") from inside an extension.
//
// Public entry: askSystemOne, the ledger entry it appends, and answer formatting.
// The pieces live next door and each has one job: systemone-config.mjs (endpoint
// and key), systemone-request.mjs (what may be asked), systemone-transport.mjs
// (how it is sent), systemone-session.mjs (the store bindSystemOne fills). Plain
// .mjs, so node --test covers it without a TS loader.

import {
  appendLedgerEntry,
  buildLedgerEntry,
  callingFeature,
  ledgerErrorClass,
  ledgerHttpStatus,
  TUNED_MODEL,
  warnModelDrift,
} from "./jev-ledger.mjs";
import { redactSecrets } from "./redact.mjs";
import {
  DEFAULT_MODEL,
  resolveConfig,
  missingKeyError,
  configuredBaseUrl,
} from "./systemone-config.mjs";
import { RETRY_BASE_MS, askViaClassify, askOverHttp } from "./systemone-transport.mjs";
import { validateRequest } from "./systemone-request.mjs";
import { sessionStore } from "./systemone-session.mjs";

function isSystemOneClassifier(model) {
  return (
    !!model &&
    model.type === "classifier" &&
    model.provider === "typesafe" &&
    model.api === "typesafe-system-one"
  );
}

/**
 * The TypeSafe System One model Pi should classify with.
 *
 * Stock Pi registers `jev-latest`, not the pinned id. Cloning the catalog
 * model and rewriting `id` keeps auth, base URL and the classify implementation
 * while the wire payload stays on the version the thresholds were measured on.
 * Returns null when nothing registered can serve this call, which is the
 * signal to use the direct HTTP transport.
 */
function selectClassifier(registry, requestedModel, baseUrl) {
  if (!registry || typeof registry.classify !== "function") return null;
  let model = null;
  if (typeof registry.findOfType === "function") {
    const exact = registry.findOfType("classifier", "typesafe", requestedModel);
    if (isSystemOneClassifier(exact)) model = exact;
  }
  if (!model && typeof registry.getModelsOfType === "function") {
    const models = registry.getModelsOfType("classifier", "typesafe");
    if (Array.isArray(models)) {
      model = models.find((candidate) => isSystemOneClassifier(candidate)) ?? null;
    }
  }
  if (!model) return null;
  const cloned = { ...model, id: requestedModel };
  if (baseUrl) cloned.baseUrl = baseUrl;
  return cloned;
}

/** Pi's stored provider key. Used only as a redaction literal, never as a request. */
async function storedProviderKey(registry) {
  if (typeof registry?.getApiKeyForProvider !== "function") return "";
  try {
    const key = await registry.getApiKeyForProvider("typesafe");
    return typeof key === "string" ? key.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Ask TypeSafe's System One model one or more typed questions about `state`.
 *
 * Uses Pi's classifier when `ctx` (or the context bound by `bindSystemOne`)
 * has a TypeSafe System One model. Otherwise posts to `/systemone` directly.
 *
 * @param {{ state: unknown, questions: object, model?: string, env?: object, fetchImpl?: typeof fetch, signal?: AbortSignal, retryDelayMs?: number, ctx?: object, feature?: string }} opts
 * @returns {Promise<{ model: string, answers: object, usage: object | null, redactions: number, privacyRedactions?: number }>}
 */
export async function askSystemOne({
  state,
  questions,
  model,
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal,
  retryDelayMs = RETRY_BASE_MS,
  ctx,
  feature,
  failurePolicy,
} = {}) {
  const started = Date.now();
  const sessionPi = sessionStore()?.pi;
  const namedFeature =
    typeof feature === "string" && feature.trim() ? feature.trim() : callingFeature();
  const bag = {
    feature: namedFeature,
    requestedModel: "",
    transport: "http",
    redactions: 0,
    privacyRedactions: 0,
    literals: [],
  };
  try {
    const config = resolveConfig(env);
    const requestedModel = typeof model === "string" && model.trim() ? model.trim() : config.model;
    bag.requestedModel = requestedModel;
    const registry = (ctx ?? sessionStore()?.ctx)?.modelRegistry;
    const classifier = selectClassifier(registry, requestedModel, configuredBaseUrl(env, config));
    bag.transport = classifier ? "classify" : "http";
    // Redact before validating: the size and shape checks should describe what
    // would actually be sent, and a secret is not what makes a request too big.
    // The local key is not the only credential that can sit in the state. On the
    // classify path Pi may also hold a stored TypeSafe key that never appears in
    // the environment.
    const literals = [config.apiKey];
    if (classifier) {
      const stored = await storedProviderKey(registry);
      if (stored) literals.push(stored);
    }
    bag.literals = literals;
    // One masked copy, before either transport. Home paths are masked by default;
    // emails only when PI_MASK_EMAILS=1. Credential redactions stay a separate count.
    const {
      value: safeState,
      count: redactions,
      privacyCount = 0,
    } = redactSecrets(state, {
      literals,
      maskEmails: env?.PI_MASK_EMAILS === "1",
    });
    bag.redactions = redactions;
    bag.privacyRedactions = privacyCount;
    validateRequest({ state: safeState, questions });
    // Nothing is sent without a local key. Pi's stored login is not a substitute;
    // that can be an opt-in later. The HTTP path already refused here.
    if (!config.apiKey) throw missingKeyError(env);
    if (!classifier && typeof fetchImpl !== "function") {
      throw new Error("A fetch implementation is required to call TypeSafe.");
    }
    const sessionCtx = ctx ?? sessionStore()?.ctx;
    const result = classifier
      ? await askViaClassify({
          registry,
          classifier,
          safeState,
          questions,
          redactions,
          privacyCount,
          requestedModel,
          config,
          env,
          fetchImpl,
          signal,
          retryDelayMs,
        })
      : await askOverHttp({
          config,
          requestedModel,
          safeState,
          questions,
          redactions,
          privacyCount,
          fetchImpl,
          signal,
          retryDelayMs,
        });
    // The answer is in hand. Ledger work — the drift warning, the entry, the
    // append — must not turn it into a throw. Pi's ctx.ui and ctx.sessionManager
    // getters throw after /new, a fork, or a reload, and a malformed answer
    // throws inside the builder. Swallowing here also keeps the outer catch from
    // recording that success as a failure.
    try {
      const modelDrift = typeof result.model === "string" && result.model !== TUNED_MODEL;
      if (modelDrift) warnModelDrift({ reported: result.model, ctx: sessionCtx });
      appendLedgerEntry(
        sessionPi,
        buildLedgerEntry({
          feature: namedFeature,
          model: result.model,
          requestedModel,
          questions,
          answers: result.answers,
          latencyMs: Date.now() - started,
          transport: bag.transport,
          redactions,
          privacyRedactions: privacyCount,
          outcome: "ok",
          literals,
          modelDrift,
          tunedModel: TUNED_MODEL,
        }),
      );
    } catch {
      // The gate is waiting on `result`, not on the session entry.
    }
    return result;
  } catch (error) {
    try {
      // Classifying the error reads it as a string. A thrown value with no
      // prototype cannot be stringified, and that TypeError must not replace
      // the value the transport threw.
      const errorClass = ledgerErrorClass(error);
      const policy =
        failurePolicy === "fail-open" || failurePolicy === "fail-closed" ? failurePolicy : null;
      appendLedgerEntry(
        sessionPi,
        buildLedgerEntry({
          feature: bag.feature,
          model: null,
          requestedModel: bag.requestedModel,
          questions,
          answers: null,
          latencyMs: Date.now() - started,
          transport: bag.transport,
          redactions: bag.redactions,
          privacyRedactions: bag.privacyRedactions,
          outcome: policy ?? errorClass,
          errorClass: policy ? errorClass : undefined,
          literals: bag.literals,
          status: errorClass === "http" ? ledgerHttpStatus(error) : undefined,
        }),
      );
    } catch {
      // Classifying or building the entry must not replace the Jev error.
    }
    throw error;
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
export function formatAnswers({ model, usage, answers, redactions, privacyRedactions } = {}) {
  const lines = [];
  const tokens = usage
    ? `input_tokens=${usage.input_tokens ?? "?"} output_tokens=${usage.output_tokens ?? "?"}`
    : "usage unavailable";
  // A redaction changes what the model was shown, so it belongs next to the
  // answer it shaped rather than in a log nobody reads.
  const totalRedactions = (redactions ?? 0) + (privacyRedactions ?? 0);
  const redacted = totalRedactions > 0 ? ` · ${totalRedactions} redacted` : "";
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

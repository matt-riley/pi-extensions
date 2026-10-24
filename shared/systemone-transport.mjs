// systemone-transport.mjs — one deadline, one retry schedule, two transports:
// Pi's classifier registry when a TypeSafe model is registered, direct HTTPS
// when it is not.

import { missingKeyError } from "./systemone-config.mjs";
import { isPlainObject } from "./systemone-request.mjs";
import { recordSessionUsage } from "./systemone-session.mjs";

const MAX_ERROR_BODY_CHARS = 300;

/**
 * TypeSafe asks for exponential backoff on 429 (rate limit) and 529
 * (overloaded): https://docs.typesafe.ai/api/errors.md. Without it a gate
 * that fails open skips its judgment on the first busy moment. Retries stay
 * inside the request timeout and the caller's abort signal.
 */
const RETRY_STATUSES = new Set([429, 529]);

const MAX_RETRIES = 2;

export const RETRY_BASE_MS = 500;

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

/** Wait `ms`, or reject as soon as `signal` aborts. */
function backoff(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function mapPiAnswers(answers) {
  if (!isPlainObject(answers)) return {};
  const mapped = {};
  for (const [id, answer] of Object.entries(answers)) {
    // Pi rewrites wire `noul` to `{ type: "bool", probability }`. Callers still
    // route on `type: "noul"` and `answer.noul`.
    mapped[id] = answer?.type === "bool" ? { type: "noul", noul: answer.probability } : answer;
  }
  return mapped;
}

function mapPiUsage(usage) {
  if (!isPlainObject(usage)) return null;
  if ("input_tokens" in usage || "output_tokens" in usage) return usage;
  if (typeof usage.input === "number" || typeof usage.output === "number") {
    return { input_tokens: usage.input ?? 0, output_tokens: usage.output ?? 0 };
  }
  return null;
}

async function readJsonClone(response) {
  if (!response || typeof response.clone !== "function") return undefined;
  try {
    const cloned = response.clone();
    if (!cloned || typeof cloned.json !== "function") return undefined;
    const payload = await cloned.json();
    return isPlainObject(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function classifyFailure(result, config, env) {
  const message =
    typeof result?.errorMessage === "string" && result.errorMessage.trim()
      ? result.errorMessage
      : `TypeSafe classify failed (${result?.stopReason ?? "unknown"})`;
  // Pi's own auth error, and only when we had nothing to pass in. A local key
  // that Pi rejected should stay Pi's message.
  if (!config.apiKey && /no api key|not configured|api key/i.test(message)) {
    return missingKeyError(env);
  }
  return new Error(message);
}

function reportedModel(payload, result, requestedModel) {
  if (typeof payload?.model === "string" && payload.model.trim()) return payload.model;
  if (typeof result?.model === "string" && result.model.trim()) return result.model;
  return requestedModel;
}

function countedRedactions(redactions, privacyCount) {
  return {
    redactions,
    ...(privacyCount > 0 ? { privacyRedactions: privacyCount } : {}),
  };
}

/**
 * One deadline for both transports: the timer aborts the request, a caller abort
 * is forwarded, and every exit path carries the message `ledgerErrorClass` reads.
 */
async function bounded(signal, timeoutMs, fn) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);
  try {
    if (signal?.aborted) throw new Error("TypeSafe request aborted");
    if (signal) signal.addEventListener("abort", forwardAbort, { once: true });
    return await fn(controller);
  } catch (error) {
    if (timedOut) {
      throw new Error(`TypeSafe request timed out after ${timeoutMs}ms`, { cause: error });
    }
    if (signal?.aborted) throw new Error("TypeSafe request aborted", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}

export async function askViaClassify({
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
}) {
  const captured = { payload: undefined };
  return bounded(signal, config.timeoutMs, async (controller) => {
    // maxRetries: 0 keeps Pi from applying its own policy: 408, 409, other
    // 5xx, and a Retry-After that can outlast this call. The loop below is
    // the same 429/529 schedule as the direct HTTP transport.
    const fetchWrapper = async (url, init) => {
      let response;
      let attempt = 0;
      for (;;) {
        response = await fetchImpl(url, { ...init, redirect: "error" });
        if (response?.ok || !RETRY_STATUSES.has(response?.status) || attempt >= MAX_RETRIES) break;
        await readErrorBody(response);
        await backoff(retryDelayMs * 2 ** attempt, controller.signal);
        attempt++;
      }
      // Pi parses noul into bool and drops score probabilities. The raw body
      // of a successful response is what every gate already knows how to read.
      if (response?.ok) captured.payload = await readJsonClone(response);
      return response;
    };
    const result = await registry.classify(
      classifier,
      { state: safeState, questions },
      {
        signal: controller.signal,
        maxRetries: 0,
        fetch: fetchWrapper,
        headers: { "User-Agent": null },
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      },
    );
    // A timeout or a caller abort can come back as a result instead of a throw;
    // rethrowing here lets bounded() name it once, for both transports.
    if (controller.signal.aborted || result?.stopReason === "aborted") {
      throw new Error("TypeSafe request aborted");
    }
    const payload = captured.payload;
    // Pi rejects a 200 that omits one question (`did not return an answer`).
    // The HTTP transport returns that body, and the request was already billed.
    const partial =
      result?.stopReason !== "stop" &&
      /did not return an answer/i.test(result?.errorMessage ?? "") &&
      isPlainObject(payload?.answers);
    if (result?.stopReason !== "stop" && !partial) throw classifyFailure(result, config, env);
    recordSessionUsage(result?.usage);
    return {
      model: reportedModel(payload, result, requestedModel),
      answers: isPlainObject(payload?.answers) ? payload.answers : mapPiAnswers(result?.answers),
      usage: isPlainObject(payload?.usage) ? payload.usage : mapPiUsage(result?.usage),
      ...countedRedactions(redactions, privacyCount),
    };
  });
}

export async function askOverHttp({
  config,
  requestedModel,
  safeState,
  questions,
  redactions,
  privacyCount,
  fetchImpl,
  signal,
  retryDelayMs,
}) {
  return bounded(signal, config.timeoutMs, async (controller) => {
    const body = JSON.stringify({ model: requestedModel, state: safeState, questions });
    let response;
    let attempt = 0;
    for (;;) {
      response = await fetchImpl(`${config.baseUrl}/systemone`, {
        method: "POST",
        // No TypeSafe-Danger-Zone-Images header: TypeSafe wants it only on
        // requests that carry images (`assets`), and this transport sends none.
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body,
        // Fixed remote host: refusing redirects keeps state and the bearer
        // token from following an unexpected Location.
        redirect: "error",
        signal: controller.signal,
      });
      if (response?.ok || !RETRY_STATUSES.has(response?.status) || attempt >= MAX_RETRIES) break;
      await readErrorBody(response); // drain before retrying
      await backoff(retryDelayMs * 2 ** attempt, controller.signal);
      attempt++;
    }
    if (!response?.ok) {
      const detail = await readErrorBody(response);
      const tries = attempt > 0 ? ` after ${attempt + 1} attempts` : "";
      throw new Error(
        `TypeSafe request failed with status ${response?.status ?? "unknown"}${tries}${detail}`,
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
      model: reportedModel(payload, null, requestedModel),
      answers: isPlainObject(payload?.answers) ? payload.answers : {},
      usage: isPlainObject(payload?.usage) ? payload.usage : null,
      ...countedRedactions(redactions, privacyCount),
    };
  });
}

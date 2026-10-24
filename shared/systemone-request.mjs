// systemone-request.mjs — the state and questions a request may contain, checked
// before anything leaves the process. Pure: no I/O, no transport, no host.

/** Jev's state limit. Past this the request fails whole, so it is refused here. */
const MAX_STATE_CHARS = 60_000;

const QUESTION_TYPES = new Set(["choice", "noul", "score"]);

export function isPlainObject(value) {
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

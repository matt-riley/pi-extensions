// judge.mjs — the Jev half of safe-compact.
//
// Every model judgment lives here as typed questions whose answers code routes
// on. Nothing generates prose: Jev scores, classifies and selects among spans
// that segment.mjs produced. `ask` is injectable so the whole module runs in
// tests without a network.

import { askSystemOne } from "../../shared/systemone.mjs";
import { excerpt } from "./segment.mjs";

const MAX_TEXT_CHARS = 1500;
const MAX_CANDIDATES = 40;
const MAX_CANDIDATE_CHARS = 400;

export const DISPOSITIONS = {
  keep_verbatim:
    "Its exact words matter later: a requirement, a precise result, code, or an error.",
  point: "Its content lives in a file or command that can be re-read instead of remembered.",
  excerpt: "Only the gist matters: what was done or found, not the detail.",
  drop: "Nothing here is needed to continue: a dead end, chatter, an acknowledgement, a redundant result.",
};

// Number(null) is 0, which would read as a confident "no". Absent stays absent.
function usable(raw) {
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const yes = (answer) => (answer?.type === "noul" ? usable(answer.noul) : null);

const noul = (instructions, whenTrue, whenFalse) => ({
  type: "noul",
  instructions,
  criteria: { true: whenTrue, false: whenFalse },
});

function buildSegmentQuestions() {
  return {
    load_bearing: noul(
      "Given `goal`, is the information in `segment` still needed to continue the work: facts discovered, " +
        "code state, or results that later steps depend on?",
      "Later steps depend on something this segment established.",
      "The segment is chatter, a finished detour, or nothing later work needs.",
    ),
    user_constraint: noul(
      "Does `segment` contain an instruction, preference, requirement or prohibition from the user that " +
        "should keep applying to future work?",
      "It states a rule, preference, or requirement that must persist.",
      "It is a one-off request, a question, or has no lasting rule in it.",
    ),
    decision: noul(
      "Does `segment` record a choice between alternatives, or the reason one approach was chosen?",
      "A choice or its rationale is stated.",
      "No choice or rationale: it is action, output, or discussion without a decision.",
    ),
    unresolved: noul(
      "Does `segment` report an error, failure or open problem that `next` does not show being fixed or answered?",
      "A problem is reported and nothing in `next` resolves it.",
      "There is no problem, or `next` shows it handled.",
    ),
    dead_end: noul(
      "Was the approach in `segment` abandoned, superseded, or shown to be wrong by `next`?",
      "It was abandoned or contradicted.",
      "It still stands or `next` is unrelated.",
    ),
    recoverable: noul(
      "Could the content of `segment` be recovered by re-reading a file or re-running a command instead of " +
        "having to be remembered?",
      "Yes: it is file contents or command output that can be fetched again.",
      "No: it exists only in this conversation.",
    ),
    disposition: {
      type: "choice",
      instructions:
        "Given `goal`, what should happen to `segment` when older conversation is compacted into a handoff?",
      criteria: DISPOSITIONS,
    },
  };
}

function segmentState({ goal, segment, next }) {
  return {
    goal,
    segment: {
      role: segment.role,
      tool: segment.tool,
      path: segment.path,
      text: excerpt(segment.text, MAX_TEXT_CHARS),
    },
    next: next ? excerpt(next.text, 400) : "(none)",
  };
}

/** Score one segment: seven typed answers, nulls where the model gave nothing usable. */
export async function judgeSegment({ goal, segment, next, ask = askSystemOne, signal }) {
  const { answers } = await ask({
    state: segmentState({ goal, segment, next }),
    questions: buildSegmentQuestions(),
    signal,
  });
  const choice = answers?.disposition;
  return {
    load_bearing: yes(answers?.load_bearing),
    user_constraint: yes(answers?.user_constraint),
    decision: yes(answers?.decision),
    unresolved: yes(answers?.unresolved),
    dead_end: yes(answers?.dead_end),
    recoverable: yes(answers?.recoverable),
    disposition:
      choice?.type === "choice" && typeof choice.choice === "string" ? choice.choice : null,
    confidence: usable(choice?.confidence),
  };
}

/**
 * Probability that each candidate span satisfies `instruction`. One request:
 * the questions are independent over the same state, so they run in parallel.
 */
export async function rateCandidates({
  context,
  candidates,
  instruction,
  ask = askSystemOne,
  signal,
}) {
  const list = candidates.slice(0, MAX_CANDIDATES).map((c) => excerpt(c, MAX_CANDIDATE_CHARS));
  if (list.length === 0) return [];
  const questions = {};
  list.forEach((_, index) => {
    questions[`c${index}`] = {
      type: "noul",
      instructions: `${instruction} The candidate is \`candidates[${index}]\`.`,
    };
  });
  const { answers } = await ask({ state: { context, candidates: list }, questions, signal });
  return list.map((_, index) => yes(answers?.[`c${index}`]));
}

/** Indices of the best candidates at or above `threshold`, best first, at most `max`. */
export function topIndices(ratings, { threshold = 0.5, max = 3 } = {}) {
  return ratings
    .map((probability, index) => ({ probability, index }))
    .filter((entry) => entry.probability !== null && entry.probability >= threshold)
    .sort((a, b) => b.probability - a.probability || b.index - a.index)
    .slice(0, max)
    .map((entry) => entry.index);
}

/** The user message that best states the overall task; later wins a tie. */
export async function pickGoal({ userSegments, ask = askSystemOne, signal }) {
  const recent = userSegments.slice(-20);
  if (recent.length === 0) return "";
  const ratings = await rateCandidates({
    context: "A working session between a user and a coding agent.",
    candidates: recent.map((segment) => segment.text),
    instruction:
      "Does the candidate state the overall task or goal the user wants accomplished, rather than a minor " +
      "follow-up, an acknowledgement, or a clarification?",
    ask,
    signal,
  });
  const best = topIndices(ratings, { threshold: 0, max: 1 })[0];
  return excerpt(recent[best ?? recent.length - 1].text, 600);
}

/**
 * The moment check: is now a clean place to compact? Two routes to "yes": a unit
 * of work just finished, or the task switched and the next step needs little of
 * the earlier work (the best time to compact, since old history matters least).
 */
export async function judgeMoment({
  recentText,
  currentRequest = "",
  previousWork = "",
  ask = askSystemOne,
  signal,
}) {
  const compare = Boolean(currentRequest.trim() && previousWork.trim());
  const { answers } = await ask({
    state: {
      recent_activity: excerpt(recentText, 3000),
      ...(compare && {
        current_request: excerpt(currentRequest, 600),
        previous_work: excerpt(previousWork, 1500),
      }),
    },
    questions: {
      mid_flight: noul(
        "In `recent_activity`, is the agent partway through a multi-step change where the next step depends " +
          "on output or file contents it has just read?",
        "It is mid-change and would lose its place if the context were reduced now.",
        "Nothing in progress depends on fresh, unrecorded detail.",
      ),
      completed: noul(
        "In `recent_activity`, was a subtask or unit of work just finished and reported?",
        "A piece of work just completed.",
        "Work is still ongoing or nothing has concluded.",
      ),
      debugging: noul(
        "In `recent_activity`, is the agent actively diagnosing an error or failing test that is not yet fixed?",
        "An unresolved failure is being investigated.",
        "No active debugging.",
      ),
      ...(compare && {
        switched_gears: noul(
          "Is `current_request` a different task from `previous_work`?",
          "A new feature, a different file area, a different goal, or an unrelated question.",
          "The same task continuing, a follow-up, or a fix to what was just done.",
        ),
        needs_history: {
          type: "score",
          instructions: "How much of `previous_work` does the next step of `current_request` need?",
          criteria: [
            "None: the new work stands alone.",
            "Some: a file name, a decision, or a reference.",
            "Most of it: the work continues directly from it.",
          ],
        },
      }),
    },
    signal,
  });
  const midFlight = yes(answers?.mid_flight);
  const completed = yes(answers?.completed);
  const debugging = yes(answers?.debugging);
  const switched = yes(answers?.switched_gears);
  const needsHistory =
    answers?.needs_history?.type === "score" ? usable(answers.needs_history.score) : null;
  // Unknown counts against compacting: waiting one more turn is cheap.
  const settled = midFlight !== null && debugging !== null;
  const finished = (completed ?? 0) >= 0.5 || (settled && midFlight < 0.4 && debugging < 0.4);
  const switchedAway =
    compare &&
    (switched ?? 0) >= 0.7 &&
    needsHistory !== null &&
    needsHistory < 1 &&
    settled &&
    midFlight < 0.6 &&
    debugging < 0.4;
  const clean = settled && (finished || switchedAway);
  return { clean, midFlight, completed, debugging, switched, needsHistory };
}

/** Does each handoff entry faithfully reflect its source? Returns pass flags (null = unusable). */
export async function verifyEntries({ entries, ask = askSystemOne, signal }) {
  if (entries.length === 0) return [];
  const questions = {};
  entries.forEach((_, index) => {
    questions[`e${index}`] = {
      type: "noul",
      instructions:
        `Compare \`entries[${index}].entry\` with \`entries[${index}].source\`. Does the entry accurately ` +
        "reflect the source without contradicting it, overstating it, or dropping a qualifier that changes " +
        "its meaning?",
      criteria: {
        true: "Faithful: it says what the source says.",
        false: "Distorted, contradicted, or missing a qualifier that changes the meaning.",
      },
    };
  });
  const state = {
    entries: entries.map((e) => ({
      entry: excerpt(e.entry, MAX_TEXT_CHARS),
      source: excerpt(e.source, MAX_TEXT_CHARS),
    })),
  };
  const { answers } = await ask({ state, questions, signal });
  return entries.map((_, index) => yes(answers?.[`e${index}`]));
}

/** Is the key content of each important segment represented in the handoff? */
export async function verifyCoverage({ handoff, segments, ask = askSystemOne, signal }) {
  if (segments.length === 0) return [];
  const questions = {};
  segments.forEach((_, index) => {
    questions[`g${index}`] = {
      type: "noul",
      instructions:
        `Is the key information in \`segments[${index}]\` represented in \`handoff\`, either stated ` +
        "or as a pointer that would let the reader recover it?",
      criteria: {
        true: "The essential content is present or recoverable from the handoff.",
        false: "The handoff would leave the reader without something this segment established.",
      },
    };
  });
  const state = {
    handoff: excerpt(handoff, 12000),
    segments: segments.map((s) => excerpt(s.text, MAX_TEXT_CHARS)),
  };
  const { answers } = await ask({ state, questions, signal });
  return segments.map((_, index) => yes(answers?.[`g${index}`]));
}

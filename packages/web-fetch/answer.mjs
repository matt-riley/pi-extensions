// answer.mjs — turn a fetched page into the passages that answer a question.
//
// web_fetch returns the whole page, which is the right default and the wrong
// thing to read when the question is narrow. Code splits the page into
// passages; Jev rates each one against the question and says whether the page
// answers it at all; code returns the winners. The excerpts are the page's own
// text, never a summary, so a claim can be checked against what it cites.
//
// One request: every passage is in the state and gets its own Noul question.

import { askSystemOne, usableNumber } from "../../shared/systemone.mjs";

const DEFAULT_MAX_SPANS = 3;
const DEFAULT_MAX_PASSAGES = 12;
const PASSAGE_CHARS = 2000;
const MAX_PAGE_CHARS = 45_000;

/** A backticked reference to a state path, the way these prompts name their input. */
const q = (name) => "`" + name + "`";

/**
 * Passage-sized blocks of a page, capped so the state stays under Jev's limit.
 *
 * A page is cut at 45,000 characters and split on blank lines; long blocks are
 * hard-split rather than dropped, because a wall of text with no blank lines is
 * still where the answer is. Past the passage cap, neighbouring passages are
 * merged rather than discarded.
 */
export function splitPassages(
  text,
  { max = DEFAULT_MAX_PASSAGES, chars = PASSAGE_CHARS, maxChars = MAX_PAGE_CHARS } = {},
) {
  const body = String(text ?? "");
  const cut = body.slice(0, maxChars);
  const truncated = body.length > maxChars;
  const blocks = cut
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const pieces = [];
  for (const block of blocks) {
    if (block.length <= chars) {
      pieces.push(block);
      continue;
    }
    for (let start = 0; start < block.length; start += chars) {
      pieces.push(block.slice(start, start + chars));
    }
  }

  const packed = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > chars) {
      packed.push(current);
      current = piece;
    } else {
      current = current ? current + "\n\n" + piece : piece;
    }
  }
  if (current) packed.push(current);

  let passages = packed;
  if (passages.length > max) {
    const groupSize = Math.ceil(passages.length / max);
    passages = [];
    for (let start = 0; start < packed.length; start += groupSize) {
      passages.push(packed.slice(start, start + groupSize).join("\n\n"));
    }
  }
  return { passages, truncated };
}

/** One Noul per passage, plus whether the page answers the question at all. */
export function buildQuestions(count) {
  const questions = {
    answered: {
      type: "noul",
      instructions:
        "Read " +
        q("question") +
        " and " +
        q("passages") +
        ". Does the page contain a direct " +
        "answer to the question? A page that discusses the topic without answering the question " +
        "does not.",
      criteria: {
        true: "A passage states the answer, or the facts the answer follows from.",
        false: "The page is about the topic but does not answer the question asked.",
      },
    },
  };
  for (let index = 0; index < count; index += 1) {
    questions["passage_" + index] = {
      type: "noul",
      instructions:
        "Read " +
        q("question") +
        " and " +
        q("passages." + index + ".text") +
        ". Does this " +
        "passage contain text that answers the question, or states a fact the answer depends on? " +
        "Text that merely mentions the topic does not.",
      criteria: {
        true: "The passage answers the question, or carries a fact the answer needs.",
        false: "The passage is background, navigation, or about a different question.",
      },
    };
  }
  return questions;
}

/**
 * The best passages, with whether the page answers at all.
 *
 * A passage below the threshold is not returned: a page of navigation chrome can
 * score 0.55 on "hub" alone, and handing it back as an answer is worse than
 * saying the page does not answer it.
 */
export function routeAnswer(answers, passages, { maxSpans = DEFAULT_MAX_SPANS } = {}) {
  const answered = usableNumber(answers?.answered?.noul);
  const ranked = passages
    .map((text, index) => ({
      index,
      text,
      probability: usableNumber(answers?.["passage_" + index]?.noul),
    }))
    .filter((entry) => entry.probability !== null && entry.probability >= 0.5)
    .sort((left, right) => right.probability - left.probability || left.index - right.index);
  const spans = ranked.slice(0, maxSpans);
  const verdict =
    answered !== null && answered >= 0.5 ? "answered" : spans.length ? "closest" : "not_found";
  return { answered, spans, verdict };
}

export function formatAnswer({ url, question, answered, spans, verdict, truncated } = {}) {
  const confidence = typeof answered === "number" ? " (answered " + answered.toFixed(2) + ")" : "";
  const lines = ["source: " + (url ?? "unknown")];
  if (verdict === "not_found") {
    lines.push("The page does not appear to answer: " + question + confidence);
    lines.push("Try a different source rather than reading the whole page.");
    return lines.join("\n");
  }
  if (verdict === "closest") {
    lines.push("The page may not answer this directly" + confidence + "; closest passages:");
  }
  for (const span of spans ?? []) {
    lines.push("");
    lines.push("[passage " + (span.index + 1) + " · " + span.probability.toFixed(2) + "]");
    lines.push(span.text);
  }
  if (truncated) {
    lines.push("");
    lines.push("(page cut at " + MAX_PAGE_CHARS + " characters before it was split)");
  }
  return lines.join("\n");
}

/**
 * Ask which passages answer the question. Returns the routing rather than text,
 * so the tool decides how to report an empty page and the tests read fields.
 */
export async function answerFromPage({
  url,
  question,
  text,
  maxSpans = DEFAULT_MAX_SPANS,
  timeoutMs = 20_000,
  model,
  env,
  ask = askSystemOne,
  signal,
} = {}) {
  const { passages, truncated } = splitPassages(text);
  if (passages.length === 0) {
    return { answered: null, spans: [], verdict: "not_found", truncated };
  }
  const result = await ask({
    state: {
      url: url ?? null,
      question: String(question ?? ""),
      passages: passages.map((passage) => ({ text: passage })),
    },
    questions: buildQuestions(passages.length),
    model,
    env,
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  return {
    ...routeAnswer(result?.answers, passages, { maxSpans }),
    truncated,
    model: result?.model,
    usage: result?.usage ?? null,
  };
}

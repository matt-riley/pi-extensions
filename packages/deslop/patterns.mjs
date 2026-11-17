// patterns.mjs — the deterministic half of deslop: which machine-writing
// patterns a piece of prose carries. The checks themselves are in checks.mjs;
// this module masks what is not prose, runs them, and adds the signs that need
// counting across paragraphs (dashes, exclamations, emoji, punchy runs).
//
// Only the signs a regex can decide are here. The judgment calls in the source
// skills (passive voice as habit, repeated thematic points, personification) are
// left to the TypeSafe questions in verify.mjs, which read the whole text.
//
// Severity follows deslop-text: high signs are strong tells that stand alone,
// medium and low ones are weak and only count when other signs sit in the same
// paragraph. Thresholds are that skill's figures for internal documents, because
// this runs on docs an agent edits in a repository and not on customer-facing copy.

import { CHECKS } from "./checks.mjs";

/** Text past this is not scanned: a generated file is not prose worth judging. */
const MAX_SCAN_CHARS = 200_000;
const MAX_EXCERPTS = 2;
const MAX_EXCERPT_CHARS = 140;
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };
/** One high sign, or a medium and a low, or three lows, all in one paragraph. */
const REPORT_WEIGHT = 3;

const EMPHASIS_EMOJI = /[\u{1F680}\u{1F525}\u{2728}\u{1F4A1}\u{2B50}\u{1F31F}\u{2705}\u{1F449}]/gu;
const HEADING_EMOJI = /^#{1,6}[ \t]+\p{Extended_Pictographic}/gmu;
/** A dash aside: an em dash, or the double hyphen someone types in its place. */
const ASIDE_DASH = /—|(?<=\w) -- (?=\w)|(?<=\w)--(?=\w)/g;
/** A paragraph that is a list, a heading, a table or a quote is not running prose. */
const STRUCTURED_LINE = /^\s*(?:[-*+>#|]|\d+[.)])\s?/m;
const MACHINEGUN_MAX_WORDS = 6;
const MACHINEGUN_RUN = 3;

/**
 * Blank out what is not prose, keeping every offset: frontmatter, fenced and
 * inline code, HTML comments and URLs. A word inside a code span is an
 * identifier, and flagging `leverage()` would be a finding about an API.
 */
export function maskNonProse(text) {
  const blank = (match) => match.replace(/[^\n]/g, " ");
  return String(text ?? "")
    .slice(0, MAX_SCAN_CHARS)
    .replace(/^---\n[\s\S]*?\n---(?=\n|$)/, blank)
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[^\n]*$/gm, blank)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, blank)
    .replace(/^[ \t]*\|[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\bhttps?:\/\/[^\s)>\]]+/g, blank);
}

/** The sentence around an offset, trimmed to one readable line. */
function sentenceAround(text, start, end) {
  let from = start;
  while (from > 0 && !/[.!?\n]/.test(text[from - 1])) from--;
  let to = end;
  while (to < text.length && !/[.!?\n]/.test(text[to])) to++;
  const sentence = text
    .slice(from, Math.min(to + 1, text.length))
    .replace(/\s+/g, " ")
    .trim();
  return clipExcerpt(sentence);
}

/** Cut to MAX_EXCERPT_CHARS at a word boundary, marking the cut. */
function clipExcerpt(text) {
  return text.length > MAX_EXCERPT_CHARS
    ? `${text.slice(0, MAX_EXCERPT_CHARS - 1).replace(/\S+$/, "")}…`
    : text;
}

function finding(check, count, excerpts, passages = [0]) {
  return {
    id: check.id,
    sign: check.sign,
    severity: check.severity,
    label: check.label,
    fix: check.fix,
    count,
    excerpts: [...new Set(excerpts)].slice(0, MAX_EXCERPTS),
    passages: [...new Set(passages)].sort((left, right) => left - right),
  };
}

/** The non-blank paragraphs of a text, each with the offset it starts at. */
function paragraphsOf(text) {
  const spans = [];
  let start = 0;
  const push = (end) => {
    const body = text.slice(start, end);
    if (body.trim()) spans.push({ start, text: body });
  };
  for (const gap of text.matchAll(/\n[ \t]*\n/g)) {
    push(gap.index);
    start = gap.index + gap[0].length;
  }
  push(text.length);
  return spans;
}

/** Which paragraph an offset falls in: the last one that starts at or before it. */
function passageAt(spans, offset) {
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (spans[mid].start <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** W3: more than one dash aside in a paragraph, or more than three in the text. */
function emDashFinding(text, spans) {
  const total = text.match(ASIDE_DASH)?.length ?? 0;
  const dashed = spans.flatMap((paragraph, index) => {
    const marks = [...paragraph.text.matchAll(ASIDE_DASH)];
    return marks.length ? [{ paragraph, index, count: marks.length, at: marks[0].index }] : [];
  });
  const crowded = dashed.filter(({ count }) => count > 1);
  if (total <= 3 && crowded.length === 0) return null;
  const sample = crowded[0] ?? dashed[0];
  return finding(
    {
      id: "em-dash",
      sign: "W3",
      severity: "medium",
      label: "dash asides (em dash or double hyphen)",
      fix: "give the aside its own sentence, use a comma, or cut it",
    },
    total,
    [sentenceAround(sample.paragraph.text, sample.at, sample.at + 1)],
    dashed.map(({ index }) => index),
  );
}

/** W18: more than one exclamation mark in a paragraph, or more than three overall. */
function exclamationFinding(text, spans) {
  const total = text.match(/!/g)?.length ?? 0;
  const marked = spans.flatMap((paragraph, index) =>
    paragraph.text.includes("!") ? [{ paragraph, index }] : [],
  );
  const crowded = marked.find(({ paragraph }) => (paragraph.text.match(/!/g)?.length ?? 0) > 1);
  if (total <= 3 && !crowded) return null;
  const sample = (crowded ?? marked[0]).paragraph;
  const at = sample.text.indexOf("!");
  return finding(
    {
      id: "exclamation",
      sign: "W18",
      severity: "medium",
      label: "exclamation mark cluster",
      fix: "keep at most the one that matters",
    },
    total,
    [sentenceAround(sample.text, at, at + 1)],
    marked.map(({ index }) => index),
  );
}

/** W23 and W30: emoji carrying the emphasis, in a heading or in a cluster. */
function emojiFinding(text, spans) {
  const headings = text.match(HEADING_EMOJI) ?? [];
  const emphasis = text.match(EMPHASIS_EMOJI) ?? [];
  if (headings.length === 0 && emphasis.length < 2) return null;
  const passages = [...text.matchAll(HEADING_EMOJI), ...text.matchAll(EMPHASIS_EMOJI)].map(
    (match) => passageAt(spans, match.index),
  );
  return finding(
    {
      id: "emoji",
      sign: headings.length ? "W30" : "W23",
      severity: "medium",
      label: headings.length ? "emoji in a heading" : "emoji as emphasis",
      fix: "delete the emoji",
    },
    headings.length + emphasis.length,
    headings.length ? headings.map((heading) => heading.trim()) : [emphasis.slice(0, 4).join(" ")],
    passages,
  );
}

/** W34: three or more short declarative sentences in a row inside one paragraph. */
function machinegunFinding(spans) {
  for (const [index, { text: paragraph }] of spans.entries()) {
    if (STRUCTURED_LINE.test(paragraph)) continue;
    const sentences = paragraph
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean);
    let run = [];
    for (const sentence of [...sentences, ""]) {
      const words = sentence.split(/\s+/).filter((word) => /\w/.test(word)).length;
      if (
        words > 0 &&
        words <= MACHINEGUN_MAX_WORDS &&
        /[.!]$/.test(sentence) &&
        !/^Do not\b/i.test(sentence)
      ) {
        run.push(sentence);
        continue;
      }
      if (run.length >= MACHINEGUN_RUN) {
        const joined = run.join(" ");
        return finding(
          {
            id: "machinegun",
            sign: "W34",
            severity: "high",
            label: "run of short punchy sentences",
            fix: "combine them with commas or subordinate clauses",
          },
          run.length,
          [clipExcerpt(joined)],
          [index],
        );
      }
      run = [];
    }
  }
  return null;
}

/** Words that name one thing in turn: three of a kind as subjects is a renaming. */
const SUBJECT_SYNONYMS = [
  "tool utility solution platform framework",
  "library package module toolkit",
  "project repository codebase",
  "feature capability functionality",
  "extension plugin addon",
  "error failure problem issue",
].map((group) => new Set(group.split(" ")));
const SUBJECT_OPENER = /(?:^|[.!?]\s+)(?:the|this|that|our|your)\s+([a-z]+)\b/gi;
const RENAMED_MIN = 3;

/** A paragraph whose sentences open on three different names for one thing. */
function renamedSubjectFinding(spans) {
  for (const [index, { text: paragraph }] of spans.entries()) {
    const subjects = [...paragraph.matchAll(SUBJECT_OPENER)].map((match) => ({
      word: match[1].toLowerCase(),
      at: match.index,
    }));
    for (const group of SUBJECT_SYNONYMS) {
      const named = subjects.filter(({ word }) => group.has(word));
      if (new Set(named.map(({ word }) => word)).size < RENAMED_MIN) continue;
      return finding(
        {
          id: "renamed-subject",
          sign: "elegant variation",
          severity: "medium",
          label: "one subject renamed with a new synonym each time",
          fix: "pick one name and use it every time",
        },
        named.length,
        [sentenceAround(paragraph, named[0].at, named[0].at + 1)],
        [index],
      );
    }
  }
  return null;
}

/**
 * Every pattern the text carries, most severe first. `passages` lists the
 * paragraphs a sign appears in, which is what lets a weak sign count only
 * beside other signs in the same paragraph.
 *
 * @returns {{ id: string, sign: string, severity: "high"|"medium"|"low", label: string, fix: string, count: number, excerpts: string[], passages: number[] }[]}
 */
export function findSlop(text) {
  const prose = maskNonProse(text);
  if (!prose.trim()) return [];
  const spans = paragraphsOf(prose);
  const findings = [];
  for (const check of CHECKS) {
    const matches = [...prose.matchAll(check.pattern)];
    if (matches.length < (check.min ?? 1)) continue;
    findings.push(
      finding(
        check,
        matches.length,
        matches
          .slice(0, MAX_EXCERPTS * 2)
          .map((match) => sentenceAround(prose, match.index, match.index + match[0].length)),
        matches.map((match) => passageAt(spans, match.index)),
      ),
    );
  }
  for (const extra of [
    emDashFinding(prose, spans),
    exclamationFinding(prose, spans),
    emojiFinding(prose, spans),
    machinegunFinding(spans),
    renamedSubjectFinding(spans),
  ]) {
    if (extra) findings.push(extra);
  }
  return findings.sort(
    (left, right) => SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity],
  );
}

/**
 * The findings an edit introduced: what `after` carries that `before` did not
 * already carry at least as often. An edit that touches a sentence someone
 * else wrote must not be blamed for the patterns it left alone.
 */
export function addedFindings(after, before) {
  const prior = new Map(findSlop(before).map((item) => [item.id, item.count]));
  return findSlop(after).filter((item) => item.count > (prior.get(item.id) ?? 0));
}

/**
 * Whether findings are worth a line. A strong (high) sign is a report by
 * itself. Weak signs only matter beside each other, so their weight is summed
 * per paragraph: a medium and a low in one paragraph report, the same two
 * apart do not. A finding with no `passages` shares one passage with the rest.
 */
export function worthReporting(findings) {
  const weights = new Map();
  for (const item of findings ?? []) {
    const weight = SEVERITY_WEIGHT[item.severity] ?? 0;
    for (const passage of item.passages ?? [0]) {
      weights.set(passage, (weights.get(passage) ?? 0) + weight);
    }
  }
  return [...weights.values()].some((weight) => weight >= REPORT_WEIGHT);
}

/** One bullet per finding: what it is, where, and what the sentence should become. */
export function formatFindings(findings) {
  return (findings ?? [])
    .map((item) => {
      const where = item.excerpts.length
        ? `: ${item.excerpts.map((excerpt) => JSON.stringify(excerpt)).join(", ")}`
        : "";
      return `- ${item.label} (${item.sign}, ${item.severity})${where}. Fix: ${item.fix}.`;
    })
    .join("\n");
}

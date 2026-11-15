// patterns.mjs — the deterministic half of deslop: which machine-writing
// patterns a piece of prose carries.
//
// The catalogue is drawn from two skills, read in full rather than summarised:
//   - adamdunkels/deslop-text (its numbered warning signs, cited here as W1…W53)
//   - stephenturner/skills deslop (its core rules and phrase/structure catalogues,
//     cited here as "deslop rule N")
// Only the signs a regex can decide are here. The judgment calls in both skills
// (passive voice as habit, repeated thematic points, personification) are left
// to the TypeSafe questions in verify.mjs, which read the whole text.
//
// Severity follows deslop-text: high signs are strong tells that stand alone,
// medium and low ones are weak and only count when other signs sit in the same
// paragraph. Thresholds are that skill's figures for internal documents, because
// this runs on docs an agent edits in a repository and not on customer-facing copy.

/** Text past this is not scanned: a generated file is not prose worth judging. */
const MAX_SCAN_CHARS = 200_000;
const MAX_EXCERPTS = 2;
const MAX_EXCERPT_CHARS = 140;
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };
/** One high sign, or a medium and a low, or three lows, all in one paragraph. */
const REPORT_WEIGHT = 3;

/** Phrases to a global, case-insensitive regex: any apostrophe, any whitespace. */
function phrases(list) {
  const body = list
    .map((phrase) =>
      phrase
        .replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
        .replace(/'/g, "['’]")
        .replace(/ /g, String.raw`\s+`),
    )
    .join("|");
  return new RegExp(String.raw`(?<![\w-])(?:${body})(?![\w-])`, "gi");
}

/**
 * "stale-branch checks" and "merge-order gate": a made-up modifier stuck to a
 * generic noun. A regex cannot tell invented from ordinary, so the shape is narrow
 * (hyphenated pair, then one of these head nouns), well-known compounds are
 * excluded, and the check needs two hits.
 */
const LABEL_HEADS =
  "checks?|layouts?|gates?|passes|pass|flows?|lanes?|rails?|handoffs?|surfaces?|contracts?|posture|stance|story|moves?";
const COMMON_COMPOUNDS =
  "read-only|write-only|built-in|open-source|real-time|long-running|short-lived|high-level|low-level|top-level|first-class|full-text|command-line|case-sensitive|one-shot|fail-safe|dead-code|type-safe|run-time|build-time|two-step|single-line|error-prone";
const COMPOUND_PREFIXES =
  "non|multi|pre|post|re|co|anti|sub|semi|cross|inter|over|under|out|self|auto|pro";

/**
 * A foil that names a data type or an interface word makes "X, not Y" a plain
 * correction ("the default is a number, not a string"), not a rhetorical contrast.
 */
const DATA_TERMS =
  "string|number|boolean|integer|float|array|object|list|map|file|directory|folder|path|url|id|name|flag|option|key|value|command|function|byte|char|character|int|bool";

const CHECKS = [
  {
    id: "filler",
    sign: "W1",
    severity: "high",
    label: "filler phrase",
    fix: "delete it, or rewrite the sentence without it",
    pattern: phrases([
      "it's worth noting",
      "it is worth noting",
      "it bears mentioning",
      "it goes without saying",
      "at the end of the day",
      "moving forward",
      "when all is said and done",
      "at its core",
      "when it comes to",
      "in a world where",
      "the reality is",
      "delve",
      "delves",
      "delved",
      "delving",
      "leverage",
      "leverages",
      "leveraged",
      "leveraging",
      "utilize",
      "utilizes",
      "utilized",
      "utilizing",
      "tapestry",
      "holistic",
      "cutting-edge",
    ]),
  },
  {
    id: "contrast",
    sign: "W2",
    severity: "high",
    label: '"not X, it is Y" or "not X but Y" contrast',
    fix: "state Y directly and cut the negation",
    pattern: new RegExp(
      [
        String.raw`(?:\bnot|n['’]t)\s+(?:about|just|only|merely|simply)\b[^.!?\n]{0,80}[.,;]\s+(?:it|this|that|they)(?:['’]s|['’]re|\s+is|\s+are)\b`,
        String.raw`\bnot\s+(?:only|just)\b[^.!?\n]{0,80}\bbut\s+also\b`,
        String.raw`\bless\s+about\b[^.!?\n]{0,60}\bmore\s+about\b`,
        String.raw`\bnot\s+because\b[^.!?\n]{0,80}[.,]\s*(?:but\s+)?because\b`,
        String.raw`\b(?:(?:is|are|was|were)\s+not|(?:is|are|was|were)n['’]t)\s+(?:an?|the)\b[^.!?\n]{0,60}?\bbut\s+(?:rather\s+)?(?:an?|the)\b`,
      ].join("|"),
      "gi",
    ),
  },
  {
    id: "marketing",
    sign: "W5",
    severity: "high",
    label: "marketing adjective",
    fix: "replace it with the specific, factual description",
    pattern: phrases([
      "powerful",
      "seamless",
      "seamlessly",
      "revolutionary",
      "game-changing",
      "best-in-class",
      "world-class",
      "next-generation",
      "groundbreaking",
      "transformative",
    ]),
  },
  {
    id: "generic-opening",
    sign: "W6",
    severity: "high",
    label: "generic opening",
    fix: "open with what happened or what you found",
    pattern: new RegExp(
      [
        String.raw`\bin\s+today['’]s\s+(?:[\w-]+\s+){0,3}(?:world|landscape|age|era|environment)\b`,
        String.raw`\bas\s+we\s+all\s+know\b`,
        String.raw`\bhave\s+you\s+ever\s+wondered\b`,
        String.raw`\bimagine\s+a\s+world\b`,
      ].join("|"),
      "gi",
    ),
  },
  {
    id: "paired-adjectives",
    sign: "W9",
    severity: "high",
    label: "paired adjectives",
    fix: "pick the stronger adjective and drop the pairing",
    pattern:
      /\b(?:simple|elegant|lightweight|small|minimal|fast|flexible|powerful)\s+(?:yet|but)\s+(?:powerful|robust|comprehensive|flexible|capable|elegant|simple)\b/gi,
  },
  {
    id: "announce",
    sign: "W15",
    severity: "high",
    label: '"excited to announce" opener',
    fix: "state what happened",
    pattern:
      /\b(?:we(?:['’]re|\s+are)|i(?:['’]m|\s+am))\s+(?:excited|thrilled|proud|delighted|pleased)\s+to\s+(?:announce|share|present|introduce)\b/gi,
  },
  {
    id: "whether-youre",
    sign: "W16",
    severity: "high",
    label: '"whether you\'re X or Y" inclusivity',
    fix: "address the people who need this information",
    pattern: /\bwhether\s+you(?:['’]re|\s+are)\b[^.!?\n]{0,80}\bor\b/gi,
  },
  {
    id: "pivot",
    sign: "W17",
    severity: "high",
    label: "throat-clearing pivot",
    fix: "delete the pivot and start with the substance",
    pattern: phrases([
      "here's the thing",
      "here's the kicker",
      "here's the deal",
      "here's why",
      "here's what",
      "here's where it gets interesting",
      "let me be clear",
      "the truth is",
      "the uncomfortable truth is",
      "make no mistake",
      "let that sink in",
      "let's break this down",
      "let's unpack",
      "let's dive in",
      "let's delve into",
      "think of it as",
      "think of it like",
    ]),
  },
  {
    id: "cliche",
    sign: "W21",
    severity: "high",
    label: "corporate or internet cliche",
    fix: "say the concrete thing in plain language",
    pattern: phrases([
      "think outside the box",
      "move the needle",
      "moves the needle",
      "paradigm shift",
      "synergy",
      "thought leader",
      "game changer",
      "game-changer",
      "mission-critical",
      "take it to the next level",
      "low-hanging fruit",
      "boil the ocean",
      "circle back",
      "touch base",
      "double down",
      "lean into",
      "hits different",
      "chef's kiss",
      "rent-free",
      "this is the way",
    ]),
  },
  {
    id: "serves-as",
    sign: "deslop rule 3",
    severity: "medium",
    label: '"serves as" in place of "is"',
    fix: 'use "is"',
    pattern: phrases(["serves as", "serve as", "stands as", "stand as"]),
  },
  {
    id: "hedging",
    sign: "W8",
    severity: "medium",
    label: "stacked hedging",
    fix: "say what the evidence supports; remove the extra qualifiers",
    min: 3,
    pattern: phrases([
      "it seems like",
      "it appears that",
      "it could be argued",
      "one might say",
      "it is possible that",
      "arguably",
      "perhaps",
      "in some ways",
    ]),
  },
  {
    id: "meta",
    sign: "W10",
    severity: "medium",
    label: "text narrating its own structure",
    fix: "delete it; the structure already shows",
    pattern: new RegExp(
      [
        String.raw`\bin\s+this\s+(?:post|article|section|guide|document)\b`,
        String.raw`\bas\s+(?:we\s+)?(?:discussed|mentioned|noted)\s+(?:above|earlier|previously)\b`,
        String.raw`\blet['’]s\s+explore\b`,
        String.raw`\bbelow,?\s+we(?:['’]ll|\s+will)\b`,
        String.raw`\blet\s+me\s+walk\s+you\s+through\b`,
        String.raw`\bas\s+we(?:['’]ll|\s+will)\s+see\b`,
      ].join("|"),
      "gi",
    ),
  },
  {
    id: "transition",
    sign: "W11",
    severity: "medium",
    label: "mechanical transition",
    fix: "start the sentence without it",
    pattern:
      /(?:^|[.!?]\s+|\n[ \t]*)(?:Furthermore|Moreover|Additionally|In conclusion|To sum up|In summary|That said|With that in mind|Having established that|Despite these challenges)\b,?/g,
  },
  {
    id: "self-question",
    sign: "W4",
    severity: "medium",
    label: "self-posed rhetorical question",
    fix: "fold the question and its answer into one statement",
    pattern:
      /\b(?:The|And the|But the)\s+(?:result|catch|worst part|best part|problem|answer|kicker|upshot|takeaway)\?/g,
  },
  {
    id: "authenticity",
    sign: "W38",
    severity: "medium",
    label: "sincerity intensifiers",
    fix: "delete the intensifier",
    min: 3,
    pattern: phrases(["honestly", "genuinely", "truly", "actually", "really", "literally"]),
  },
  {
    id: "quietly",
    sign: "W45",
    severity: "low",
    label: 'hollow "quietly"',
    fix: "cut the word, or state the concrete change",
    pattern: phrases(["quietly"]),
  },
  {
    id: "x-not-y",
    sign: "contrastive framing",
    severity: "medium",
    label: '"X, not Y" contrast',
    fix: "state what it is and drop the alternative nobody asked about",
    min: 2,
    pattern: new RegExp(
      String.raw`\b(?:is|are|was|were|it['’]s|that['’]s|this['’]s)\s+(?:an?|the)\s+[\w-]+(?:\s+[\w-]+){0,3}\s*(?:[,—–]|--)\s*(?:and\s+)?not\s+(?:an?|the)\s+(?!(?:${DATA_TERMS})\b)[\w-]+`,
      "gi",
    ),
  },
  {
    id: "closer",
    sign: "one-line closer",
    severity: "high",
    label: "one-line closer",
    fix: "end on the last fact and cut the sign-off",
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+)(?:` +
        [
          String.raw`(?:and\s+)?that(?:['’]s|\s+is)\s+(?:it|all|okay|fine)`,
          String.raw`(?:and\s+)?that(?:['’]s|\s+is)\s+the\s+(?:whole\s+)?(?:point|story|idea)`,
          String.raw`simple\s+as\s+that`,
          String.raw`plain\s+and\s+simple`,
          String.raw`no\s+(?:magic|surprises)`,
          String.raw`nothing\s+(?:more|else)`,
          String.raw`end\s+of\s+story`,
          String.raw`full\s+stop`,
          String.raw`period`,
        ].join("|") +
        String.raw`)[.!]?[ \t]*$`,
      "gim",
    ),
  },
  {
    id: "coined-label",
    sign: "invented compound label",
    severity: "low",
    label: "invented hyphenated label",
    fix: "name the thing with an ordinary noun phrase, or describe what it does",
    min: 2,
    pattern: new RegExp(
      String.raw`(?<![\w-])(?!(?:${COMMON_COMPOUNDS})\s)(?!(?:${COMPOUND_PREFIXES})-)[a-z]{3,}-[a-z]{3,}\s+(?:${LABEL_HEADS})(?![\w-])`,
      "gi",
    ),
  },
  {
    id: "very",
    sign: "W20",
    severity: "low",
    label: '"very"',
    fix: 'delete "very" or give the measurement',
    min: 2,
    pattern: phrases(["very"]),
  },
  {
    id: "curly-quotes",
    sign: "W27",
    severity: "low",
    label: "curly quotes",
    fix: "use straight quotes",
    min: 4,
    pattern: /[‘’“”]/g,
  },
  {
    id: "arrows",
    sign: "deslop rule 9",
    severity: "low",
    label: "unicode arrow",
    fix: 'write "->" or a plain word',
    min: 2,
    pattern: /[→⇒⟶]/g,
  },
];

const EMPHASIS_EMOJI = /[\u{1F680}\u{1F525}\u{2728}\u{1F4A1}\u{2B50}\u{1F31F}\u{2705}\u{1F449}]/gu;
const HEADING_EMOJI = /^#{1,6}[ \t]+\p{Extended_Pictographic}/gmu;
const EM_DASH = /—/g;
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
  return sentence.length > MAX_EXCERPT_CHARS
    ? `${sentence.slice(0, MAX_EXCERPT_CHARS - 1).replace(/\S+$/, "")}…`
    : sentence;
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

/** W3: more than one em dash in a paragraph, or more than three in the text. */
function emDashFinding(text, spans) {
  const total = text.match(EM_DASH)?.length ?? 0;
  const dashed = spans.flatMap((paragraph, index) =>
    paragraph.text.includes("—") ? [{ paragraph, index }] : [],
  );
  const crowded = dashed.filter(
    ({ paragraph }) => (paragraph.text.match(EM_DASH)?.length ?? 0) > 1,
  );
  if (total <= 3 && crowded.length === 0) return null;
  const sample = (crowded[0] ?? dashed[0]).paragraph;
  const at = sample.text.indexOf("—");
  return finding(
    {
      id: "em-dash",
      sign: "W3",
      severity: "medium",
      label: "em dash asides",
      fix: "give the aside its own sentence, use a comma, or cut it",
    },
    total,
    [sentenceAround(sample.text, at, at + 1)],
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
          [
            joined.length > MAX_EXCERPT_CHARS
              ? `${joined.slice(0, MAX_EXCERPT_CHARS - 1).replace(/\S+$/, "")}…`
              : joined,
          ],
          [index],
        );
      }
      run = [];
    }
  }
  return null;
}

const SEVERITY_ORDER = ["high", "medium", "low"];

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
  ]) {
    if (extra) findings.push(extra);
  }
  return findings.sort(
    (left, right) => SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity),
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

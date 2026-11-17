// checks.mjs — deslop's catalogue: one entry per machine-writing sign a regex
// can decide, with its severity, label and fix. patterns.mjs runs them.
//
// The catalogue is drawn from two skills, read in full rather than summarised:
//   - adamdunkels/deslop-text (its numbered warning signs, cited here as W1…W53)
//   - stephenturner/skills deslop (its core rules and phrase/structure catalogues,
//     cited here as "deslop rule N")
// Further signs were added from the pattern categories in petergyang/no-ai-slop
// (MIT). That source was used for ideas only: none of its wording, examples or
// code is copied here.

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

/** Several sources, phrase lists or hand-written regexes, as one global, case-insensitive regex. */
function anyOf(...sources) {
  return new RegExp(
    sources.map((source) => (source instanceof RegExp ? source.source : source)).join("|"),
    "gi",
  );
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

const STOCK_QUALITIES =
  "fast|simple|reliable|secure|scalable|flexible|robust|clean|small|lightweight|powerful|easy|safe|predictable|maintainable|portable|readable|consistent|efficient|composable|extensible";

export const CHECKS = [
  {
    id: "filler",
    sign: "W1",
    severity: "high",
    label: "filler phrase",
    fix: "delete it, or rewrite the sentence without it",
    pattern: anyOf(
      phrases([
        "it's worth noting",
        "it is worth noting",
        "it's important to note",
        "it is important to note",
        "it's important to remember",
        "it is important to remember",
        "it's important to understand",
        "it is important to understand",
        "it's crucial to note",
        "it is crucial to note",
        "a myriad of",
        "a plethora of",
        "ever-evolving",
        "in the realm of",
        "navigate the complexities",
        "navigating the complexities",
        "embark on a journey",
        "embarking on a journey",
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
      String.raw`\bplay(?:s|ed|ing)?\s+an?\s+(?:crucial|vital|pivotal|key|critical|significant|central|important|integral)\s+role\b`,
    ),
  },
  {
    id: "contrast",
    sign: "W2",
    severity: "high",
    label: '"not X, it is Y" or "not X but Y" contrast',
    fix: "state Y directly and cut the negation",
    pattern: new RegExp(
      [
        String.raw`(?:\bnot|n['’]t)\s+(?:about|just|only|merely|simply)\b[^.!?\n]{0,80}?(?:[.,;:]\s+|\s*(?:[—–]|--)\s*)(?:it|this|that|they)(?:['’]s|['’]re|\s+is|\s+are)\b`,
        String.raw`\bnot\s+(?:only|just)\b[^.!?\n]{0,80}\bbut\s+also\b`,
        String.raw`\bnot\s+only\s+(?:does|do|did|is|are|was|can|will)\b[^.!?\n]{0,80}?[,;]\s+[^.!?\n]{0,40}?\balso\b`,
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
      "state-of-the-art",
      "unparalleled",
      "unleash",
      "unleashes",
      "supercharge",
      "supercharges",
      "effortless",
      "effortlessly",
      "unlock the full potential",
      "unlock the power",
      "unlocks the power",
      "harness the power",
      "harnesses the power",
      "elevate your workflow",
      "elevate your experience",
      "elevate your productivity",
      "elevate your game",
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
        String.raw`\bin\s+(?:the|an|today['’]s)\s+(?:ever-(?:evolving|changing)|rapidly\s+(?:evolving|changing)|fast-paced)\s+(?:[\w-]+\s+){0,3}?(?:world|landscape|realm|field|space)\b`,
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
    pattern: anyOf(
      phrases([
        "let's dive into",
        "let's dive deeper",
        "let's dive deep",
        "dive deep into",
        "a deep dive into",
        "let's take a closer look",
        "let's take a look",
        "let me explain",
        "without further ado",
        "buckle up",
        "here's the thing",
        "here's the kicker",
        "here's the deal",
        "here's why",
        "here's what",
        "here's where it gets interesting",
        "let me be clear",
        "let me be frank",
        "to be frank",
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
      String.raw`\bthis\s+is\s+where\s+(?:[\w-]+\s+){1,4}?comes?\s+in\b`,
    ),
  },
  {
    id: "cliche",
    sign: "W21",
    severity: "high",
    label: "corporate or internet cliche",
    fix: "say the concrete thing in plain language",
    pattern: anyOf(
      phrases([
        "win-win",
        "best of both worlds",
        "the possibilities are endless",
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
      String.raw`\btake\s+(?:your|their|our)\s+(?:[\w-]+\s+){1,2}?to\s+the\s+next\s+level\b`,
    ),
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
        String.raw`\bby\s+the\s+end\s+of\s+this\s+(?:post|article|section|guide|tutorial|document)\b`,
        String.raw`\bthis\s+(?:comprehensive\s+)?(?:post|article|guide|tutorial|document)\s+will\s+(?:walk|take|guide)\s+you\b`,
        String.raw`\beverything\s+you\s+need\s+to\s+know\b`,
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
      /(?:^|[.!?]\s+|\n[ \t]*)(?:Furthermore|Moreover|Additionally|In conclusion|To sum up|In summary|That said|With that in mind|Having established that|Despite these challenges|Ultimately|Notably|Importantly|Crucially|Interestingly|In essence|Essentially)\b,?/g,
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
        String.raw`)[.!][ \t]*$`,
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
    id: "paren-aside",
    sign: "dash aside swapped for parentheses",
    severity: "high",
    label: "parenthetical asides repeated across the text",
    fix: "give the aside its own sentence or fold it into the clause",
    min: 3,
    pattern:
      /(?<=[a-z]) \((?!(?:e\.g|i\.e|see|for|or|and|etc|cf|via|vs)\b)[a-z][a-z'’-]*(?: [a-z'’-]+){1,7}\)(?= [a-z])/g,
  },
  {
    id: "triplet",
    sign: "forced group of three",
    severity: "low",
    label: "forced group of three",
    fix: "keep the items that carry information and drop the rest",
    pattern: new RegExp(
      [
        String.raw`\b(?:${STOCK_QUALITIES}),\s+(?:${STOCK_QUALITIES}),?\s+(?:and|or)\s+(?:${STOCK_QUALITIES})\b`,
        String.raw`\b(?:no|zero)\s+[\w-]+,\s+(?:no|zero)\s+[\w-]+,?\s+(?:and\s+)?(?:no|zero)\s+[\w-]+`,
      ].join("|"),
      "gi",
    ),
  },
  {
    id: "generic-docs",
    sign: "generic documentation sentence",
    severity: "low",
    label: "sentence that fits any project's docs",
    fix: "say what this project does, with its own names and numbers",
    pattern: new RegExp(
      [
        phrases([
          "feel free to",
          "contributions are welcome",
          "pull requests are welcome",
          "a wide range of",
          "makes it easy to",
          "make it easy to",
          "easy to use",
          "get up and running",
          "follows best practices",
          "of all skill levels",
          "of all experience levels",
          "aims to provide",
        ]).source,
        String.raw`\b(?:designed|built|crafted)\s+with\s+[\w-]+(?:\s+[\w-]+){0,2}\s+in\s+mind\b`,
      ].join("|"),
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
  {
    id: "faux-insight",
    sign: "faux-insight setup",
    severity: "high",
    label: "faux-insight setup",
    fix: "drop the setup and state the claim",
    pattern: phrases([
      "what nobody tells you",
      "what nobody told you",
      "what they don't tell you",
      "what they do not tell you",
      "what no one tells you",
      "what everyone misses",
      "what most people miss",
    ]),
  },
  {
    id: "colon-reveal",
    sign: "colon reveal",
    severity: "medium",
    label: "colon reveal",
    fix: "write it as a plain sentence; keep colons for labels and lists",
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+)(?:(?:The|Here(?:['’]s|\s+is) the)\s+(?:` +
        [
          String.raw`(?:best|worst|only|real|key|funny)\s+part`,
          String.raw`(?:kicker|catch|trick|secret|upshot|takeaway|twist|verdict)`,
          String.raw`short\s+(?:answer|version)`,
        ].join("|") +
        String.raw`)|Spoiler(?:\s+alert)?|Bottom\s+line|Plot\s+twist|Short\s+answer|Long\s+story\s+short):\s+[a-z]`,
      "gm",
    ),
  },
  {
    id: "superficial-ing",
    sign: "superficial -ing analysis",
    severity: "medium",
    label: "superficial -ing analysis",
    fix: "say what actually changed and drop the -ing clause",
    pattern:
      /\b(?:highlighting|underscoring|showcasing|reflecting|demonstrating|emphasizing|emphasising)\s+(?:the\s+\w+(?:['’]s)?\s+|their\s+|its\s+|a\s+)?(?:commitment|dedication|passion|focus|determination)\s+to\b/gi,
  },
  {
    id: "importance-puffery",
    sign: "importance puffery",
    severity: "medium",
    label: "importance puffery",
    fix: "state the fact and let the reader judge whether it matters",
    pattern: phrases([
      "a testament to",
      "pivotal moment",
      "watershed moment",
      "cements its place",
      "a defining moment",
      "cannot be overstated",
      "marks a new era",
      "underscores the importance",
      "highlights the importance",
      "it's no secret that",
      "it is no secret that",
      "stands the test of time",
    ]),
  },
  {
    id: "weasel",
    sign: "weasel attribution",
    severity: "medium",
    label: "weasel attribution",
    fix: "name the source, or cut the claim",
    pattern: phrases([
      "experts agree",
      "studies show",
      "research suggests",
      "scientists say",
      "critics say",
      "observers note",
    ]),
  },
  {
    id: "dramatic-fragment",
    sign: "dramatic fragment",
    severity: "high",
    label: "dramatic fragment",
    fix: "use one complete sentence",
    pattern:
      /(?:^|[.!?]\s+)that(?:['’]s|\s+is)\s+it[.!]\s+that(?:['’]s|\s+is)\s+the\s+whole\s+(?:thing|point|story|idea)[.!]/gi,
  },
  {
    id: "rhetorical-setup",
    sign: "rhetorical setup",
    severity: "high",
    label: "rhetorical setup",
    fix: "drop the setup and state the point",
    pattern: new RegExp(
      [String.raw`\bpicture\s+this:`, String.raw`\bask\s+yourself:`].join("|"),
      "gi",
    ),
  },
  {
    id: "metadiscourse",
    sign: "interpretive metadiscourse",
    severity: "medium",
    label: "interpretive metadiscourse",
    fix: "delete the aside; the point should already be in the sentence",
    pattern: phrases(["put simply", "simply put", "to put it another way"]),
  },
  {
    id: "negative-listing",
    sign: "negative listing",
    severity: "medium",
    label: "negative listing",
    fix: "state what it is and drop the list of things it is not",
    pattern: /(?:^|[.!?]\s+)[Nn]ot\s+an?\s+[\w-]+[.!]\s+[Nn]ot\s+an?\s+[\w-]+[.!]/g,
  },
  {
    id: "chat-residue",
    sign: "chat reply in a document",
    severity: "high",
    label: "chat reply left in the document",
    fix: "delete it; a document does not answer or sign off to its reader",
    pattern: anyOf(
      phrases([
        "i hope this helps",
        "hope this helps",
        "great question",
        "i'd be happy to help",
        "i would be happy to help",
        "i'm happy to help",
        "as an ai language model",
        "as a large language model",
        "let me know if you have any questions",
        "let me know if you need anything else",
        "happy coding",
        "stay tuned",
      ]),
      String.raw`(?:^|[.!?]\s+)(?:Certainly|Absolutely|Of\s+course|Sure\s+thing)!`,
    ),
  },
  {
    id: "puffed-verb",
    sign: "puffed-up verb",
    severity: "medium",
    label: "puffed-up verb",
    fix: "use the plain verb for what happens, such as makes, helps or has",
    pattern: phrases([
      "empower",
      "empowers",
      "empowering",
      "streamline",
      "streamlines",
      "streamlining",
      "foster",
      "fosters",
      "fostering",
      "boast",
      "boasts",
      "revolutionize",
      "revolutionizes",
      "revolutionise",
      "revolutionises",
    ]),
  },
  {
    id: "wordy",
    sign: "wordy phrase",
    severity: "low",
    label: "wordy phrase",
    fix: 'use the short form, such as "to", "because", "now" or "if"',
    pattern: phrases([
      "in order to",
      "due to the fact that",
      "owing to the fact that",
      "at this point in time",
      "for the purpose of",
      "in the event that",
      "has the ability to",
      "have the ability to",
    ]),
  },
];

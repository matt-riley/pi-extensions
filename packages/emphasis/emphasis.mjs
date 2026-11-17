// emphasis.mjs — display-only emphasis for assistant replies in pi's terminal.
//
//   [[Blocked]]      a rounded status pill colored by its word, with that word's icon
//   ## Finding       a heading or leading bold label takes an icon from its word
//   **anchor term**  bold keeps its weight and takes a theme color
//   ✓ ✗ → ├──        success, error, accent and dim colors
//
// Adapted from pi-emphasis by John Lindquist (MIT, github.com/johnlindquist/pi-emphasis).
// The changes: options are passed in rather than read from the environment, the
// escape handling avoids control-character regexes, and the vocabulary carries the
// evidence words this collection's AGENTS.md asks for (attempted, unknown, and where
// a check ran).
//
// Plain .mjs so node --test covers it; index.ts only wires it to pi.

const ESC = "\u001b";
const sgr = (code) => `${ESC}[${code}m`;

/**
 * Each tone's words. `core` are the words the agent is told to write; `also` are
 * accepted and colored the same. Lowercase or not, matching ignores case.
 */
export const VOCABULARY = {
  error: {
    core: ["Failed", "Blocked", "Broken", "Unsafe"],
    also: ["fail", "failing", "error", "rejected", "down"],
  },
  warning: {
    core: [
      "Needs you",
      "Decision",
      "Unverified",
      "Attempted",
      "Partial",
      "Skipped",
      "In progress",
      "Pending",
      "At risk",
    ],
    also: ["needs review", "waiting", "review", "todo", "stale", "draft", "unknown"],
  },
  success: {
    core: ["Done", "Passed", "Observed", "Fixed", "Live", "Recommended", "Keep"],
    also: [
      "pass",
      "ready",
      "merged",
      "safe",
      "verified",
      "shipped",
      "ok",
      "approved",
      "complete",
      "completed",
      "finished",
      "healthy",
    ],
  },
  danger: { core: ["Costs money", "Destructive", "Irreversible"], also: [] },
  mode: { core: ["Brainstorm", "Investigate", "Preview", "Implement", "Qualify"], also: [] },
  owner: { core: ["Owned", "Shared", "Foreign"], also: [] },
};

/** Soft blue like any unknown label, but with an icon and a place in the guidance. */
export const CONTEXT_WORDS = ["Inferred", "New", "Changed", "Optional"];

/** Tones in the order a word is matched; a word sits in exactly one, so order only documents intent. */
const TONES = ["danger", "error", "warning", "success", "mode", "owner"];

const TONE_WORDS = Object.fromEntries(
  TONES.map((tone) => [
    tone,
    [...VOCABULARY[tone].core, ...VOCABULARY[tone].also].map((w) => w.toLowerCase()),
  ]),
);

// Font Awesome glyphs from the Nerd Font set: one cell wide in every terminal.
const CHECK = "";
const CROSS = "";
const CLOCK = "";
const QUESTION = "";

/** The icon each known pill word carries. Words without an entry stay text-only. */
const PILL_ICONS = {
  done: CHECK,
  passed: CHECK,
  pass: CHECK,
  complete: CHECK,
  completed: CHECK,
  ok: CHECK,
  verified: CHECK,
  ready: CHECK,
  observed: "",
  recommended: "",
  fixed: "",
  live: "",
  shipped: "",
  approved: "",
  merged: "",
  healthy: "",
  keep: "",
  safe: "",
  failed: CROSS,
  fail: CROSS,
  failing: CROSS,
  error: CROSS,
  rejected: CROSS,
  blocked: "",
  broken: "",
  unsafe: "",
  down: "",
  "needs you": "",
  decision: "",
  unverified: QUESTION,
  unknown: QUESTION,
  attempted: "",
  "at risk": "",
  "in progress": "",
  pending: CLOCK,
  waiting: CLOCK,
  partial: "",
  skipped: "",
  review: "",
  stale: "",
  draft: "",
  todo: "",
  inferred: "",
  new: "",
  changed: "",
  optional: "",
  "costs money": "",
  destructive: "",
  irreversible: "",
  brainstorm: "",
  investigate: "",
  preview: "",
  implement: "",
  qualify: "",
  owned: "",
  shared: "",
  foreign: "",
};

/** Words displayed as one canonical word, so the same state always reads the same. */
const SYNONYMS = {
  complete: "Done",
  completed: "Done",
  ok: "Done",
  finished: "Done",
  pass: "Passed",
  fail: "Failed",
  failing: "Failed",
  error: "Failed",
  waiting: "Pending",
  "needs review": "Review",
  unknown: "Unverified",
};

/** The icon a heading or a line's leading bold label takes from its word. */
const LABEL_ICONS = {
  finding: "",
  result: "",
  status: "",
  evidence: "",
  cause: "",
  effect: "",
  fix: "",
  risk: "",
  limits: "",
  cost: "",
  decision: "",
  options: "",
  plan: "",
  next: "",
  why: "",
  how: "",
  rule: "",
  example: "",
  checked: CHECK,
  verdict: "",
  rollback: "",
  undo: "",
  review: "",
  scoreboard: "",
  terminal: "",
  folder: "",
  file: "",
  branch: "",
  ideas: "",
};

/** Lead-in words that name the action a pill calls for. With a colon they take an icon anywhere. */
const ACTION_ICONS = {
  check: "",
  do: "",
  next: "",
  unblock: "",
  left: "",
  run: "",
  guard: "",
  undo: "",
  see: "",
};
const ACTION_LABEL = new RegExp(`(\\*\\*)(${Object.keys(ACTION_ICONS).join("|")})(:\\*\\*)`, "gi");

// A label may open with its own Private Use Area glyph, which wins over the table's icon.
const OWN_ICON = /^\s*([-]|[\u{f0000}-\u{ffffd}])\s*/u;

/** Every known word, longest first so "needs review" wins over "needs". */
const KNOWN = [
  ...new Set([
    ...Object.values(TONE_WORDS).flat(),
    ...Object.keys(PILL_ICONS),
    ...Object.keys(SYNONYMS),
  ]),
].sort((a, b) => b.length - a.length);

/** A pill label read as icon, display word and lookup key; a known word may carry detail. */
function splitLabel(label) {
  const own = label.match(OWN_ICON);
  const text = (own ? label.slice(own[0].length) : label).replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const known = KNOWN.find(
    (k) => lower === k || (lower.startsWith(k) && /[ :]/.test(lower[k.length])),
  );
  const canonical = known ? SYNONYMS[known] : undefined;
  const key = (canonical ?? known ?? lower).toLowerCase();
  const word = canonical ? canonical + text.slice(known.length) : text;
  return { icon: own?.[1] ?? PILL_ICONS[key], word, key };
}

/** The color group a pill label belongs to; any unknown word is neutral. */
export function toneOf(label) {
  const { key } = splitLabel(label);
  return TONES.find((tone) => TONE_WORDS[tone].includes(key)) ?? "neutral";
}

/** A background escape rewritten as the same color in the foreground, for the pill's end caps. */
function bgToFg(bg) {
  let out = bg.replaceAll(`${ESC}[48;`, `${ESC}[38;`);
  for (let n = 0; n <= 7; n++) {
    out = out.replaceAll(sgr(`4${n}`), sgr(`3${n}`)).replaceAll(sgr(`10${n}`), sgr(`9${n}`));
  }
  return out;
}

/** Solid chips in the terminal's own colors: louder than the panel-colored tones. */
const solid = (code) => ({ label: sgr(code) + sgr(7), cap: sgr(code) });

/**
 * Colors taken from a pi theme. A theme without `getFgAnsi`/`getBgAnsi` still
 * colors bold text and marks, and leaves pills as typed.
 */
export function createPalette(
  theme,
  { boldColor = "mdLink", roundCaps = true, icons = true } = {},
) {
  const fg = (name) => (text) => theme.fg(name, text);
  const palette = {
    bold: fg(boldColor),
    passed: fg("success"),
    failed: fg("error"),
    arrow: fg("accent"),
    tree: fg("dim"),
    warn: fg("warning"),
    roundCaps,
    icons,
  };
  if (typeof theme.getFgAnsi !== "function" || typeof theme.getBgAnsi !== "function") {
    return palette;
  }
  const tone = (labelFg, bg) => {
    const bgAnsi = theme.getBgAnsi(bg);
    // A theme without panel colors (pi's system theme when the terminal reports
    // none) draws pills in reverse video: the tone's color becomes the background.
    if (!bgAnsi || bgAnsi === sgr(49)) {
      const fgAnsi = theme.getFgAnsi(labelFg === "text" ? "accent" : labelFg);
      return { label: fgAnsi + sgr(7), cap: fgAnsi };
    }
    return { label: bgAnsi + theme.getFgAnsi(labelFg), cap: bgToFg(bgAnsi) };
  };
  palette.pills = {
    success: tone("success", "toolSuccessBg"),
    error: tone("error", "toolErrorBg"),
    warning: tone("warning", "searchMatchBg"),
    neutral: tone("text", "selectedBg"),
    danger: solid(31),
    mode: solid(36),
    owner: solid(34),
  };
  return palette;
}

/** Prefix a known label with its icon, unless it already opens with a glyph. */
function withLabelIcon(label, palette) {
  if (!palette.icons || OWN_ICON.test(label)) return label;
  const word = label
    .replace(/[:\s]+$/, "")
    .trim()
    .toLowerCase();
  const icon =
    LABEL_ICONS[word] ?? (label.trimEnd().endsWith(":") ? ACTION_ICONS[word] : undefined);
  return icon ? `${icon} ${label}` : label;
}

/**
 * Success words that claim the work was checked. Over edits no check has
 * covered they are drawn as a question, with the word kept: the reply still
 * says what it says, the pill says what the run can show.
 */
const CHECKED_CLAIMS = new Set(["done", "passed", "verified", "fixed"]);

function pill(label, palette, unchecked = false) {
  const split = splitLabel(label);
  const doubted = unchecked && CHECKED_CLAIMS.has(split.key);
  const style = palette.pills[doubted ? "warning" : toneOf(label)];
  const icon = doubted ? QUESTION : split.icon;
  const word = doubted ? `${split.word} · unchecked` : split.word;
  // No-break spaces keep a two-word pill on one line when pi wraps the paragraph.
  const text = (
    icon && word && palette.icons ? `${icon} ${word}` : word || label.trim()
  ).replaceAll(" ", " ");
  const pad = palette.roundCaps ? "" : " ";
  const capL = palette.roundCaps ? `${style.cap}${sgr(39)}` : "";
  const capR = palette.roundCaps ? `${style.cap}${sgr(39)}` : "";
  return `${capL}${style.label}${sgr(1)}${pad}${text}${pad}${sgr("22;27")}${sgr(39)}${sgr(49)}${capR}`;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^( {0,3}#{1,6}\s+)(.+)$/;
// Escaped bold markers, bold markers, or a [[pill]] of 1-32 characters.
const INLINE = /(\\*)(\*\*|__)|\[\[([^[\]\n]{1,32})\]\]/g;
// A line's leading bold label, after an optional list marker or tree connector.
const LEAD_LABEL = /^(\s*(?:[-*+]|\d+\.)?\s*(?:[├└]──\s*)?\*\*)([^*`\n]{1,32})(\*\*)/;
const MARKS = [
  [/[✓✔]/g, "passed"],
  [/[✗✘]/g, "failed"],
  [/→/g, "arrow"],
  [/[├└]──/g, "tree"],
];

// A line about removing or moving a file names a path that is meant to be gone.
const GONE_ON_PURPOSE = /\b(?:delet|remov|renam|mov|drop)\w*/i;

/** The path an inline code span names, without backticks or a :line suffix. */
const codePath = (span) =>
  span
    .replace(/^`+|`+$/g, "")
    .trim()
    .replace(/(?::\d+)+$/, "");

/** A marker after a code span whose path does not exist under the session's cwd. */
function missingMark(palette) {
  return " " + palette.warn(`${palette.icons ? "\uf127 " : ""}missing`);
}

function decorateLine(line, palette, open, close, marks) {
  const stale = marks.stale?.size && !GONE_ON_PURPOSE.test(line) ? marks.stale : null;
  const labelled = line.replace(
    LEAD_LABEL,
    (_, before, label, after) => before + withLabelIcon(label, palette) + after,
  );
  // Odd parts are inline code spans, which stay untouched.
  const parts = labelled.split(/(`+[^`]*?`+)/g);
  let result = "";
  let inBold;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // pi's code color ends with a foreground reset; restore the bold color after it.
      const mark = stale?.has(codePath(parts[i])) ? missingMark(palette) : "";
      result += parts[i] + mark + (inBold ? open : "");
      continue;
    }
    let prose = parts[i];
    if (palette.icons) {
      prose = prose.replace(
        ACTION_LABEL,
        (_, before, word, after) => `${before}${ACTION_ICONS[word.toLowerCase()]} ${word}${after}`,
      );
    }
    for (const [pattern, key] of MARKS) {
      prose = prose.replace(pattern, (m) => palette[key](m) + (inBold ? open : ""));
    }
    result += prose.replace(INLINE, (match, slashes, marker, label) => {
      if (label !== undefined) {
        if (!palette.pills || !label.trim()) return match;
        return pill(label, palette, marks.unchecked) + (inBold ? sgr(1) + open : "");
      }
      if (slashes.length % 2 === 1) return match; // escaped marker
      if (!inBold) {
        inBold = marker;
        return slashes + marker + open;
      }
      if (inBold === marker) {
        inBold = undefined;
        return slashes + close + marker;
      }
      return match;
    });
  }
  // An unclosed span (streaming, or literal asterisks) ends its color at the line end.
  return inBold ? result + close : result;
}

/**
 * Apply colors to assistant Markdown, leaving fenced code and inline code alone.
 * `marks.unchecked` draws checked-claim pills as questions; `marks.stale` is a
 * set of paths to mark as missing where an inline code span names one.
 */
export function decorate(markdown, palette, marks = {}) {
  const [open, close] = palette.bold("\u0000").split("\u0000");
  const out = [];
  let fence;
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(FENCE);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      out.push(line);
    } else if (fenceMatch) {
      fence = fenceMatch[1];
      out.push(line);
    } else if (HEADING.test(line)) {
      // pi already colors headings; they only take an icon.
      out.push(line.replace(HEADING, (_, hashes, title) => hashes + withLabelIcon(title, palette)));
    } else {
      out.push(decorateLine(line, palette, open, close, marks));
    }
  }
  return out.join("\n");
}

const pills = (words) => words.map((w) => `[[${w}]]`).join(", ");
const titled = (words) => words.map((w) => w[0].toUpperCase() + w.slice(1)).join(", ");

/** The reply-style rules given to the model; every word list is read from the tables above. */
export function replyGuidance() {
  const v = VOCABULARY;
  return [
    "These rules shape replies written to the user in this terminal. It colors pills, adds icons, and cannot change text size.",
    "",
    `- **Label every reply.** Start the first substantive line with a bold label, even for a one-line update, and give each subject in a multi-part reply a short heading or a bullet with a bold lead label. Write the label as a plain word; the terminal adds its icon. Never type icon glyphs. Labels with an icon: ${titled(Object.keys(LABEL_ICONS))}. Prefer these; any other label shows without an icon.`,
    "- **Shape follows information.** Use `├──` and `└──` for what belongs to what, `→` for a sequence, `✓` or `✗` beside a checked item. Write tree rows as indented lines directly under their parent with no list dash, one line per row. A one-line answer can stay one line.",
    "- **Bold the anchor terms.** Bold the projects, components, choices and statuses under discussion where they carry the point: a first mention in a section, a bullet's lead label such as **Cause:**, and the decision the user must make. One to three bold spans per paragraph or bullet; bolding every noun erases the signal.",
    "- **Pills are required, not optional.** A pill is `[[Word]]` beside the subject it describes; the terminal colors it and adds its icon from the word. A pill names a state or an ask, never an adjective. Use exactly these words so the same state always reads the same:",
    `  - **Red, something is wrong:** ${pills(v.error.core)}. Every failure and blocker carries one.`,
    `  - **Yellow, look here:** ${pills(v.warning.core)}. [[Needs you]] is an action only the user can take; [[Decision]] is a call only the user makes. Every ask and every unchecked claim carries one.`,
    `  - **Green, settled:** ${pills(v.success.core)}.`,
    `  - **Solid red, consequences:** ${pills(v.danger.core)}. Required beside any action that has one, before taking it.`,
    `  - **Cyan, kind of work:** open every substantive reply with the kind of work you understood the request to be: ${pills(v.mode.core)}. Brainstorm is options and a recommendation, Investigate is evidence, Preview and Implement are a working result, Qualify is rigorous proof.`,
    `  - **Blue, ownership:** ${pills(v.owner.core)} beside any program, file, service, or configuration you changed or propose to change outside the task's own files: created by this task, also used by others, or belonging to someone else.`,
    `  - **Soft blue, context:** ${pills(CONTEXT_WORDS)}, and any other short label.`,
    "- **Evidence pills.** Mark each check [[Passed]], [[Failed]], [[Attempted]] (run, but its result does not settle the claim) or [[Unverified]] (not run). Mark other claims [[Observed]] (witnessed in the real system) or [[Inferred]] (reasoned from other signals). Say where a check ran in the pill's detail: [[Passed locally]] and [[Passed on CI]] are different claims, and a local pass never stands for a CI pass.",
    "- **Pill placement.** A known word may carry short detail: [[Passed 12/12]], [[Failed: 3 tests]]. One pill per bullet or table cell, with two exceptions: a sequence line joined by `→`, and a scoreboard, which is one line of counts such as [[Done 6]] [[Failed 1]] [[Needs you 1]] under the opening sentence of a long report. In a long reply, repeat every [[Needs you]] and [[Decision]] in a closing line. Never put pills in headings, and do not invent new status words.",
    `- **Every attention pill carries its action.** Follow the pill with the one fact the user needs to act on it, introduced by a bold lead-in word ending in a colon. These lead-ins get an icon: ${titled(Object.keys(ACTION_ICONS))}. Required for every red, yellow, and solid red pill and for [[Inferred]]; optional for green ones.`,
    "  - [[Unverified]] means you *could not* check. If you can run the check yourself, run it and report the result instead. Otherwise give the fastest check and who can run it: **Check:** reload and look at the first pill.",
    "  - [[Needs you]]: the exact action and what it unblocks. **Do:** sign in to the staging dashboard; then I can read the deploy log.",
    "  - [[Decision]]: the options, your pick, and what you will do meanwhile. **Next:** I'll prepare it as a dry run.",
    "  - [[Failed]] or [[Broken]]: the cause and what you are doing about it. **Next:** preparing a backfill.",
    "  - [[Blocked]]: what blocks it and the smallest thing that unblocks it. **Unblock:** read access for this session.",
    "  - [[Partial]] or [[In progress]]: what remains. **Left:** pricing and checkout.",
    "  - [[Skipped]]: why, and how to run it anyway. **Run:** the exact command.",
    "  - [[At risk]] or [[Unsafe]]: what would make it fail and the guard against it. **Guard:** keep both columns for one release.",
    "  - [[Costs money]]: the amount, before acting.",
    "  - [[Destructive]] or [[Irreversible]]: what is lost and how to get it back, or that nothing can. **Undo:** none; export them first.",
    "  - [[Shared]] or [[Foreign]]: who else is affected.",
    "  - [[Inferred]]: what it was inferred from.",
    "  - [[Done]], [[Fixed]], or [[Live]]: where to see it. **See:** the address, file, or command that shows it.",
    "- **Headings and code.** Use `##` headings; `###` and deeper show their hash marks. Reserve inline code for literals the user may copy or search (paths, commands, exact identifiers).",
    "- **Copyable text stays clean.** Keep pills out of paths, commands, code, literal output, files, commit messages, pull request text and machine-readable data. Omit pills and tree shapes when the user asks for plain text, ASCII, or an exact format.",
  ].join("\n");
}

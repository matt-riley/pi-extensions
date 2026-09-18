// shell-parse.mjs — quote-aware shell text parsing, shared by the extensions
// that reason about commands before they run.
//
// Extracted verbatim from bash-policy.mjs (plan-mode's read-only guard) when
// the guardrail needed the same primitives for the opposite question: not
// "is this command provably read-only?" but "what could this command
// destroy?". Both consumers care about the same hard part — telling operator
// characters from literal ones — so they share one parser instead of two.
//
// Quote awareness matters: `grep "<div"` and `node -e 'a -> b'` contain > and
// < as data. A regex over raw text counts them as redirects and produces the
// false positives the guardrail exists to avoid.

const CHAIN_OPS = ["&&", "&", "||", "|", ";", "\n"];

// Split a command on chain operators that appear outside quotes.
export function splitSegments(input) {
  const parts = [];
  let segStart = 0;
  let i = 0;
  let quote = null;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (quote) {
      if (quote === '"' && ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    const op = CHAIN_OPS.find((o) => input.startsWith(o, i));
    if (op) {
      parts.push(input.slice(segStart, i));
      i += op.length;
      segStart = i;
      continue;
    }
    i++;
  }
  parts.push(input.slice(segStart));
  return parts;
}

// Shell-like tokenizer: whitespace-split outside quotes, strip surrounding
// quotes, resolve backslash escapes.
export function tokenize(segment) {
  const tokens = [];
  let i = 0;
  const n = segment.length;
  while (i < n) {
    while (i < n && /\s/.test(segment[i])) i++;
    if (i >= n) break;
    let tok = "";
    let quote = null;
    while (i < n) {
      const ch = segment[i];
      if (quote) {
        if (quote === '"' && ch === "\\") { tok += segment[i + 1] ?? ""; i += 2; continue; }
        if (ch === quote) { quote = null; i++; continue; }
        tok += ch; i++;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
      if (/\s/.test(ch)) break;
      if (ch === "\\") { tok += segment[i + 1] ?? ""; i += 2; continue; }
      tok += ch; i++;
    }
    tokens.push(tok);
  }
  return tokens;
}

// Any < or > outside quotes is a redirection operator (quoted ones are
// literal, e.g. grep "<div").
export function hasRedirectOutsideQuotes(segment) {
  let quote = null;
  let i = 0;
  const n = segment.length;
  while (i < n) {
    const ch = segment[i];
    if (quote) {
      if (quote === '"' && ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "<" || ch === ">") return true;
    i++;
  }
  return false;
}

// Output redirects outside quotes, with the operator kept: `>` truncates the
// target (destructive), `>>` appends (not). File-descriptor duplications
// (`2>&1`) have no path — so a target of null means "redirect, but not a file
// the caller can judge". Targets are unquoted via tokenize, so
// `> "my file.txt"` reports `my file.txt`.
export function redirectTargets(segment) {
  // Redirects inside a command substitution belong to the substitution, which
  // is classified separately — scanning them here desynchronises the quote
  // state (`"$(cmd 2>/dev/null)" = ""` is not a redirect into a weird path).
  const scannable = blankSpans(segment, substitutionSpans(segment));
  const out = [];
  let quote = null;
  let i = 0;
  const n = scannable.length;
  while (i < n) {
    const ch = scannable[i];
    if (quote) {
      if (quote === '"' && ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === ">") {
      const append = scannable[i + 1] === ">";
      const op = append ? ">>" : ">";
      const rest = segment.slice(i + op.length);
      // Trim shell punctuation glued to the path: `> /dev/null)` (a redirect
      // inside $( )) and `;` terminators are syntax, not part of the filename.
      const raw = (tokenize(rest)[0] ?? "").replace(/[);,]+$/, "");
      // `2>&1`, `>&2`, `>&-` and bare trailing `>` carry no path.
      const isFdDup = raw.startsWith("&") || raw === "" || raw === "-";
      out.push({ op, target: raw && !isFdDup ? raw : null });
      i += op.length;
      continue;
    }
    i++;
  }
  return out;
}

function blankSpans(text, spans) {
  if (!spans.length) return text;
  const chars = [...text];
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = " ";
  }
  return chars.join("");
}

// Command substitution ($(…) or backticks) executes code. Single quotes
// suppress it; double quotes and unquoted positions do not.
export function hasCommandSubstitution(segment) {
  return collectSubstitutions(segment).length > 0;
}

/**
 * Split a command into the lines that are shell and the heredoc bodies that
 * are data.
 *
 * A heredoc body is not parsed as shell — `cat > x.js <<'EOF'` followed by
 * JavaScript full of `>` comparisons would otherwise read as a pile of output
 * redirects into whatever the right-hand side happens to look like. Bodies
 * are returned separately, because an *unquoted* heredoc still expands $()
 * before it is written, so it can carry a command even though it is not one.
 *
 *   { text: lines with bodies removed, bodies: [{ marker, quoted, body }] }
 */
export function stripHeredocs(input) {
  const lines = String(input ?? "").split("\n");
  const kept = [];
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    kept.push(line);
    if (!match) continue;
    const [, dash, quote, marker] = match;
    const body = [];
    i++;
    for (; i < lines.length; i++) {
      const candidate = dash ? lines[i].replace(/^\t+/, "") : lines[i];
      if (candidate.trim() === marker) break;
      body.push(lines[i]);
    }
    bodies.push({ marker, quoted: quote !== "", body: body.join("\n") });
  }
  return { text: kept.join("\n"), bodies };
}

// The bodies of $() and backtick substitutions, quote-aware, outermost only.
// The guardrail evaluates these as commands of their own: `echo $(rm -rf ~)`
// is a delete with an audience, and a parser that stops at the first word
// would see only `echo`.
export function collectSubstitutions(segment) {
  return substitutionSpans(segment).map(([start, end, inner]) => inner ?? segment.slice(start, end));
}

/** [start, end, inner] for every $() and backtick body, quote-aware. */
function substitutionSpans(segment) {
  const out = [];
  const n = segment.length;
  let quote = null;
  let i = 0;
  while (i < n) {
    const ch = segment[i];
    if (ch === "\\") { i += 2; continue; }
    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === null && ch === "'") {
      quote = "'";
      i++;
      continue;
    }
    if (ch === '"') {
      // Toggle: entering and leaving are both handled here (an apostrophe
      // inside double quotes, as in "don't", must not start a string).
      quote = quote === '"' ? null : '"';
      i++;
      continue;
    }

    if (ch === "`") {
      const end = segment.indexOf("`", i + 1);
      if (end < 0) { out.push([i, n, segment.slice(i + 1)]); break; }
      out.push([i, end + 1, segment.slice(i + 1, end)]);
      i = end + 1;
      continue;
    }
    if (ch === "$" && segment[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        const c = segment[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "(") { depth++; j++; continue; }
        if (c === ")") { depth--; if (depth === 0) break; j++; continue; }
        j++;
      }
      out.push([i, j + 1, segment.slice(i + 2, j)]);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

// Find the command head: skip leading env assignments (FOO=bar) and flags.
export function findHead(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.includes("=") && !t.startsWith("=") && i < tokens.length - 1) { i++; continue; }
    if (t.startsWith("-")) { i++; continue; }
    break;
  }
  return { head: tokens[i]?.toLowerCase(), args: tokens.slice(i + 1) };
}

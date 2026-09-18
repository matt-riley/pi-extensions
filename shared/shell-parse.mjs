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

export const CHAIN_OPS = ["&&", "&", "||", "|", ";", "\n"];

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
  const out = [];
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
    if (ch === ">") {
      const append = segment[i + 1] === ">";
      const op = append ? ">>" : ">";
      const rest = segment.slice(i + op.length);
      const token = tokenize(rest)[0] ?? "";
      // `2>&1`, `>&2`, `>&-` and bare trailing `>` carry no path.
      const isFdDup = token.startsWith("&") || /^-?$/.test(token);
      out.push({ op, target: token && !isFdDup ? token : null });
      i += op.length;
      continue;
    }
    i++;
  }
  return out;
}

// Command substitution ($(…) or backticks) executes code. Single quotes
// suppress it; double quotes and unquoted positions do not.
export function hasCommandSubstitution(segment) {
  let quote = null;
  let i = 0;
  const n = segment.length;
  while (i < n) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") { i += 2; continue; }
      if (ch === '"') { quote = null; i++; continue; }
      // $() and backticks expand inside double quotes too.
      if (ch === "`") return true;
      if (ch === "$" && segment[i + 1] === "(") return true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") return true;
    if (ch === "$" && segment[i + 1] === "(") return true;
    i++;
  }
  return false;
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

// ts-tokenizer.mjs — the char scanner behind ts-parser.mjs: comments, strings,
// template literals with ${} interpolation, heuristic regex literals.
//
// Pure and dependency-free. The regex heuristic is documented inline at REGEX_PREV.

// Tokens after which a `/` starts a regex literal (expression position).
const REGEX_PREV = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "extends",
]);

// Puncts after which a `/` is division, not a regex.
const DIV_PREV = new Set([")", "]", "}", "+", "-"]);

function buildLineStarts(source) {
  const starts = [0];
  for (let k = 0; k < source.length; k++) {
    if (source[k] === "\n") starts.push(k + 1);
  }
  return starts;
}

/**
 * Tokenize TS/JS source into tokens:
 * { type: "id"|"punct"|"str"|"num", value, line, col, rawStart, rawEnd }
 * Comments and whitespace are dropped; strings/templates/regex are single
 * tokens. line/col are 1-based.
 */
export function tokenizeTs(source) {
  const tokens = [];
  const n = source.length;
  const lineStarts = buildLineStarts(source);
  // Cursor into lineStarts for O(1)-ish line lookup per token.
  let lineCursor = 0;

  function position(idx) {
    while (lineCursor + 1 < lineStarts.length && lineStarts[lineCursor + 1] <= idx) lineCursor++;
    return { line: lineCursor + 1, col: idx - lineStarts[lineCursor] + 1 };
  }

  const push = (type, value, start, end) => {
    const { line, col } = position(start);
    tokens.push({ type, value, line, col, rawStart: start, rawEnd: end });
  };

  const isIdStart = (ch) => /[A-Za-z_$]/.test(ch);
  const isIdChar = (ch) => /[A-Za-z0-9_$]/.test(ch);
  const isDigit = (ch) => ch >= "0" && ch <= "9";

  let i = 0;
  while (i < n) {
    const ch = source[i];

    // Whitespace
    if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v") {
      i++;
      continue;
    }

    // Comments
    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Strings
    if (ch === "'" || ch === '"') {
      const start = i;
      const quote = ch;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      push("str", source.slice(start, i), start, i);
      continue;
    }

    // Template literals with ${} interpolation — handled with a proper
    // template/code nesting stack so interpolations containing nested
    // templates, arrow bodies, and braces stay balanced:
    //   ${tools.map(t => { return `...${x}...`; })}
    // Strings and comments inside interpolation code are skipped so their
    // braces don't confuse the balance. Regex literals inside interpolations
    // are an accepted approximation (not skipped).
    if (ch === "`") {
      const start = i;
      i++;
      const stack = [{ mode: "template" }];
      while (i < n && stack.length > 0) {
        const tc = source[i];
        const top = stack[stack.length - 1];
        if (tc === "\\") {
          i += 2;
          continue;
        }
        if (top.mode === "template") {
          if (tc === "`") {
            stack.pop();
            i++;
            continue;
          }
          if (tc === "$" && source[i + 1] === "{") {
            stack.push({ mode: "code" });
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        // code mode (inside ${...}): brace balance + nested constructs
        if (tc === "`") {
          stack.push({ mode: "template" });
          i++;
          continue;
        }
        if (tc === "{") {
          stack.push({ mode: "code" });
          i++;
          continue;
        }
        if (tc === "}") {
          stack.pop();
          i++;
          continue;
        }
        if (tc === "'" || tc === '"') {
          const q = tc;
          i++;
          while (i < n) {
            if (source[i] === "\\") {
              i += 2;
              continue;
            }
            if (source[i] === q) {
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        if (tc === "/" && source[i + 1] === "/") {
          while (i < n && source[i] !== "\n") i++;
          continue;
        }
        if (tc === "/" && source[i + 1] === "*") {
          i += 2;
          while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
          i += 2;
          continue;
        }
        i++;
      }
      push("str", source.slice(start, i), start, i);
      continue;
    }

    // Regex literal vs division (heuristic)
    if (ch === "/") {
      const prev = tokens[tokens.length - 1];
      const regexOk =
        !prev ||
        (prev.type === "punct" && !DIV_PREV.has(prev.value)) ||
        (prev.type === "id" && REGEX_PREV.has(prev.value));
      if (regexOk) {
        const start = i;
        i++;
        let inClass = false;
        while (i < n) {
          const rc = source[i];
          if (rc === "\\") {
            i += 2;
            continue;
          }
          if (rc === "[") inClass = true;
          if (rc === "]") inClass = false;
          if (rc === "/" && !inClass) {
            i++;
            break;
          }
          if (rc === "\n") break; // unterminated — bail
          i++;
        }
        while (i < n && /[a-z]/i.test(source[i])) i++; // flags
        push("str", source.slice(start, i), start, i);
        continue;
      }
      // fall through: division operator
      push("punct", "/", i, i + 1);
      i++;
      continue;
    }

    // Identifiers / keywords
    if (isIdStart(ch)) {
      const start = i;
      let value = "";
      while (i < n && isIdChar(source[i])) {
        value += source[i];
        i++;
      }
      push("id", value, start, i);
      continue;
    }

    // Numbers
    if (isDigit(ch) || (ch === "." && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      while (i < n && /[0-9a-fA-FxXoObBeE._]/.test(source[i])) i++;
      // TS bigint / trailing decimals
      if (source[i] === "n") i++;
      push("num", source.slice(start, i), start, i);
      continue;
    }

    // Any other single char (punct)
    push("punct", ch, i, i + 1);
    i++;
  }

  return tokens;
}

// --- Parser -----------------------------------------------------------------

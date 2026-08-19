// ts-parser.mjs — pragmatic TS/JS tokenizer + symbol extractor.
//
// Single-pass char scanner (comments, strings, template literals with ${}
// interpolation, heuristic regex literals) then a token walker that extracts
// declarations, imports, and re-exports with brace-scope ranges for
// enclosing-symbol framing. Not a full parser: known approximations are
// documented inline (regex-literal heuristic, JSX as token soup, ASI ignored,
// named function expressions inside call args not captured). Tests lock the
// supported constructs.
//
// Pure module — no fs, no deps; testable with node --test.

const TS_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
]);

export function isTsFile(relPath) {
  const dot = relPath.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = relPath.slice(dot).toLowerCase();
  return TS_EXTENSIONS.has(ext) || (relPath.endsWith(".d.ts"));
}

// --- Tokenizer --------------------------------------------------------------

const DECL_KINDS = {
  function: "function",
  class: "class",
  interface: "interface",
  type: "type",
  enum: "enum",
  const: "const",
  let: "variable",
  var: "variable",
  namespace: "namespace",
  module: "namespace",
};

const CLASS_MODIFIERS = new Set([
  "static", "async", "get", "set", "public", "private", "protected",
  "readonly", "abstract", "override", "accessor", "declare",
]);

// Tokens after which a `/` starts a regex literal (expression position).
const REGEX_PREV = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete",
  "void", "throw", "case", "do", "else", "yield", "await", "extends",
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
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
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
        if (tc === "\\") { i += 2; continue; }
        if (top.mode === "template") {
          if (tc === "`") { stack.pop(); i++; continue; }
          if (tc === "$" && source[i + 1] === "{") { stack.push({ mode: "code" }); i += 2; continue; }
          i++;
          continue;
        }
        // code mode (inside ${...}): brace balance + nested constructs
        if (tc === "`") { stack.push({ mode: "template" }); i++; continue; }
        if (tc === "{") { stack.push({ mode: "code" }); i++; continue; }
        if (tc === "}") { stack.pop(); i++; continue; }
        if (tc === "'" || tc === '"') {
          const q = tc;
          i++;
          while (i < n) {
            if (source[i] === "\\") { i += 2; continue; }
            if (source[i] === q) { i++; break; }
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
          if (rc === "\\") { i += 2; continue; }
          if (rc === "[") inClass = true;
          if (rc === "]") inClass = false;
          if (rc === "/" && !inClass) { i++; break; }
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
      while (i < n && isIdChar(source[i])) { value += source[i]; i++; }
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

/** Parse TS/JS source into { symbols, imports, reexports }. */
export function parseTsSource(source, { filePath = "" } = {}) {
  const tokens = tokenizeTs(source);
  const symbols = [];
  const imports = [];
  const reexports = [];
  // Scope stack: { type: "program"|"body"|"class"|"interface"|"enum"|"namespace"|"block", symbol? }
  const scopeStack = [{ type: "program" }];
  const n = tokens.length;

  const isKw = (idx, word) => {
    const t = tokens[idx];
    return !!t && t.type === "id" && t.value === word;
  };

  // `=>` tokenizes as two punct tokens: "=" followed by ">".
  const isArrow = (idx) =>
    tokens[idx]?.value === "=" && tokens[idx + 1]?.value === ">";

  const atStatementStart = (idx) => {
    if (idx <= 0) return true;
    const prev = tokens[idx - 1];
    return prev.type === "punct" && [";", "{", "}", ":"].includes(prev.value);
  };

  const topScope = () => scopeStack[scopeStack.length - 1];

  const addSymbol = (sym) => {
    if (symbols.length >= 4000) return; // hard safety cap for pathological files
    symbols.push(sym);
    return sym;
  };

  // Find the index just past the `)` matching the one at `open` (which must be
  // a "("). Returns -1 on imbalance.
  const matchParen = (open) => {
    let depth = 0;
    for (let k = open; k < n; k++) {
      const t = tokens[k];
      if (t.type !== "punct") continue;
      if (t.value === "(") depth++;
      else if (t.value === ")") {
        depth--;
        if (depth === 0) return k + 1;
      }
    }
    return -1;
  };

  // Skip a return-type annotation between `)` and `{`/`=>`, e.g.
  // `function f(a): Promise<{ x: number }> {` or `const f = (a): number => a`.
  // Tracks < > ( ) [ ] { } with a depth clamp so `=>` arrows in the type
  // don't go negative. Returns the index of the token after the annotation
  // (at `{`, `;`, or the token that ended it).
  const skipReturnType = (idx) => {
    if (tokens[idx]?.value !== ":") return idx;
    let d = idx + 1;
    let depth = 0;
    while (d < n) {
      const t = tokens[d];
      if (t.type !== "punct") { d++; continue; }
      if (t.value === "{" && depth === 0) break;
      if (t.value === ";" && depth === 0) break;
      // `=>` arrow in a const initializer ends the return type. (An arrow
      // TYPE as the return value is ambiguous — accepted approximation.)
      if (t.value === "=" && tokens[d + 1]?.value === ">" && depth === 0) break;
      if (t.value === "(" || t.value === "[" || t.value === "{" || t.value === "<") depth++;
      else if (t.value === ")" || t.value === "]" || t.value === "}" || t.value === ">") depth = Math.max(0, depth - 1);
      d++;
    }
    return d;
  };

  // Skip a balanced angle-bracket group (generic type params). Returns index
  // after the matching ">", or `start` if it does not look like generics.
  // Only `;` bails (statement end); `{` inside a type literal like
  // `T extends {a: number}` is tolerated by counting all < and >.
  const skipAngles = (start) => {
    if (tokens[start]?.value !== "<") return start;
    let depth = 0;
    for (let k = start; k < n; k++) {
      const t = tokens[k];
      if (t.type !== "punct") continue;
      if (t.value === "<") depth++;
      else if (t.value === ">") {
        depth--;
        if (depth === 0) return k + 1;
      } else if (t.value === ";") {
        return start; // bailed — not a generic group
      }
      if (depth > 64) return start; // pathological — bail
    }
    return start;
  };

  const sig = (from, to) => {
    if (from < 0 || to <= from || to > n) return "";
    const raw = source.slice(tokens[from].rawStart, tokens[to - 1].rawEnd);
    const clean = raw.replace(/\s+/g, " ").trim();
    return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
  };

  // Consume tokens until statement end at bracket depth 0 (stops at ";").
  // Returns the index past the ";" or the current index at EOF.
  const consumeStatement = (start) => {
    let depth = 0;
    let k = start;
    for (; k < n; k++) {
      const t = tokens[k];
      if (t.type !== "punct") continue;
      if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
      else if (t.value === ")" || t.value === "]" || t.value === "}") {
        if (depth === 0) return k; // unexpected close — stop before it
        depth--;
      } else if (t.value === ";" && depth === 0) {
        return k + 1;
      }
    }
    return k;
  };

  // Parse a comma-separated name list inside { ... } at `open` (index of "{").
  // Returns { names: [{imported, local}], end } where end is past the "}".
  const parseNameList = (open) => {
    const names = [];
    let k = open + 1;
    while (k < n) {
      const t = tokens[k];
      if (!t) break;
      if (t.type === "punct" && t.value === "}") return { names, end: k + 1 };
      if (t.type === "punct" && t.value === ",") { k++; continue; }
      if (t.type !== "id") { k++; continue; }
      if (t.value === "type" && tokens[k + 1]?.type === "id") {
        // inline `type` modifier inside a list — skip it
        k++;
        continue;
      }
      const imported = t.value;
      let local = t.value;
      k++;
      if (isKw(k, "as") && tokens[k + 1]?.type === "id") {
        local = tokens[k + 1].value;
        k += 2;
      }
      names.push({ imported, local });
    }
    return { names, end: n };
  };

  // --- Declaration parsers (return next index, or null on pattern mismatch)

  // `function` / `async function` / `function*` [+ name] <T> (params)
  const parseFunctionDecl = (start, { exported = false, defaultExport = false } = {}) => {
    let j = start;
    if (isKw(j, "async")) j++;
    if (!isKw(j, "function")) return null;
    const fnIdx = j;
    j++;
    if (tokens[j]?.value === "*") j++;
    let name = "(anonymous)";
    let nameIdx = -1;
    if (tokens[j]?.type === "id") {
      name = tokens[j].value;
      nameIdx = j;
      j++;
    } else if (!defaultExport) {
      return null; // anonymous function expression without export default
    } else {
      name = "default";
    }
    if (tokens[j]?.value === "<") j = skipAngles(j);
    if (tokens[j]?.value !== "(") return null;
    const afterParen = matchParen(j);
    if (afterParen < 0) return null;
    // Skip a return-type annotation between ")" and the body brace, e.g.
    // `function f(a): Promise<{ x: number }> {`.
    const after = skipReturnType(afterParen);
    const symbol = addSymbol({
      name,
      kind: "function",
      line: tokens[start].line,
      col: tokens[start].col,
      signature: sig(fnIdx, afterParen),
      startLine: tokens[start].line,
      endLine: -1,
      exported,
      defaultExport,
    });
    if (tokens[after]?.value === "{") {
      scopeStack.push({ type: "body", symbol });
      return after + 1;
    }
    // No body (ambient/overload): end at the signature.
    symbol.endLine = tokens[after - 1].line;
    return after;
  };

  const parseClassLike = (start, { exported = false, defaultExport = false } = {}) => {
    const kw = tokens[start].value; // class | interface | enum | namespace | module
    const kind = DECL_KINDS[kw];
    let j = start + 1;
    let name = "(anonymous)";
    if (tokens[j]?.type === "id") {
      name = tokens[j].value;
      j++;
    } else if (!defaultExport) {
      return null;
    } else {
      name = "default";
    }
    if (tokens[j]?.value === "<") j = skipAngles(j);
    // Skip `extends` / `implements` clauses up to the body brace.
    let depth = 0;
    while (j < n) {
      const t = tokens[j];
      if (t.type !== "punct") { j++; continue; }
      if (t.value === "{" && depth === 0) break;
      if (t.value === "(") depth++;
      else if (t.value === ")") depth--;
      else if (t.value === ";") return null; // no body — mismatch
      j++;
    }
    if (tokens[j]?.value !== "{") return null;
    const symbol = addSymbol({
      name,
      kind,
      line: tokens[start].line,
      col: tokens[start].col,
      signature: sig(start, j),
      startLine: tokens[start].line,
      endLine: -1,
      exported,
      defaultExport,
    });
    scopeStack.push({ type: kind === "class" ? "class" : kind, symbol });
    return j + 1;
  };

  // `type X = ...`
  const parseTypeAlias = (start, { exported = false } = {}) => {
    if (!isKw(start, "type")) return null;
    if (tokens[start + 1]?.type !== "id") return null;
    const name = tokens[start + 1].value;
    if (tokens[start + 2]?.value !== "=") return null;
    const end = consumeStatement(start + 3);
    const symbol = addSymbol({
      name,
      kind: "type",
      line: tokens[start].line,
      col: tokens[start].col,
      signature: sig(start, Math.max(end, start + 1)),
      startLine: tokens[start].line,
      endLine: end > start ? tokens[end - 1].line : tokens[start].line,
      exported,
      defaultExport: false,
    });
    return end;
  };

  // `const/let/var name = ...` (arrow → function), destructuring, require()
  const parseVarDecl = (start, { exported = false } = {}) => {
    const kw = tokens[start].value;
    const kind = DECL_KINDS[kw];
    let j = start + 1;
    const names = [];

    const parseSimple = (idx) => {
      // returns { name, next } for a single identifier
      const t = tokens[idx];
      if (t?.type !== "id") return null;
      return { name: t.value, next: idx + 1 };
    };

    // Destructuring { a, b } / [ a, b ] — with depth tracking so default
    // values like `x = {}` or `x = fn(1)` inside the pattern don't end it
    // early. Names are collected only at depth 1 (direct bindings).
    if (tokens[j]?.value === "{" || tokens[j]?.value === "[") {
      let d = j + 1;
      let depth = 1;
      while (d < n) {
        const t = tokens[d];
        if (t.type === "punct") {
          if (t.value === "{" || t.value === "[") depth++;
          else if (t.value === "}" || t.value === "]") {
            depth--;
            if (depth === 0) { d++; break; }
          } else if (t.value === ":" && depth === 1 && tokens[d + 1]?.type === "id") {
            // Renamed binding `a: inner` — replace the last collected name.
            if (names.length > 0) names[names.length - 1] = tokens[d + 1].value;
            d += 2;
            continue;
          }
          d++;
          continue;
        }
        if (t.type === "id" && depth === 1 && t.value !== "default") {
          if (tokens[d + 1]?.value !== "(") names.push(t.value);
        }
        d++;
      }
      j = d;
    } else {
      const simple = parseSimple(j);
      if (!simple) return null;
      names.push(simple.name);
      j = simple.next;
    }

    // Optional type annotation `: T` — only `=` or `;` at depth 0 end it
    // (type literals inside the annotation contain `;` and `=`).
    if (tokens[j]?.value === ":") {
      let d = j + 1;
      let depth = 0;
      while (d < n) {
        const t = tokens[d];
        if (t.type !== "punct") { d++; continue; }
        if ((t.value === "=" || t.value === ";") && depth === 0) break;
        if (t.value === "(" || t.value === "[" || t.value === "{" || t.value === "<") depth++;
        else if (t.value === ")" || t.value === "]" || t.value === "}" || t.value === ">") depth = Math.max(0, depth - 1);
        d++;
      }
      j = d;
    }

    if (tokens[j]?.value !== "=") {
      // `const x;` (declare-style) — symbol, no initializer
      const end = consumeStatement(j);
      for (const name of names) {
        addSymbol({
          name, kind, line: tokens[start].line, col: tokens[start].col,
          signature: sig(start, Math.max(end, start + 1)),
          startLine: tokens[start].line, endLine: end > start ? tokens[end - 1].line : tokens[start].line,
          exported, defaultExport: false,
        });
      }
      return end;
    }
    j++; // past "="

    // require() import: `const x = require("mod")` / destructured require
    if (isKw(j, "require") && tokens[j + 1]?.value === "(") {
      const afterParen = matchParen(j + 1);
      const srcTok = tokens[j + 2];
      if (srcTok?.type === "str" && afterParen > 0) {
        const source = srcTok.value.replace(/^['"]|['"]$/g, "");
        imports.push({
          names: names.map((nm) => ({ imported: nm, local: nm })),
          source,
          typeOnly: false,
          line: tokens[start].line,
        });
      }
    }

    const syms = names.map((name) =>
      addSymbol({
        name, kind, line: tokens[start].line, col: tokens[start].col,
        signature: "", startLine: tokens[start].line, endLine: -1,
        exported, defaultExport: false,
      }),
    );
    const primary = syms[0];
    if (!primary) return consumeStatement(j);

    // Arrow function: `name = (params) => ...` or `name = async (...) => ...`
    if (isKw(j, "async")) {
      const maybeArrow = j + 1;
      if (tokens[maybeArrow]?.value === "(") {
        const afterParen = matchParen(maybeArrow);
        const afterRt = afterParen > 0 ? skipReturnType(afterParen) : -1;
        if (afterParen > 0 && afterRt >= 0 && isArrow(afterRt)) {
          primary.kind = "function";
          primary.signature = sig(maybeArrow, afterParen);
          if (tokens[afterRt + 2]?.value === "{") {
            scopeStack.push({ type: "body", symbol: primary });
            return afterRt + 3;
          }
          primary.endLine = tokens[afterRt].line;
          return consumeStatement(afterRt + 2);
        }
      }
    }
    if (tokens[j]?.value === "(") {
      const afterParen = matchParen(j);
      const afterRt = afterParen > 0 ? skipReturnType(afterParen) : -1;
      if (afterParen > 0 && afterRt >= 0 && isArrow(afterRt)) {
        primary.kind = "function";
        primary.signature = sig(j, afterParen);
        if (tokens[afterRt + 2]?.value === "{") {
          scopeStack.push({ type: "body", symbol: primary });
          return afterRt + 3;
        }
        primary.endLine = tokens[afterRt].line;
        return consumeStatement(afterRt + 2);
      }
    }
    if (tokens[j]?.value === "{") {
      // Object-literal / block initializer: bind for framing.
      if (syms.length > 1) {
        scopeStack.push({ type: "body", symbols: syms });
      } else {
        scopeStack.push({ type: "body", symbol: primary });
      }
      return j + 1;
    }
    // Plain value: `const x = 5;` — end at statement end.
    const end = consumeStatement(j);
    const endLine = end > start ? tokens[end - 1].line : tokens[start].line;
    for (const s of syms) {
      if (s.endLine < 0) s.endLine = endLine;
    }
    return end;
  };

  // `import ...` — returns next index, or null if not an import statement.
  const parseImport = (start) => {
    if (!isKw(start, "import")) return null;
    let j = start + 1;
    const rec = { names: [], source: "", typeOnly: false, line: tokens[start].line };

    if (tokens[j]?.type === "str") {
      // Side-effect import
      rec.source = String(tokens[j].value).replace(/^['"]|['"]$/g, "");
      imports.push(rec);
      return consumeStatement(j + 1);
    }
    if (isKw(j, "type")) {
      rec.typeOnly = true;
      j++;
    }
    // Default + named mix: `import foo, { bar } from ...`
    const collectNames = (list) => {
      for (const nm of list) rec.names.push(nm);
    };
    if (tokens[j]?.value === "{") {
      const { names, end } = parseNameList(j);
      collectNames(names);
      j = end;
    } else if (tokens[j]?.value === "*") {
      j++;
      if (!isKw(j, "as") || tokens[j + 1]?.type !== "id") return null;
      rec.names.push({ imported: "*", local: tokens[j + 1].value });
      j += 2;
    } else if (tokens[j]?.type === "id") {
      rec.names.push({ imported: "default", local: tokens[j].value });
      j++;
      if (tokens[j]?.value === ",") {
        j++;
        if (tokens[j]?.value === "{") {
          const { names, end } = parseNameList(j);
          collectNames(names);
          j = end;
        }
      }
    } else {
      return null;
    }
    if (isKw(j, "from") && tokens[j + 1]?.type === "str") {
      rec.source = String(tokens[j + 1].value).replace(/^['"]|['"]$/g, "");
      j += 2;
    }
    if (rec.names.length > 0 || rec.source) imports.push(rec);
    return consumeStatement(j);
  };

  // `export ...` — returns next index, or null if not an export statement.
  const parseExport = (start) => {
    if (!isKw(start, "export")) return null;
    let j = start + 1;
    let defaultExport = false;
    if (isKw(j, "default")) {
      defaultExport = true;
      j++;
    }
    // `export default function/class/...`
    if (isKw(j, "async") && isKw(j + 1, "function")) {
      const r = parseFunctionDecl(j, { exported: true, defaultExport });
      return r ?? consumeStatement(j);
    }
    if (tokens[j]?.type === "id" && DECL_KINDS[tokens[j].value]) {
      if (tokens[j].value === "type" && tokens[j + 1]?.value === "{") {
        // `export type { X } from ...` — re-export list
        j++;
      } else {
        const r = parseDecl(j, { exported: true, defaultExport });
        return r ?? consumeStatement(j);
      }
    }
    if (tokens[j]?.value === "{") {
      const { names, end } = parseNameList(j);
      j = end;
      let source = null;
      if (isKw(j, "from") && tokens[j + 1]?.type === "str") {
        source = String(tokens[j + 1].value).replace(/^['"]|['"]$/g, "");
        j += 2;
      }
      reexports.push({ names, source, line: tokens[start].line });
      return consumeStatement(j);
    }
    if (tokens[j]?.value === "*") {
      j++;
      let asName = null;
      if (isKw(j, "as") && tokens[j + 1]?.type === "id") {
        asName = tokens[j + 1].value;
        j += 2;
      }
      if (isKw(j, "from") && tokens[j + 1]?.type === "str") {
        const source = String(tokens[j + 1].value).replace(/^['"]|['"]$/g, "");
        reexports.push({
          names: asName ? [{ imported: "*", local: asName }] : null,
          source,
          line: tokens[start].line,
        });
        return consumeStatement(j + 2);
      }
      return null;
    }
    if (tokens[j]?.value === "=") {
      // `export = x` (TS CommonJS) — skip the statement
      return consumeStatement(j);
    }
    if (defaultExport) {
      // `export default <expr>`
      const end = consumeStatement(j);
      addSymbol({
        name: "default",
        kind: "const",
        line: tokens[start].line,
        col: tokens[start].col,
        signature: sig(start, Math.max(end, start + 1)),
        startLine: tokens[start].line,
        endLine: end > start ? tokens[end - 1].line : tokens[start].line,
        exported: true,
        defaultExport: true,
      });
      return end;
    }
    return null;
  };

  const parseDecl = (start, opts) => {
    const kw = tokens[start].value;
    if (kw === "function" || (kw === "async" && isKw(start + 1, "function"))) {
      return parseFunctionDecl(start, opts);
    }
    if (kw === "class" || kw === "interface" || kw === "enum" || kw === "namespace" || kw === "module") {
      return parseClassLike(start, opts);
    }
    if (kw === "type") return parseTypeAlias(start, opts);
    if (kw === "const" || kw === "let" || kw === "var") return parseVarDecl(start, opts);
    return null;
  };

  // Skip a decorator `@foo.bar({...})` (possibly multi-line). Returns the
  // index of the declaration that follows it: the first non-comma token at
  // depth 0 on a fresh line, or a declaration keyword on the same line.
  const skipDecorator = (start) => {
    const startLine = tokens[start].line;
    let depth = 0;
    let k = start + 1;
    for (; k < n; k++) {
      const t = tokens[k];
      if (t.type !== "punct") {
        if (depth === 0 && (t.line > startLine || t.value === "export" || t.value === "async" || DECL_KINDS[t.value])) return k;
        continue;
      }
      if (t.value === "(" || t.value === "[" || t.value === "{") { depth++; continue; }
      if (t.value === ")" || t.value === "]" || t.value === "}") { depth = Math.max(0, depth - 1); continue; }
      if (depth === 0) {
        if (t.value === ",") continue; // trailing decorator args
        if (t.line > startLine) return k;
      }
    }
    return k;
  };

  // --- Member parsing inside class/interface/enum bodies --------------------

  const parseMember = (start) => {
    const scope = topScope();
    const isEnum = scope.type === "enum";
    let j = start;
    let getSet = "";
    // Modifiers. `get`/`set` only count as modifiers when followed by a name
    // (identifier or `#`); `get<T>()` is a method literally named "get".
    while (tokens[j]?.type === "id" && CLASS_MODIFIERS.has(tokens[j].value)) {
      const v = tokens[j].value;
      if (v === "get" || v === "set") {
        const next = tokens[j + 1];
        if (next?.type !== "id" && next?.value !== "#") break;
      }
      if (v === "get") getSet = "getter";
      else if (v === "set") getSet = "setter";
      j++;
    }
    let name = "";
    if (tokens[j]?.value === "#") {
      j++;
      if (tokens[j]?.type !== "id") return null;
      name = `#${tokens[j].value}`;
      j++;
    } else if (tokens[j]?.type === "id" || (isEnum && tokens[j]?.type === "id")) {
      name = tokens[j].value;
      j++;
    } else {
      return null;
    }
    const startIdx = start;

    if (tokens[j]?.value === "<") {
      const after = skipAngles(j);
      if (tokens[after]?.value === "(") j = after;
    }
    if (tokens[j]?.value === "(") {
      // Method (class/interface) or computed call — treat as method
      const afterParen = matchParen(j);
      if (afterParen < 0) return null;
      // Skip a return-type annotation before the body brace (class methods
      // rarely have one, but `foo(): Promise<X> {` is valid TS).
      const after = skipReturnType(afterParen);
      const kind = getSet || "method";
      const symbol = addSymbol({
        name,
        kind,
        line: tokens[startIdx].line,
        col: tokens[startIdx].col,
        signature: sig(j, afterParen),
        startLine: tokens[startIdx].line,
        endLine: -1,
        exported: false,
        defaultExport: false,
      });
      if (tokens[after]?.value === "{") {
        scopeStack.push({ type: "body", symbol });
        return after + 1;
      }
      symbol.endLine = tokens[after - 1].line;
      return after;
    }

    // Field / enum member / interface property
    const symbol = addSymbol({
      name,
      kind: "field",
      line: tokens[startIdx].line,
      col: tokens[startIdx].col,
      signature: "",
      startLine: tokens[startIdx].line,
      endLine: -1,
      exported: false,
      defaultExport: false,
    });
    let k = j;
    // Skip `?` / `:` type annotation, staying inside braces so `;` and `,`
    // only terminate the field at depth 0 (type literals contain `;`).
    let depth = 0;
    while (k < n) {
      const t = tokens[k];
      if (t.type !== "punct") { k++; continue; }
      if (t.value === "=" && depth === 0) break;
      if (t.value === ";" && depth === 0) {
        symbol.endLine = t.line;
        return k + 1;
      }
      if (t.value === "}" && depth === 0) {
        symbol.endLine = t.line;
        return k;
      }
      if (t.value === "," && depth === 0 && isEnum) {
        symbol.endLine = t.line;
        return k + 1;
      }
      if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
      else if (t.value === ")" || t.value === "]" || t.value === "}") depth--;
      k++;
    }
    if (tokens[k]?.value === "=") {
      // `foo = (args) => ...` arrow field
      k++;
      if (tokens[k]?.value === "(") {
        const afterParen = matchParen(k);
        if (afterParen > 0 && isArrow(afterParen)) {
          symbol.signature = sig(k, afterParen);
          if (tokens[afterParen + 2]?.value === "{") {
            scopeStack.push({ type: "body", symbol });
            return afterParen + 3;
          }
          symbol.endLine = tokens[afterParen].line;
          return consumeStatement(afterParen + 2);
        }
      }
      if (isEnum) {
        // Enum member value: stop at the next comma or the closing brace.
        let depth2 = 0;
        let e = k;
        while (e < n) {
          const t = tokens[e];
          if (t.type !== "punct") { e++; continue; }
          if (t.value === "(" || t.value === "[" || t.value === "{") depth2++;
          else if (t.value === ")" || t.value === "]" || t.value === "}") {
            if (depth2 === 0) break;
            depth2--;
          } else if (t.value === "," && depth2 === 0) {
            symbol.endLine = t.line;
            return e + 1;
          }
          e++;
        }
        symbol.endLine = tokens[Math.min(e, n - 1)].line;
        return e;
      }
      const end = consumeStatement(k);
      symbol.endLine = end > start ? tokens[end - 1].line : tokens[start].line;
      return end;
    }
    symbol.endLine = k > start ? tokens[k - 1].line : tokens[start].line;
    return k;
  };

  const isMemberBoundary = (idx) => {
    const prev = tokens[idx - 1];
    return (
      idx <= 0 ||
      (prev?.type === "punct" && ["{", ";", "}", ","].includes(prev.value))
    );
  };

  // --- Main loop ------------------------------------------------------------

  let i = 0;
  while (i < n) {
    const tok = tokens[i];

    // Decorators: `@Component(...)` — skip to the declaration that follows.
    if (tok.type === "punct" && tok.value === "@" && atStatementStart(i)) {
      const k = skipDecorator(i);
      let next = null;
      const tk = tokens[k];
      if (tk?.type === "id") {
        if (tk.value === "export") next = parseExport(k);
        else if (tk.value === "async" && isKw(k + 1, "function")) next = parseFunctionDecl(k, {});
        else if (DECL_KINDS[tk.value]) next = parseDecl(k, {});
      }
      i = next != null && next > k ? next : k;
      continue;
    }

    // Braces: push/pop scopes (decl parsers push their own body scopes).
    if (tok.type === "punct" && tok.value === "{") {
      scopeStack.push({ type: "block" });
      i++;
      continue;
    }
    if (tok.type === "punct" && tok.value === "}") {
      const popped = scopeStack.pop();
      if (popped?.symbols) {
        for (const s of popped.symbols) {
          if (s.endLine < 0) s.endLine = tok.line;
        }
      } else if (popped?.symbol && popped.symbol.endLine < 0) {
        popped.symbol.endLine = tok.line;
      }
      i++;
      continue;
    }

    // Class/interface/enum member parsing — before the id-only checks so
    // `#private` fields, modifiers, and computed members are handled here.
    {
      const top = topScope();
      if ((top.type === "class" || top.type === "interface" || top.type === "enum") && isMemberBoundary(i)) {
        const r = parseMember(i);
        if (r != null && r > i) { i = r; continue; }
      }
    }

    if (tok.type !== "id") {
      i++;
      continue;
    }

    const v = tok.value;
    const top = topScope();

    if (!atStatementStart(i)) { i++; continue; }

    if (v === "export") {
      const r = parseExport(i);
      if (r != null && r > i) { i = r; continue; }
      i++;
      continue;
    }
    if (v === "import") {
      const r = parseImport(i);
      if (r != null && r > i) { i = r; continue; }
      i++;
      continue;
    }
    if (v === "declare") {
      // Ambient declaration: parse the following declaration normally.
      if (tokens[i + 1]?.type === "id" && DECL_KINDS[tokens[i + 1].value]) {
        const r = parseDecl(i + 1, {});
        if (r != null && r > i + 1) { i = r; continue; }
      }
      i++;
      continue;
    }
    if (v === "require" && tokens[i + 1]?.value === "(") {
      const afterParen = matchParen(i + 1);
      const srcTok = tokens[i + 2];
      if (srcTok?.type === "str" && afterParen > 0) {
        imports.push({
          names: [],
          source: String(srcTok.value).replace(/^['"]|['"]$/g, ""),
          typeOnly: false,
          line: tok.line,
        });
        i = afterParen;
        continue;
      }
    }
    if (DECL_KINDS[v] && v !== "type") {
      // skip `type` here: handled by parseTypeAlias via parseDecl below
      const r = parseDecl(i, {});
      if (r != null && r > i) { i = r; continue; }
      i++;
      continue;
    }
    if (v === "async" && isKw(i + 1, "function")) {
      const r = parseFunctionDecl(i, {});
      if (r != null && r > i) { i = r; continue; }
      i++;
      continue;
    }
    if (v === "type") {
      const r = parseTypeAlias(i, {});
      if (r != null && r > i) { i = r; continue; }
      i++;
      continue;
    }
    i++;
  }

  return { symbols, imports, reexports };
}

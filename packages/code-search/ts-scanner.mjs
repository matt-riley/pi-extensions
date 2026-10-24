// ts-scanner.mjs — the small readers the TypeScript walker shares: keyword and
// arrow lookahead, bracket matching, return-type and generic skipping, statement
// consumption, and the name list inside `{ ... }`.
//
// makeScanner closes over the walker's state (tokens, the scope stack, the symbol
// list, the source, its length) and returns the readers, so the bodies are the
// ones that grew inside parseTsSource, unchanged.
export function makeScanner(state) {
  const { tokens, symbols, scopeStack, n, source } = state;

  const isKw = (idx, word) => {
    const t = tokens[idx];
    return !!t && t.type === "id" && t.value === word;
  };

  // `=>` tokenizes as two punct tokens: "=" followed by ">".
  const isArrow = (idx) => tokens[idx]?.value === "=" && tokens[idx + 1]?.value === ">";

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
      if (t.type !== "punct") {
        d++;
        continue;
      }
      if (t.value === "{" && depth === 0) break;
      if (t.value === ";" && depth === 0) break;
      // `=>` arrow in a const initializer ends the return type. (An arrow
      // TYPE as the return value is ambiguous — accepted approximation.)
      if (t.value === "=" && tokens[d + 1]?.value === ">" && depth === 0) break;
      if (t.value === "(" || t.value === "[" || t.value === "{" || t.value === "<") depth++;
      else if (t.value === ")" || t.value === "]" || t.value === "}" || t.value === ">")
        depth = Math.max(0, depth - 1);
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
      if (t.type === "punct" && t.value === ",") {
        k++;
        continue;
      }
      if (t.type !== "id") {
        k++;
        continue;
      }
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

  return {
    isKw,
    isArrow,
    atStatementStart,
    topScope,
    addSymbol,
    matchParen,
    skipReturnType,
    skipAngles,
    sig,
    consumeStatement,
    parseNameList,
  };
}

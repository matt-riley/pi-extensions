// ts-declarations.mjs — the declaration parsers: function, class, type, var, import
// and export. Each returns the next index, or null when the tokens do not match
// the pattern, so the walker can fall through to the next candidate.
//
// Called by makeDeclarations(context), where context is the scanner plus the
// walker state; parseDecl dispatches on the keyword.
export const DECL_KINDS = {
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

export function makeDeclarations(context) {
  const {
    tokens,
    imports,
    reexports,
    scopeStack,
    n,
    isKw,
    isArrow,
    addSymbol,
    matchParen,
    skipReturnType,
    skipAngles,
    sig,
    consumeStatement,
    parseNameList,
  } = context;

  const parseFunctionDecl = (start, { exported = false, defaultExport = false } = {}) => {
    let j = start;
    if (isKw(j, "async")) j++;
    if (!isKw(j, "function")) return null;
    const fnIdx = j;
    j++;
    if (tokens[j]?.value === "*") j++;
    let name = "(anonymous)";
    if (tokens[j]?.type === "id") {
      name = tokens[j].value;
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
      if (t.type !== "punct") {
        j++;
        continue;
      }
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
    addSymbol({
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
            if (depth === 0) {
              d++;
              break;
            }
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
        if (t.type !== "punct") {
          d++;
          continue;
        }
        if ((t.value === "=" || t.value === ";") && depth === 0) break;
        if (t.value === "(" || t.value === "[" || t.value === "{" || t.value === "<") depth++;
        else if (t.value === ")" || t.value === "]" || t.value === "}" || t.value === ">")
          depth = Math.max(0, depth - 1);
        d++;
      }
      j = d;
    }

    if (tokens[j]?.value !== "=") {
      // `const x;` (declare-style) — symbol, no initializer
      const end = consumeStatement(j);
      for (const name of names) {
        addSymbol({
          name,
          kind,
          line: tokens[start].line,
          col: tokens[start].col,
          signature: sig(start, Math.max(end, start + 1)),
          startLine: tokens[start].line,
          endLine: end > start ? tokens[end - 1].line : tokens[start].line,
          exported,
          defaultExport: false,
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
        const srcPath = srcTok.value.replace(/^['"]|['"]$/g, "");
        imports.push({
          names: names.map((nm) => ({ imported: nm, local: nm })),
          source: srcPath,
          typeOnly: false,
          line: tokens[start].line,
        });
      }
    }

    const syms = names.map((name) =>
      addSymbol({
        name,
        kind,
        line: tokens[start].line,
        col: tokens[start].col,
        signature: "",
        startLine: tokens[start].line,
        endLine: -1,
        exported,
        defaultExport: false,
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
      let entrySource = null;
      if (isKw(j, "from") && tokens[j + 1]?.type === "str") {
        entrySource = String(tokens[j + 1].value).replace(/^['"]|['"]$/g, "");
        j += 2;
      }
      reexports.push({ names, source: entrySource, line: tokens[start].line });
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
        const fromSource = String(tokens[j + 1].value).replace(/^['"]|['"]$/g, "");
        reexports.push({
          names: asName ? [{ imported: "*", local: asName }] : null,
          source: fromSource,
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
    if (
      kw === "class" ||
      kw === "interface" ||
      kw === "enum" ||
      kw === "namespace" ||
      kw === "module"
    ) {
      return parseClassLike(start, opts);
    }
    if (kw === "type") return parseTypeAlias(start, opts);
    if (kw === "const" || kw === "let" || kw === "var") return parseVarDecl(start, opts);
    return null;
  };

  // Skip a decorator `@foo.bar({...})` (possibly multi-line). Returns the
  // index of the declaration that follows it: the first non-comma token at
  // depth 0 on a fresh line, or a declaration keyword on the same line.

  return {
    parseFunctionDecl,
    parseClassLike,
    parseTypeAlias,
    parseVarDecl,
    parseImport,
    parseExport,
    parseDecl,
  };
}

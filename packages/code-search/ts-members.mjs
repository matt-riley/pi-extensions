// ts-members.mjs — class, interface and enum bodies: decorators, member
// boundaries and one member at a time.
// A decorator run has to end where a declaration starts, so this module reads
// DECL_KINDS from the declaration parsers.
import { DECL_KINDS } from "./ts-declarations.mjs";

const CLASS_MODIFIERS = new Set([
  "static",
  "async",
  "get",
  "set",
  "public",
  "private",
  "protected",
  "readonly",
  "abstract",
  "override",
  "accessor",
  "declare",
]);

export function makeMembers(context) {
  const {
    tokens,
    scopeStack,
    n,
    isArrow,
    topScope,
    addSymbol,
    matchParen,
    skipReturnType,
    skipAngles,
    sig,
    consumeStatement,
  } = context;

  const skipDecorator = (start) => {
    const startLine = tokens[start].line;
    let depth = 0;
    let k = start + 1;
    for (; k < n; k++) {
      const t = tokens[k];
      if (t.type !== "punct") {
        if (
          depth === 0 &&
          (t.line > startLine || t.value === "export" || t.value === "async" || DECL_KINDS[t.value])
        )
          return k;
        continue;
      }
      if (t.value === "(" || t.value === "[" || t.value === "{") {
        depth++;
        continue;
      }
      if (t.value === ")" || t.value === "]" || t.value === "}") {
        depth = Math.max(0, depth - 1);
        continue;
      }
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
      if (t.type !== "punct") {
        k++;
        continue;
      }
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
          if (t.type !== "punct") {
            e++;
            continue;
          }
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
    return idx <= 0 || (prev?.type === "punct" && ["{", ";", "}", ","].includes(prev.value));
  };

  return { skipDecorator, parseMember, isMemberBoundary };
}

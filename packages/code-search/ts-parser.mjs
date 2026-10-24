// ts-parser.mjs — pragmatic TS/JS symbol extractor.
//
// tokenizeTs (ts-tokenizer.mjs) produces tokens; this file walks them and
// extracts declarations, imports, and re-exports with brace-scope ranges for
// enclosing-symbol framing. Not a full parser: known approximations are
// documented inline (JSX as token soup, ASI ignored, named function expressions
// inside call args not captured). Tests lock the supported constructs.
//
// The work is split by question, each module closing over the same walker state:
// ts-scanner.mjs (is the next token what I think it is?), ts-declarations.mjs
// (what does this statement declare?), ts-members.mjs (what is inside this body?).
// This file owns the state, the main loop, and the symbol list that comes out.

import { tokenizeTs } from "./ts-tokenizer.mjs";
import { DECL_KINDS, makeDeclarations } from "./ts-declarations.mjs";
import { makeMembers } from "./ts-members.mjs";
import { makeScanner } from "./ts-scanner.mjs";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export function isTsFile(relPath) {
  const dot = relPath.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = relPath.slice(dot).toLowerCase();
  return TS_EXTENSIONS.has(ext) || relPath.endsWith(".d.ts");
}

export function parseTsSource(source) {
  const tokens = tokenizeTs(source);
  const symbols = [];
  const imports = [];
  const reexports = [];
  const scopeStack = [{ type: "program" }];
  const n = tokens.length;

  // One state object, three groups of readers built on top of it. The arrays are
  // shared by reference, so a push in any group is visible to the walker.
  const context = { tokens, symbols, imports, reexports, scopeStack, n, source };
  Object.assign(context, makeScanner(context));
  Object.assign(context, makeDeclarations(context));
  Object.assign(context, makeMembers(context));
  const {
    isKw,
    atStatementStart,
    topScope,
    matchParen,
    parseFunctionDecl,
    parseTypeAlias,
    parseImport,
    parseExport,
    parseDecl,
    skipDecorator,
    parseMember,
    isMemberBoundary,
  } = context;

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
      if (
        (top.type === "class" || top.type === "interface" || top.type === "enum") &&
        isMemberBoundary(i)
      ) {
        const r = parseMember(i);
        if (r != null && r > i) {
          i = r;
          continue;
        }
      }
    }

    if (tok.type !== "id") {
      i++;
      continue;
    }

    const v = tok.value;

    if (!atStatementStart(i)) {
      i++;
      continue;
    }

    if (v === "export") {
      const r = parseExport(i);
      if (r != null && r > i) {
        i = r;
        continue;
      }
      i++;
      continue;
    }
    if (v === "import") {
      const r = parseImport(i);
      if (r != null && r > i) {
        i = r;
        continue;
      }
      i++;
      continue;
    }
    if (v === "declare") {
      // Ambient declaration: parse the following declaration normally.
      if (tokens[i + 1]?.type === "id" && DECL_KINDS[tokens[i + 1].value]) {
        const r = parseDecl(i + 1, {});
        if (r != null && r > i + 1) {
          i = r;
          continue;
        }
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
      if (r != null && r > i) {
        i = r;
        continue;
      }
      i++;
      continue;
    }
    if (v === "async" && isKw(i + 1, "function")) {
      const r = parseFunctionDecl(i, {});
      if (r != null && r > i) {
        i = r;
        continue;
      }
      i++;
      continue;
    }
    if (v === "type") {
      const r = parseTypeAlias(i, {});
      if (r != null && r > i) {
        i = r;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }

  return { symbols, imports, reexports };
}

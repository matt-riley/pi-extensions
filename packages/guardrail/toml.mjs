// toml.mjs — a small TOML reader, just enough for dependency tables.
//
// The dependency sentinel needs to know what a Cargo.toml or pyproject.toml
// requires before and after an edit. This reads tables, array tables, dotted
// keys, strings (basic, literal and multi-line), numbers, booleans, dates (kept
// as text), arrays and inline tables. It does not validate every corner of the
// spec. What it cannot read it refuses: parseToml returns null and never
// throws, so the caller can say "cannot judge this" instead of guessing.
//
// Tables are null-prototype objects, so a key named __proto__ is just data.

const BARE_KEY = /[A-Za-z0-9_-]/;
const NUMBER =
  /^[+-]?(?:inf|nan|0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)$/;
const DATE_TIME =
  /^\d{4}-\d\d-\d\d(?:[Tt ]\d\d:\d\d:\d\d(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)?)?$|^\d\d:\d\d:\d\d(?:\.\d+)?$/;
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

const fail = (why) => {
  throw new Error(why);
};
const table = () => Object.create(null);

function bareValue(token) {
  if (token === "true") return true;
  if (token === "false") return false;
  if (NUMBER.test(token)) return Number(token.replaceAll("_", "").replace("inf", "Infinity"));
  if (DATE_TIME.test(token)) return token;
  return fail(`bad value ${token}`);
}

function read(text) {
  const root = table();
  // Tables a header or inline table defined, and arrays that hold tables.
  const defined = new WeakSet();
  const tableArrays = new WeakSet();
  let at = 0;
  let current = root;

  const peek = (n = 0) => text[at + n];
  const skipSpace = () => {
    while (peek() === " " || peek() === "\t") at++;
  };
  const skipComment = () => {
    if (peek() === "#") while (at < text.length && peek() !== "\n") at++;
  };
  const skipBlank = () => {
    for (;;) {
      skipSpace();
      skipComment();
      if (peek() === "\n" || (peek() === "\r" && peek(1) === "\n")) at += peek() === "\n" ? 1 : 2;
      else return;
    }
  };
  const endOfLine = () => {
    skipSpace();
    skipComment();
    if (at >= text.length) return;
    if (peek() === "\n") at++;
    else if (peek() === "\r" && peek(1) === "\n") at += 2;
    else fail("junk after value");
  };

  function basicString(multi) {
    let out = "";
    for (;;) {
      if (at >= text.length) fail("unterminated string");
      const ch = text[at];
      if (ch === '"') {
        if (!multi) {
          at++;
          return out;
        }
        if (text.startsWith('"""', at)) {
          at += 3;
          // Up to two quotes right before the closing delimiter are content.
          for (let extra = 0; extra < 2 && peek() === '"'; extra++) {
            out += '"';
            at++;
          }
          return out;
        }
        out += ch;
        at++;
      } else if (ch === "\\") {
        const next = text[at + 1];
        if (next in ESCAPES) {
          out += ESCAPES[next];
          at += 2;
        } else if (next === "u" || next === "U") {
          const size = next === "u" ? 4 : 8;
          const hex = text.slice(at + 2, at + 2 + size);
          if (hex.length !== size || !/^[0-9a-fA-F]+$/.test(hex)) fail("bad unicode escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          at += 2 + size;
        } else if (multi && /[ \t\r\n]/.test(next ?? "")) {
          // A backslash at the end of a line trims the whitespace that follows.
          at++;
          while (/[ \t\r\n]/.test(text[at] ?? "x")) at++;
        } else fail("bad escape");
      } else if (ch === "\n" && !multi) fail("newline in string");
      else {
        out += ch;
        at++;
      }
    }
  }

  function literalString(multi) {
    const end = text.indexOf(multi ? "'''" : "'", at);
    if (end < 0) fail("unterminated string");
    const body = text.slice(at, end);
    if (!multi && body.includes("\n")) fail("newline in string");
    at = end + (multi ? 3 : 1);
    if (!multi) return body;
    // Up to two quotes right before the closing delimiter are content.
    let extra = "";
    while (extra.length < 2 && peek() === "'") {
      extra += "'";
      at++;
    }
    return body + extra;
  }

  function stringValue() {
    const quote = peek();
    const multi = text.startsWith(quote.repeat(3), at);
    at += multi ? 3 : 1;
    if (multi) {
      if (peek() === "\n") at++;
      else if (peek() === "\r" && peek(1) === "\n") at += 2;
    }
    return quote === '"' ? basicString(multi) : literalString(multi);
  }

  function key() {
    skipSpace();
    const quote = peek();
    if (quote === '"' || quote === "'") {
      at++;
      return quote === '"' ? basicString(false) : literalString(false);
    }
    const start = at;
    while (at < text.length && BARE_KEY.test(peek())) at++;
    if (at === start) fail("missing key");
    return text.slice(start, at);
  }

  function dottedKey() {
    const parts = [key()];
    skipSpace();
    while (peek() === ".") {
      at++;
      parts.push(key());
      skipSpace();
    }
    return parts;
  }

  function value() {
    skipSpace();
    const ch = peek();
    if (ch === '"' || ch === "'") return stringValue();
    if (ch === "[") return arrayValue();
    if (ch === "{") return inlineTable();
    const start = at;
    while (at < text.length && !/[\s,\]}#]/.test(peek())) at++;
    if (at === start) fail("missing value");
    return bareValue(text.slice(start, at));
  }

  function arrayValue() {
    at++;
    const items = [];
    for (;;) {
      skipBlank();
      if (peek() === "]") {
        at++;
        return items;
      }
      items.push(value());
      skipBlank();
      if (peek() === ",") {
        at++;
        skipBlank();
        if (peek() === ",") fail("empty array element");
      } else if (peek() !== "]") fail("bad array");
    }
  }

  // Walk down `parts` from `base`, making tables as needed. Header paths may
  // pass through an array of tables (the last element is the target); key
  // paths may not.
  function descend(base, parts, throughArrays) {
    let node = base;
    for (const part of parts) {
      let next = node[part];
      if (next === undefined) {
        next = table();
        node[part] = next;
      } else if (Array.isArray(next)) {
        if (!throughArrays || !tableArrays.has(next)) fail("cannot extend an array");
        next = next.at(-1);
      } else if (typeof next !== "object") fail("not a table");
      node = next;
    }
    return node;
  }

  function assign(base, parts, val) {
    const parent = descend(base, parts.slice(0, -1), false);
    const last = parts.at(-1);
    if (Object.hasOwn(parent, last)) fail("duplicate key");
    parent[last] = val;
  }

  function inlineTable() {
    at++;
    const result = table();
    defined.add(result);
    skipSpace();
    if (peek() === "}") {
      at++;
      return result;
    }
    for (;;) {
      const parts = dottedKey();
      skipSpace();
      if (peek() !== "=") fail("missing =");
      at++;
      assign(result, parts, value());
      skipSpace();
      if (peek() === ",") {
        at++;
        skipSpace();
        if (peek() === "}") fail("trailing comma in inline table");
      } else if (peek() === "}") {
        at++;
        return result;
      } else fail("bad inline table");
    }
  }

  function header() {
    const isArray = peek(1) === "[";
    at += isArray ? 2 : 1;
    const parts = dottedKey();
    skipSpace();
    if (!text.startsWith(isArray ? "]]" : "]", at)) fail("bad header");
    at += isArray ? 2 : 1;
    const parent = descend(root, parts.slice(0, -1), true);
    const last = parts.at(-1);
    const existing = parent[last];
    if (isArray) {
      if (existing === undefined) {
        const list = [];
        tableArrays.add(list);
        parent[last] = list;
      } else if (!Array.isArray(existing) || !tableArrays.has(existing)) fail("not an array table");
      const item = table();
      defined.add(item);
      parent[last].push(item);
      current = item;
    } else {
      if (existing === undefined) parent[last] = table();
      else if (Array.isArray(existing) || typeof existing !== "object" || defined.has(existing))
        fail("table redefined");
      defined.add(parent[last]);
      current = parent[last];
    }
    endOfLine();
  }

  for (;;) {
    skipBlank();
    if (at >= text.length) return root;
    if (peek() === "[") {
      header();
      continue;
    }
    const parts = dottedKey();
    skipSpace();
    if (peek() !== "=") fail("missing =");
    at++;
    assign(current, parts, value());
    endOfLine();
  }
}

/** The document as nested null-prototype objects and arrays, or null when it cannot be read. */
export function parseToml(text) {
  if (typeof text !== "string") return null;
  try {
    return read(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

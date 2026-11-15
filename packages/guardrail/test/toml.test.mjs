import { test } from "node:test";
import assert from "node:assert/strict";

import { parseToml } from "../toml.mjs";

// Plain objects, so compare through JSON.
const parse = (text) => {
  const value = parseToml(text);
  return value === null ? null : JSON.parse(JSON.stringify(value));
};

test("keys, strings, numbers and booleans", () => {
  assert.deepEqual(
    parse(
      `name = "app"\nlit = 'C:\\path'\nn = 1_000\nf = 1.5e3\nok = true\nno = false\nhex = 0xff\n`,
    ),
    { name: "app", lit: "C:\\path", n: 1000, f: 1500, ok: true, no: false, hex: 255 },
  );
});

test("basic string escapes", () => {
  assert.deepEqual(parse(`a = "tab\\there \\"q\\" \\u00e9 \\\\"`), { a: 'tab\there "q" é \\' });
});

test("comments and blank lines are ignored, including after values", () => {
  assert.deepEqual(parse(`# top\n\na = 1 # trailing\nb = "x # not a comment"\n`), {
    a: 1,
    b: "x # not a comment",
  });
});

test("tables, nested tables and quoted or dotted table names", () => {
  assert.deepEqual(
    parse(
      `[a]\nx = 1\n[a.b]\ny = 2\n[ "c.d" . e ]\nz = 3\n[target.'cfg(unix)'.dependencies]\nlibc = "0.2"\n`,
    ),
    {
      a: { x: 1, b: { y: 2 } },
      "c.d": { e: { z: 3 } },
      target: { "cfg(unix)": { dependencies: { libc: "0.2" } } },
    },
  );
});

test("dotted keys build nested tables", () => {
  assert.deepEqual(
    parse(`serde.version = "1"\nserde.features = ["derive"]\nsite."google.com" = true\n`),
    {
      serde: { version: "1", features: ["derive"] },
      site: { "google.com": true },
    },
  );
});

test("arrays: multi-line, trailing comma, comments inside, nested", () => {
  assert.deepEqual(
    parse(`deps = [\n  "a>=1", # first\n  "b",\n]\nm = [[1, 2], [3]]\nempty = []\n`),
    { deps: ["a>=1", "b"], m: [[1, 2], [3]], empty: [] },
  );
});

test("inline tables, nested and empty", () => {
  assert.deepEqual(parse(`a = { version = "1", features = ["x"], t = { k = 1 } }\ne = {}\n`), {
    a: { version: "1", features: ["x"], t: { k: 1 } },
    e: {},
  });
});

test("multi-line strings, basic and literal", () => {
  assert.deepEqual(parse(`a = """\nline one\nline "two"\n"""\nb = '''raw \\n text'''\n`), {
    a: 'line one\nline "two"\n',
    b: "raw \\n text",
  });
  assert.deepEqual(parse(`a = """one \\\n    two"""`), { a: "one two" });
});

test("array of tables", () => {
  assert.deepEqual(parse(`[[bin]]\nname = "a"\n[[bin]]\nname = "b"\n[bin.extra]\nk = 1\n`), {
    bin: [{ name: "a" }, { name: "b", extra: { k: 1 } }],
  });
});

test("dates and times are kept as text", () => {
  assert.deepEqual(parse(`d = 1979-05-27\nt = 07:32:00\ndt = 1979-05-27T07:32:00Z\n`), {
    d: "1979-05-27",
    t: "07:32:00",
    dt: "1979-05-27T07:32:00Z",
  });
});

test("windows line endings and an empty document", () => {
  assert.deepEqual(parse("a = 1\r\n[t]\r\nb = 2\r\n"), { a: 1, t: { b: 2 } });
  assert.deepEqual(parse(""), {});
  assert.deepEqual(parse("# only a comment"), {});
});

test("a key named like a prototype property stays data", () => {
  const value = parseToml(`[__proto__]\npolluted = true\n`);
  assert.equal({}.polluted, undefined);
  assert.equal(value?.__proto__?.polluted, true);
});

test("anything it cannot read gives null instead of a guess", () => {
  for (const text of [
    "a = ",
    "a = nope",
    "a = [1, 2",
    "a = { x = 1",
    'a = "unterminated',
    "a = 1\na = 2",
    "[t]\n[t]",
    "[t\nx = 1",
    "a b = 1",
    "a = 1 b = 2",
    "a = [1,, 2]",
    "a = { x = 1, }",
    "= 1",
    "a = 1\n[a]\nx = 1",
    '"""',
    "a = '''never closed",
    "a = 'x'extra",
    "a = 0xZZ",
  ]) {
    assert.equal(parseToml(text), null, JSON.stringify(text));
  }
});

test("non-string input gives null", () => {
  assert.equal(parseToml(undefined), null);
  assert.equal(parseToml({}), null);
});

test("quotes next to a multi-line closing delimiter belong to the string", () => {
  assert.deepEqual(parse(`a = """say "hi""""\nb = '''it's''''`), { a: 'say "hi"', b: "it's'" });
});

test("special floats and signed numbers", () => {
  assert.deepEqual(parse("a = -17\nb = +3.5\nc = 0o17\nd = 0b101"), {
    a: -17,
    b: 3.5,
    c: 15,
    d: 5,
  });
  assert.equal(parseToml("a = inf").a, Infinity);
  assert.equal(Number.isNaN(parseToml("a = nan").a), true);
});

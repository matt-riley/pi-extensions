import { test } from "node:test";
import assert from "node:assert/strict";
import { isTsFile, parseTsSource } from "../ts-parser.mjs";

const syms = (src) => parseTsSource(src).symbols;
const find = (src, name) => syms(src).find((s) => s.name === name);

test("isTsFile recognizes the ts/js family", () => {
  for (const f of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "types.d.ts"]) {
    assert.equal(isTsFile(f), true, f);
  }
  assert.equal(isTsFile("a.py"), false);
  assert.equal(isTsFile("README"), false);
});

test("function declarations with export and return types", () => {
  const src = `export function hello(a: string): number {
  return a.length;
}`;
  const s = find(src, "hello");
  assert.ok(s);
  assert.equal(s.kind, "function");
  assert.equal(s.exported, true);
  assert.equal(s.startLine, 1);
  assert.equal(s.endLine, 3); // body range for framing
  assert.ok(s.signature.includes("hello(a: string)"));
});

test("async functions and generators", () => {
  const src = `export async function fetchIt(url: string) {
  return url;
}
async function* gen() {
  yield 1;
}`;
  assert.equal(find(src, "fetchIt").kind, "function");
  assert.equal(find(src, "fetchIt").exported, true);
  assert.equal(find(src, "gen").kind, "function");
});

test("classes with methods, fields, getters, private members", () => {
  const src = `export class Greeter {
  private name: string;
  static count = 0;
  #secret = "s";

  constructor(name: string) { this.name = name; }

  greet(prefix: string): string {
    return prefix + this.name;
  }

  get label(): string { return this.name; }
}`;
  assert.equal(find(src, "Greeter").kind, "class");
  assert.equal(find(src, "Greeter").exported, true);
  const name = find(src, "name");
  assert.equal(name.kind, "field");
  const greet = find(src, "greet");
  assert.equal(greet.kind, "method");
  assert.equal(greet.endLine, 10);
  assert.equal(find(src, "constructor").kind, "method");
  assert.equal(find(src, "label").kind, "getter");
  assert.equal(find(src, "#secret").name, "#secret");
  assert.equal(find(src, "count").kind, "field");
});

test("interfaces, type aliases, enums", () => {
  const src = `export interface Shape {
  area: number;
  describe(): string;
}
export type Id = string | number;
export enum Color { Red, Green, Blue = 3 }`;
  assert.equal(find(src, "Shape").kind, "interface");
  assert.equal(find(src, "area").kind, "field");
  assert.equal(find(src, "describe").kind, "method");
  assert.equal(find(src, "Id").kind, "type");
  assert.equal(find(src, "Color").kind, "enum");
  assert.equal(find(src, "Red").kind, "field");
  assert.equal(find(src, "Blue").kind, "field");
});

test("const arrows become functions with body ranges", () => {
  const src = `export const add = (a: number, b: number): number => {
  return a + b;
};`;
  const s = find(src, "add");
  assert.equal(s.kind, "function");
  assert.equal(s.startLine, 1);
  assert.equal(s.endLine, 3);
  assert.ok(s.signature.includes("(a: number, b: number)"));
});

test("const values and destructuring with defaults", () => {
  const src = `const x = 5;
const { a, b } = opts;
const [p, q] = pair;
const { r = {}, s = fn(1) } = thing;`;
  assert.equal(find(src, "x").kind, "const");
  assert.equal(find(src, "a").kind, "const");
  assert.equal(find(src, "b").kind, "const");
  assert.equal(find(src, "p").kind, "const");
  assert.equal(find(src, "q").kind, "const");
  assert.equal(find(src, "r").kind, "const");
  assert.equal(find(src, "s").kind, "const");
  // destructuring inside default values must not leak names
  assert.equal(syms(src).some((s) => s.name === "fn"), false);
});

test("renamed destructuring binds the inner name", () => {
  const src = `const { a: renamedA, b } = opts;`;
  assert.equal(find(src, "renamedA").name, "renamedA");
  assert.equal(syms(src).some((s) => s.name === "a"), false);
  assert.equal(find(src, "b").name, "b");
});

test("imports: default, named, namespace, type, side-effect", () => {
  const { imports } = parseTsSource(`import def from "./d";
import { foo, bar as baz } from "./m";
import * as ns from "pkg";
import type { X } from "./types";
import "side-effect";`);
  assert.equal(imports.length, 5);
  assert.deepEqual(imports[0].names, [{ imported: "default", local: "def" }]);
  assert.deepEqual(imports[1].names, [
    { imported: "foo", local: "foo" },
    { imported: "bar", local: "baz" },
  ]);
  assert.deepEqual(imports[2].names, [{ imported: "*", local: "ns" }]);
  assert.equal(imports[3].typeOnly, true);
  assert.equal(imports[4].source, "side-effect");
  assert.equal(imports[4].names.length, 0);
});

test("require imports (CJS)", () => {
  const { imports, symbols } = parseTsSource(`const http = require("node:http");
const { readFile, writeFile } = require("node:fs");`);
  assert.equal(imports.length, 2);
  assert.equal(imports[0].source, "node:http");
  assert.deepEqual(imports[1].names.map((n) => n.local), ["readFile", "writeFile"]);
  assert.equal(symbols.some((s) => s.name === "http"), true);
});

test("re-exports: named, star, namespace", () => {
  const { reexports } = parseTsSource(`export { a, b as c } from "./x";
export * from "./y";
export * as ns from "./z";`);
  assert.equal(reexports.length, 3);
  assert.deepEqual(reexports[0].names, [
    { imported: "a", local: "a" },
    { imported: "b", local: "c" },
  ]);
  assert.equal(reexports[1].names, null);
  assert.deepEqual(reexports[2].names, [{ imported: "*", local: "ns" }]);
});

test("export default forms", () => {
  const src = `export default function main() { return 1; }
export default class Widget {}
export default 42;`;
  const main = find(src, "main");
  assert.equal(main.defaultExport, true);
  assert.equal(main.exported, true);
  assert.equal(find(src, "Widget").defaultExport, true);
  const def = find(src, "default");
  assert.ok(def);
  assert.equal(def.defaultExport, true);
});

test("decorated classes are still found", () => {
  const src = `@Component({
  selector: "app-root",
})
export class AppRoot {}`;
  assert.equal(find(src, "AppRoot").kind, "class");
});

test("comments, strings, and templates are not parsed as code", () => {
  const src = `// function notARealDecl() {}
/* class AlsoNotReal {} */
const template = \`function insideTemplate() {}\`;
const quoted = "const fake = 1;";`;
  assert.equal(syms(src).filter((s) => ["notARealDecl", "AlsoNotReal"].includes(s.name)).length, 0);
  assert.equal(find(src, "template").kind, "const");
  assert.equal(find(src, "quoted").kind, "const");
});

test("nested templates with interpolation and arrow bodies stay balanced", () => {
  const src = `const html = \`<div>
  \${items.map(t => {
    const ok = t.valid;
    return \`<span>\${escape(t.name)}</span>\`;
  }).join("")}
</div>\`;
function after() { return 1; }`;
  assert.equal(find(src, "html").kind, "const");
  const after = find(src, "after");
  assert.equal(after.kind, "function");
  assert.equal(after.startLine, 7); // the template spans lines 1–6
});

test("regex literals do not confuse brace tracking", () => {
  const src = `function strip(s) {
  const re = /[{}\/]/g;
  const re2 = /}/;
  return s.replace(re, "");
}`;
  const s = find(src, "strip");
  assert.equal(s.kind, "function");
  assert.equal(s.endLine, 5);
});

test("object keys that look like keywords are not declarations", () => {
  const src = `const obj = { function: 1, class: 2, type: "x", export: 3 };
function real() {}`;
  assert.equal(syms(src).filter((s) => s.kind === "function").length, 1);
  assert.equal(find(src, "real").kind, "function");
});

test("scope framing: matches inside a method frame to the method", () => {
  const src = `export class A {
  run() {
    const inner = () => 1;
    return inner();
  }
}`;
  const run = find(src, "run");
  const inner = find(src, "inner");
  assert.equal(run.endLine, 5); // body closes at line 5
  assert.equal(inner.endLine, 3); // arrow without body ends at its own line
});

test("namespaces and declare are handled", () => {
  const src = `declare function ambient(x: number): void;
namespace Utils {
  export function helper() { return 1; }
}`;
  assert.equal(find(src, "ambient").kind, "function");
  assert.equal(find(src, "Utils").kind, "namespace");
  assert.equal(find(src, "helper").kind, "function");
});

test("generic methods and functions", () => {
  const src = `function identity<T>(value: T): T { return value; }
class Box<T> {
  get<U>(k: U): U { return k; }
}`;
  assert.equal(find(src, "identity").kind, "function");
  assert.equal(find(src, "Box").kind, "class");
  assert.equal(find(src, "get").kind, "method");
});

test("arrow field with body", () => {
  const src = `class C {
  onClick = (e: Event) => {
    handle(e);
  };
}`;
  const onClick = find(src, "onClick");
  assert.equal(onClick.kind, "field");
  assert.equal(onClick.endLine, 4);
});

test("nested functions inside functions", () => {
  const src = `function outer() {
  function inner() { return 1; }
  return inner();
}`;
  const outer = find(src, "outer");
  const inner = find(src, "inner");
  assert.equal(outer.endLine, 4);
  assert.equal(inner.endLine, 2);
});

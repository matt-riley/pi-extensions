import { test } from "node:test";
import assert from "node:assert/strict";
import { langForFile, parseFallbackSource } from "../fallback-parser.mjs";

const names = (src, lang) => parseFallbackSource(src, { lang }).map((s) => `${s.name}:${s.kind}`);

test("langForFile maps extensions", () => {
  assert.equal(langForFile("a.ts"), "ts");
  assert.equal(langForFile("a.jsx"), "ts");
  assert.equal(langForFile("a.py"), "py");
  assert.equal(langForFile("a.go"), "go");
  assert.equal(langForFile("a.rs"), "rs");
  assert.equal(langForFile("a.rb"), "rb");
  assert.equal(langForFile("a.java"), "java");
  assert.equal(langForFile("a.kt"), "kt");
  assert.equal(langForFile("a.c"), "c");
  assert.equal(langForFile("a.cpp"), "cpp");
  assert.equal(langForFile("a.md"), "md");
  assert.equal(langForFile("a.json"), "json");
  assert.equal(langForFile("README"), "other");
});

test("python: defs, classes, imports", () => {
  const src = `import os
from pathlib import Path

class Parser:
    def parse(self, text):
        return text

async def main():
    pass`;
  assert.deepEqual(names(src, "py"), [
    "os:import",
    "pathlib:import",
    "Parser:class",
    "parse:function",
    "main:function",
  ]);
});

test("go: funcs, types, imports", () => {
  const src = `package main

import (
    "fmt"
)

type User struct {
    Name string
}

func (u User) Greet() string {
    return "hi"
}

func helper() {}`;
  const ns = names(src, "go");
  assert.ok(ns.includes("User:class"));
  assert.ok(ns.includes("Greet:function"));
  assert.ok(ns.includes("helper:function"));
  assert.ok(ns.includes("main:namespace"));
});

test("rust: fn, struct, enum, trait, mod, use", () => {
  const src = `use std::collections::HashMap;

pub struct Config {
    pub port: u16,
}

pub enum Mode { Fast, Slow }

pub trait Runner {
    fn run(&self);
}

pub fn main() {}`;
  const ns = names(src, "rs");
  assert.ok(ns.includes("Config:class"));
  assert.ok(ns.includes("Mode:enum"));
  assert.ok(ns.includes("Runner:interface"));
  assert.ok(ns.includes("main:function"));
});

test("ruby: def, class, module, require", () => {
  const src = `require "json"

module Util
  class Helper
    def work
    end
  end
end`;
  const ns = names(src, "rb");
  assert.ok(ns.includes("json:import"));
  assert.ok(ns.includes("Util:namespace"));
  assert.ok(ns.includes("Helper:class"));
  assert.ok(ns.includes("work:function"));
});

test("java: class, methods, imports", () => {
  const src = `import java.util.List;

public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }
    private void helper() {}
}`;
  const ns = names(src, "java");
  assert.ok(ns.includes("Calculator:class"));
  assert.ok(ns.includes("add:method"));
  assert.ok(ns.includes("helper:method"));
});

test("kotlin: fun, class, import, package", () => {
  const src = `package com.example

import kotlin.math.abs

class Point(val x: Int, val y: Int)

fun distance(p: Point): Double {
    return abs(p.x).toDouble()
}`;
  const ns = names(src, "kt");
  assert.ok(ns.includes("com.example:namespace"));
  assert.ok(ns.includes("Point:class"));
  assert.ok(ns.includes("distance:function"));
});

test("markdown: headings", () => {
  const src = `# Title
## Section
### Sub
text here`;
  assert.deepEqual(names(src, "md"), ["Title:heading", "Section:heading", "Sub:heading"]);
});

test("generic fallback: keyword declarations and name( patterns", () => {
  const src = `export function foo() {}
class Bar {}
def baz():
    pass
qux()`;
  const ns = names(src, "other");
  assert.ok(ns.includes("foo:decl"));
  assert.ok(ns.includes("Bar:decl"));
  assert.ok(ns.includes("baz:decl"));
  assert.ok(ns.includes("qux:function"));
});

test("fallback symbols carry line numbers and open-ended ranges", () => {
  const syms = parseFallbackSource("def a():\n    pass\n\ndef b():\n    pass", { lang: "py" });
  assert.deepEqual(syms.map((s) => [s.name, s.startLine]), [["a", 1], ["b", 4]]);
  assert.equal(syms[0].endLine, -1); // no reliable range
});

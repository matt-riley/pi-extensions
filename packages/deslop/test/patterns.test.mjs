import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  addedFindings,
  findSlop,
  formatFindings,
  maskNonProse,
  worthReporting,
} from "../patterns.mjs";

const ids = (text) => findSlop(text).map((item) => item.id);

test("plain technical prose carries no findings", () => {
  const text =
    "Run `npm run check` before pushing. It type-checks every entrypoint, lints, " +
    "and runs the tests. A failing step prints the command that failed.";
  assert.deepEqual(findSlop(text), []);
});

test("the high-severity signs from both skills are found, each with its sentence", () => {
  const cases = {
    filler: "It's worth noting that the cache is cleared on restart.",
    contrast: "This is not about speed, it is about reliability.",
    marketing: "A seamless way to search your repository.",
    "generic-opening": "In today's fast-paced digital world, tooling matters.",
    "paired-adjectives": "The parser is simple yet powerful.",
    announce: "We're excited to announce version two.",
    "whether-youre": "Whether you're a beginner or an expert, this works.",
    pivot: "Here's the thing: the config is read once.",
    cliche: "This release moves the needle on startup time.",
  };
  for (const [id, text] of Object.entries(cases)) {
    const found = findSlop(text).find((item) => item.id === id);
    assert.ok(found, `${id} not found in: ${text}`);
    assert.equal(found.severity, "high");
    assert.ok(found.excerpts[0].length > 0);
    assert.ok(worthReporting([found]), `${id} alone should be worth a report`);
  }
});

test("split-sentence and softer contrasts are the same sign", () => {
  assert.ok(ids("It isn't just a linter. It's a formatter too.").includes("contrast"));
  assert.ok(ids("This is less about syntax and more about intent.").includes("contrast"));
  assert.ok(ids("It not only lints but also formats.").includes("contrast"));
});

test("curly apostrophes match the same phrases as straight ones", () => {
  assert.ok(ids("Here’s the thing: it works.").includes("pivot"));
});

test("code, URLs, comments and frontmatter are not prose", () => {
  const text = [
    "---",
    "description: a powerful seamless tool",
    "---",
    "Call `leverage()` to merge the options.",
    "",
    "```js",
    "// it's worth noting this is powerful",
    "const seamless = true;",
    "```",
    "",
    "<!-- game-changing -->",
    "See https://example.com/seamless-powerful for details.",
  ].join("\n");
  assert.deepEqual(findSlop(text), []);
  assert.equal(maskNonProse(text).length, text.length, "masking keeps every offset");
});

test("a word is not flagged inside a longer word or a hyphenated name", () => {
  assert.deepEqual(ids("The overpowerful-lint rule and the delver module."), []);
});

test("em dashes follow the internal-document threshold", () => {
  assert.deepEqual(ids("The cache — once warm — serves every read."), ["em-dash"]);
  assert.deepEqual(ids("pi-drift — notice edits made elsewhere."), []);
  const four = ["One — a.", "Two — b.", "Three — c.", "Four — d."].join("\n\n");
  assert.deepEqual(ids(four), ["em-dash"]);
});

test("counted signs need their minimum before they are a finding", () => {
  assert.deepEqual(ids("This is very fast."), []);
  assert.deepEqual(ids("This is very fast and very small."), ["very"]);
  assert.deepEqual(ids("Perhaps it works. Arguably so."), []);
  assert.ok(ids("Perhaps it works. Arguably so. It seems like it might.").includes("hedging"));
});

test("a run of short punchy sentences is found in prose but not in a list", () => {
  assert.ok(
    ids("We tried caching. It broke. We reverted. Then we measured.").includes("machinegun"),
  );
  assert.deepEqual(ids("- Install it.\n- Run it.\n- Read the log."), []);
});

test("heading emoji and emphasis clusters are found", () => {
  assert.ok(ids("## \u{1F680} Getting started\n\nInstall the package.").includes("emoji"));
  assert.ok(ids("Fast \u{1F525} and shiny \u{2728} output.").includes("emoji"));
});

test("low signs only matter in aggregate", () => {
  const one = findSlop("The “fast” and “small” paths.");
  assert.deepEqual(
    one.map((item) => item.id),
    ["curly-quotes"],
  );
  assert.equal(worthReporting(one), false);
  const three = findSlop(
    "The “fast” and “small” paths are very quick and very small → they quietly win.",
  );
  assert.equal(
    three.every((item) => item.severity === "low"),
    true,
  );
  assert.equal(worthReporting(three), true);
});

test("findings come most severe first", () => {
  const found = findSlop("The “fast” and “small” paths. Moreover, it is a seamless upgrade.");
  assert.deepEqual(
    found.map((item) => item.severity),
    ["high", "medium", "low"],
  );
});

test("an edit is only blamed for the patterns it added", () => {
  const before = "It's worth noting that the cache is cleared on restart.";
  assert.deepEqual(addedFindings(`${before} It holds 100 entries.`, before), []);
  const added = addedFindings(`${before} It is a seamless design.`, before);
  assert.deepEqual(
    added.map((item) => item.id),
    ["marketing"],
  );
  const more = addedFindings(`${before} It's worth noting the limit too.`, before);
  assert.deepEqual(
    more.map((item) => item.id),
    ["filler"],
  );
});

test("each finding is one bullet naming the sign, the sentence and the fix", () => {
  const text = formatFindings(findSlop("A seamless way to search."));
  assert.equal(
    text,
    '- marketing adjective (W5, high): "A seamless way to search.". Fix: replace it with the specific, factual description.',
  );
});

test("findSlop stays fast on a huge code block and on unclosed comments", () => {
  const block = "```\n" + "x\n".repeat(95_000) + "```\nDone.\n";
  const unclosed = "<!-- ".repeat(40_000);
  for (const text of [block, unclosed, "\n \n".repeat(65_000)]) {
    const start = performance.now();
    findSlop(text);
    assert.ok(performance.now() - start < 1_000, "scan took longer than a second");
  }
});

test("the detector's README quotes examples without flagging itself", async () => {
  const text = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.deepEqual(findSlop(text), []);
});

test("documentation labels, table examples and prohibitions are not formula prose", () => {
  const label = findSlop("The cache — once warm — shows “Ready”.");
  assert.deepEqual(
    label.map((item) => item.id),
    ["em-dash"],
  );
  assert.equal(worthReporting(label), false);
  assert.deepEqual(ids("Choose “Ready” → “Run”."), ["curly-quotes"]);
  assert.deepEqual(ids("| Example | Meaning |\n| seamless | marketing |"), []);
  assert.deepEqual(ids("Do not edit files. Do not implement. Do not run commands."), []);
});

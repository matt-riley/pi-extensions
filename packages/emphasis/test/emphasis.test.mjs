import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_WORDS,
  VOCABULARY,
  createPalette,
  decorate,
  replyGuidance,
  toneOf,
} from "../emphasis.mjs";

const ESC = "\u001b";

// A theme whose colors are readable tags, so tests can assert on what was colored.
const theme = {
  fg: (color, text) => `<${color}>${text}</>`,
  getFgAnsi: (color) => `${ESC}[38;fg-${color}m`,
  getBgAnsi: (color) => `${ESC}[48;bg-${color}m`,
};

/** Drop every ESC[...m sequence without a control-character regex. */
function stripSgr(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ESC && text[i + 1] === "[") {
      const end = text.indexOf("m", i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    out += text[i];
  }
  return out;
}

const render = (text, options) => decorate(text, createPalette(theme, options));
const plain = (text, options) =>
  stripSgr(render(text, options)).replace(/[]/g, "|").replaceAll(" ", " ");

describe("pill tone", () => {
  const cases = [
    ["Failed", "error"],
    ["Blocked", "error"],
    ["Needs you", "warning"],
    ["Decision", "warning"],
    ["Attempted", "warning"],
    ["Unknown", "warning"],
    ["Done", "success"],
    ["Observed", "success"],
    ["Costs money", "danger"],
    ["Irreversible", "danger"],
    ["Implement", "mode"],
    ["Shared", "owner"],
    ["Inferred", "neutral"],
    ["Anything else", "neutral"],
  ];
  for (const [word, tone] of cases)
    test(`${word} is ${tone}`, () => assert.equal(toneOf(word), tone));

  test("case and spacing do not matter", () => assert.equal(toneOf("  needs   YOU "), "warning"));
  test("a known word may carry detail", () => {
    assert.equal(toneOf("Passed 12/12"), "success");
    assert.equal(toneOf("Failed: 3 tests"), "error");
    assert.equal(toneOf("Passed on CI"), "success");
  });
  test("a longer word that starts like a known one is not that word", () =>
    assert.equal(toneOf("Donezo"), "neutral"));
});

describe("pills", () => {
  test("a known word gets its icon", () => assert.equal(plain("[[Done]]"), "| Done|"));
  test("an unknown word has no icon", () =>
    assert.equal(plain("[[Anything else]]"), "|Anything else|"));
  test("synonyms display as one word and keep their detail", () => {
    assert.equal(plain("[[Completed]]"), "| Done|");
    assert.equal(plain("[[Fail: 3 tests]]"), "| Failed: 3 tests|");
    assert.equal(plain("[[unknown]]"), "| Unverified|");
  });
  test("a label's own glyph wins over the table's", () =>
    assert.equal(plain("[[ Done]]"), "| Done|"));
  test("labels over 32 characters are left alone", () => {
    const long = `[[${"x".repeat(33)}]]`;
    assert.equal(plain(long), long);
  });
  test("a two-word pill cannot wrap", () => assert.match(render("[[Needs you]]"), /Needs you/));
  test("a pill is colored by its tone's panel color", () =>
    assert.match(render("[[Failed]]"), /bg-toolErrorBg/));
  test("square chips are padded instead of capped", () =>
    assert.equal(plain("[[Done]]", { roundCaps: false }), "  Done "));
  test("a theme with no panel colors draws reverse video", () => {
    const bare = { ...theme, getBgAnsi: () => `${ESC}[49m` };
    const out = decorate("[[Done]]", createPalette(bare));
    assert.ok(out.includes(`${ESC}[38;fg-successm${ESC}[7m`));
  });
  test("a theme without ANSI accessors leaves pills as typed", () => {
    const out = decorate("[[Done]] **x**", createPalette({ fg: theme.fg }));
    assert.equal(out, "[[Done]] **<mdLink>x</>**");
  });
  test("a pill inside bold restores the bold color after it", () => {
    const out = render("**a [[Done]] b**");
    assert.ok(out.includes(`${ESC}[38;bg-toolSuccessBgm${ESC}[39m${ESC}[1m<mdLink>`));
  });
});

describe("labels", () => {
  test("a heading takes an icon from its word", () =>
    assert.equal(plain("## Finding"), "##  Finding"));
  test("an unknown heading is untouched", () =>
    assert.equal(plain("## What happened"), "## What happened"));
  test("a leading bold label takes an icon, after list markers and tree connectors", () => {
    assert.equal(plain("**Cause:** x"), "**<mdLink> Cause:</>** x");
    assert.equal(plain("- **Fix:** x"), "- **<mdLink> Fix:</>** x");
    assert.equal(plain("  ├── **Risk:** x"), "  <dim>├──</> **<mdLink> Risk:</>** x");
  });
  test("bold later in a line gets color but no icon", () =>
    assert.equal(plain("see **Cause** here"), "see **<mdLink>Cause</>** here"));
});

describe("action lead-ins", () => {
  test("take an icon anywhere in a line when they end in a colon", () => {
    assert.equal(
      plain("[[Unverified]] red pills. **Check:** run it"),
      "| Unverified| red pills. **<mdLink> Check:</>** run it",
    );
    assert.equal(plain("- **Unblock:** access"), "- **<mdLink> Unblock:</>** access");
  });
  test("get exactly one icon at the start of a line", () =>
    assert.equal(plain("**Next:** go"), "**<mdLink> Next:</>** go"));
  test("without a colon they are ordinary bold", () =>
    assert.equal(
      plain("please **do** it and **run** that"),
      "please **<mdLink>do</>** it and **<mdLink>run</>** that",
    ));
});

describe("what is left alone", () => {
  test("fenced code, until the fence closes", () => {
    const block = "```\n**Cause:** → [[Done]]\n```";
    assert.equal(plain(block), block);
    assert.equal(
      plain("~~~~\n[[Done]]\n~~~\n~~~~\n[[Done]]"),
      "~~~~\n[[Done]]\n~~~\n~~~~\n| Done|",
    );
  });
  test("inline code", () => assert.equal(plain("`[[Done]] → **x**`"), "`[[Done]] → **x**`"));
  test("escaped asterisks", () =>
    assert.equal(plain("\\*\\*not bold\\*\\*"), "\\*\\*not bold\\*\\*"));
  test("an unclosed bold span ends its color at the line end", () =>
    assert.equal(plain("**still streaming"), "**<mdLink>still streaming</>"));
});

test("arrows, checks and crosses take their colors", () => {
  assert.equal(plain("a → b ✓ c ✗"), "a <accent>→</> b <success>✓</> c <error>✗</>");
});

test("icons can be turned off", () => {
  assert.equal(plain("[[Done]]", { icons: false }), "|Done|");
  assert.equal(plain("## Finding", { icons: false }), "## Finding");
  assert.equal(plain("x **Check:** y", { icons: false }), "x **<mdLink>Check:</>** y");
});

test("the bold color is configurable", () =>
  assert.equal(plain("**x**", { boldColor: "accent" }), "**<accent>x</>**"));

describe("reply guidance", () => {
  const text = replyGuidance();
  test("names every core word, and each one is colored as its tone", () => {
    for (const [tone, words] of Object.entries(VOCABULARY)) {
      for (const word of words.core) {
        assert.ok(text.includes(`[[${word}]]`), word);
        assert.equal(toneOf(word), tone);
      }
    }
    for (const word of CONTEXT_WORDS) assert.ok(text.includes(`[[${word}]]`), word);
  });
  test("every pill it mentions is a known word, so no example teaches an uncolored one", () => {
    const known = [...Object.values(VOCABULARY).flatMap((w) => w.core), ...CONTEXT_WORDS, "Word"];
    for (const [, label] of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
      assert.ok(
        known.some((k) => label === k || label.startsWith(`${k} `) || label.startsWith(`${k}:`)),
        label,
      );
    }
  });
  test("every lead-in it lists gets an icon", () => {
    for (const word of ["Check", "Do", "Next", "Unblock", "Left", "Run", "Guard", "Undo", "See"]) {
      assert.ok(text.includes(`**${word}:**`), word);
      assert.notEqual(plain(`x **${word}:** y`), `x **<mdLink>${word}:</>** y`);
    }
  });
  test("separates local and CI evidence", () =>
    assert.match(text, /a local pass never stands for a CI pass\./));
  test("keeps pills out of commits and pull requests", () =>
    assert.match(
      text,
      /Keep pills out of paths, commands, code, literal output, files, commit messages, pull request text/,
    ));
});

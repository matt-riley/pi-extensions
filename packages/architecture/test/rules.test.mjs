import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRules } from "../rules.mjs";

const parse = (value) => parseRules(typeof value === "string" ? value : JSON.stringify(value));

test("a rules file with forbid and except parses into rules", () => {
  const { rules, errors, cycles, ignore } = parse({
    version: 1,
    ignore: ["**/test/**"],
    cycles: "report",
    rules: [
      {
        name: "islands",
        from: "packages/*/**",
        forbid: "packages/**",
        except: ["packages/$1/**"],
        reason: "packages do not reach into each other",
      },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(cycles, "report");
  assert.deepEqual(ignore, ["**/test/**"]);
  assert.deepEqual(rules, [
    {
      name: "islands",
      from: "packages/*/**",
      forbid: ["packages/**"],
      except: ["packages/$1/**"],
      reason: "packages do not reach into each other",
    },
  ]);
});

test("cycles default to report and can be turned off", () => {
  assert.equal(parse({ rules: [] }).cycles, "report");
  assert.equal(parse({ rules: [], cycles: "off" }).cycles, "off");
  assert.match(parse({ rules: [], cycles: "sometimes" }).errors.join("\n"), /cycles/);
});

test("invalid JSON is one error and no rules, not a throw", () => {
  const result = parse("{ nope");
  assert.equal(result.rules.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /not valid JSON/);
});

test("typos are errors, so a rule never silently does nothing", () => {
  const messages = parse({
    rules: [
      { name: "a", from: "x/**", forbid: ["y/**"], forbids: ["z/**"] },
      { from: "x/**", forbid: ["y/**"] },
      { name: "a", from: "x/**", forbid: ["y/**"] },
      { name: "c", from: "x/**" },
      { name: "d", from: "x/**", forbid: ["y/$2"] },
      { name: "e", from: "x/**", forbid: [7] },
    ],
    extra: true,
  }).errors.join("\n");
  assert.match(messages, /unknown key "extra"/);
  assert.match(messages, /rules\[0\].*unknown key "forbids"/);
  assert.match(messages, /rules\[1\].*name/);
  assert.match(messages, /rules\[2\].*duplicate rule name "a"/);
  assert.match(messages, /rules\[3\].*forbid/);
  assert.match(messages, /rules\[4\].*\$2/);
  assert.match(messages, /rules\[5\].*forbid/);
});

test("a rule with an error is left out and the others still apply", () => {
  const { rules, errors } = parse({
    rules: [
      { name: "good", from: "a/**", forbid: ["b/**"] },
      { name: "bad", from: "a/**" },
    ],
  });
  assert.deepEqual(
    rules.map((rule) => rule.name),
    ["good"],
  );
  assert.equal(errors.length, 1);
});

test("the top level must be an object with a rules array", () => {
  assert.match(parse("[]").errors.join(), /object/);
  assert.match(parse({}).errors.join(), /rules/);
});

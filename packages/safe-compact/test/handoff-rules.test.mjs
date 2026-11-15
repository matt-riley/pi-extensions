// The handoff's fixed rules, checked on what a reader of the summary sees: a
// user's safety rule survives a low Jev score, text the agent wrote never
// passes for the user, an unfinished task never reads as finished, and the
// rules from earlier handoffs are not lost by compacting again.

import { test } from "node:test";
import assert from "node:assert/strict";

import { composeHandoff } from "../plan.mjs";
import { isStandingRule } from "../handoff-rules.mjs";

const noul = (value) => ({ type: "noul", noul: value });

/** Canned Jev that scores every segment as unimportant, so only code rules can keep anything. */
function lowScoreAsk() {
  return async ({ state, questions }) => {
    if ("disposition" in questions) {
      const unresolved = state.segment.text.includes("OPENPROBLEM");
      return {
        answers: {
          load_bearing: noul(0.05),
          user_constraint: noul(0.02),
          decision: noul(state.segment.text.includes("DECIDED") ? 0.9 : 0.02),
          unresolved: noul(unresolved ? 0.9 : 0.02),
          recoverable: noul(0.1),
          disposition: { type: "choice", choice: "drop", confidence: 0.9 },
        },
      };
    }
    if ("rating" in questions) return { answers: { rating: noul(0.5) } };
    if ("faithful" in questions) return { answers: { faithful: noul(0.9) } };
    return { answers: { covered: noul(0.9) } };
  };
}

const user = (text) => ({ role: "user", content: text });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

const compose = (messages, extra = {}) =>
  composeHandoff({ messages, tokensBefore: 100000, ask: lowScoreAsk(), ...extra });

const section = (summary, title) =>
  summary.match(new RegExp(`## ${title}[^\\n]*\\n([\\s\\S]*?)(\\n\\n## |$)`))?.[1];

test("isStandingRule recognises a prohibition or an ask-first rule about a risky action", () => {
  for (const text of [
    "Never force-push to main",
    "do not delete anything without asking me first",
    "Don't push to the default branch.",
    "You must not print the API key or any credentials",
    "ask before you deploy to production",
    "Nothing is sent or posted on my behalf without my say-so",
    "no spending without approval",
  ]) {
    assert.equal(isStandingRule(text), true, text);
  }
});

test("isStandingRule leaves ordinary asks and style preferences alone", () => {
  for (const text of [
    "please fix the retry logic",
    "don't worry about the formatting",
    "never mind, carry on",
    "use tabs, never spaces",
    "delete the unused import",
    "",
  ]) {
    assert.equal(isStandingRule(text), false, text);
  }
});

test("a safety rule the user stated is carried word for word, whatever Jev scored it", async () => {
  const rule = "Never force-push to main, and ask me before you delete any branch.";
  const result = await compose([
    user("first, fix the retry logic"),
    assistant("on it"),
    user(rule),
    assistant("noted"),
    user("now run the tests"),
    user("and then the linter"),
  ]);
  assert.ok(result);
  assert.match(section(result.summary, "Standing rules") ?? "", /^- Never force-push to main/m);
  assert.ok(result.summary.includes(rule), "exact words present");
});

test("a safety rule is not cut down to one line, even in the newest messages", async () => {
  const rule = `Never touch production. ${"Check twice before any deploy. ".repeat(40)}`;
  const result = await compose([user("start"), user(rule.trim())]);
  assert.ok(result);
  assert.ok(result.summary.includes(rule.trim()), "the rule is whole, not a 600-character line");
});

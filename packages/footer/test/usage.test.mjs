import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUsage, formatUsage, installUsage } from "../usage.mjs";

const message = (data) => ({ type: "message", message: data });
const assistant = (data) =>
  message({ role: "assistant", provider: "fixture", model: "base", ...data });

test("usage groups physical models and separates fresh input from cached tokens", () => {
  const report = summarizeUsage([
    message({ role: "user", content: "Private prompt" }),
    assistant({
      usage: { input: 100, output: 30, cacheRead: 400, cacheWrite: 20, cost: { total: 0.02 } },
    }),
    assistant({
      usage: { input: 50, output: 10, cacheRead: 500, cacheWrite: 0, cost: { total: 0 } },
    }),
    assistant({
      model: "frontier",
      usage: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
    }),
    { type: "custom", customType: "usage-report", data: { input: 99999 } },
  ]);
  assert.equal(report.requests, 3);
  assert.deepEqual(report.models[0], {
    model: "fixture/base",
    requests: 2,
    input: 150,
    output: 40,
    cacheRead: 900,
    cacheWrite: 20,
    missingTokenFields: 0,
    cost: 0.02,
    missingCosts: 0,
    zeroCosts: 1,
  });
  assert.equal(report.models[1].model, "fixture/frontier");
  assert.equal(report.models[1].cost, 0.1);
  assert.doesNotMatch(JSON.stringify(report), /Private prompt|99999/);
});

test("missing, negative and nonfinite costs remain unknown; zero is labelled separately", () => {
  const report = summarizeUsage([
    assistant({}),
    assistant({ usage: { input: -1, output: Infinity, cacheRead: "400", cost: { total: -2000 } } }),
    assistant({ usage: { cost: { total: NaN } } }),
  ]);
  assert.equal(report.models[0].cost, null);
  assert.equal(report.models[0].missingCosts, 3);
  assert.equal(report.models[0].missingTokenFields, 12);
  assert.equal(report.models[0].input, 0);
  assert.match(formatUsage(report), /Reported cost: unknown/);
  assert.match(formatUsage(report), /missing and zero costs do not prove free usage/);
});

test("tool results are correlated by id; failed and unfinished calls remain visible", () => {
  const report = summarizeUsage([
    assistant({
      content: [
        { type: "toolCall", id: "a", name: "bash", arguments: { command: "SECRET" } },
        { type: "toolCall", id: "b", name: "bash" },
        { type: "toolCall", id: "c", name: "read" },
      ],
    }),
    message({ role: "toolResult", toolCallId: "b", isError: true, content: "SECRET RESULT" }),
    message({ role: "toolResult", toolCallId: "a", isError: false }),
    message({ role: "toolResult", toolCallId: "unrelated", isError: true }),
  ]);
  assert.deepEqual(report.tools, [
    { name: "bash", calls: 2, failed: 1, pending: 0 },
    { name: "read", calls: 1, failed: 0, pending: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test("usage is recomputed after tree navigation and never starts an agent turn", () => {
  let command,
    branch = [assistant({})];
  const messages = [],
    notices = [];
  installUsage({
    registerCommand: (_name, definition) => {
      command = definition;
    },
    sendMessage: (...args) => messages.push(args),
  });
  const ctx = {
    sessionManager: { getBranch: () => branch },
    ui: { notify: (...args) => notices.push(args) },
  };
  command.handler("--json", ctx);
  assert.equal(JSON.parse(messages[0][0].content).requests, 1);
  assert.deepEqual(messages[0][1], { triggerTurn: false, deliverAs: "followUp" });
  branch = [];
  command.handler("", ctx);
  assert.match(messages[1][0].content, /No assistant requests/);
  command.handler("--all", ctx);
  command.handler("", { ui: ctx.ui });
  assert.equal(messages.length, 2);
  assert.match(notices[0][0], /Usage: \/usage/);
  assert.match(notices[1][0], /unavailable/);
});

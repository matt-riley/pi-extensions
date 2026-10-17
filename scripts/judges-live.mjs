#!/usr/bin/env node
// judges-live.mjs — one real request per judgment path, fixtures in code.
//
// The unit tests prove the wiring; this proves the wire. It is not part of
// `npm run check`, because every run costs real TypeSafe requests: it is the
// check to run after changing a question set, a state shape or a threshold.
//
//   node scripts/judges-live.mjs            # all of them
//   node scripts/judges-live.mjs --only ci  # one
//
// Exit 0 when every case reached its judge. The answers printed are a model's
// reading of a fixture, not ground truth; what this checks is that the state
// validates, the request lands, and the router produces something usable.

import { answerFromPage } from "../packages/web-fetch/answer.mjs";
import { reviewPlan } from "../packages/plan-mode/plan-review.mjs";
import { verifyFindings } from "../packages/review/findings.mjs";
import { lintChange } from "../packages/review/lint.mjs";
import { classifyCi } from "./ci-triage.mjs";
import { promoteCorrections } from "./promote-corrections.mjs";

const TICK = String.fromCharCode(96);
const NL = String.fromCharCode(10);

const DIFF = [
  "diff --git a/src/loader.mjs b/src/loader.mjs",
  "@@ -10,3 +10,6 @@",
  " export function load(path) {",
  "-  return fs.readFileSync(path, 'utf8');",
  "+  const text = fs.readFileSync(path, 'utf8');",
  "+  console.log('[DEBUG-load]', path);",
  "+  return text;",
  " }",
  "",
].join(NL);

const CASES = {
  "review lint": async () => {
    const result = await lintChange({
      diff: DIFF,
      files: ["src/loader.mjs"],
      message: "fix: read the loader file",
      task: "make the loader read the file",
    });
    return {
      judged: result.judged,
      summary:
        (result.findings ?? [])
          .map((item) => item.id + " " + Number(item.probability).toFixed(2))
          .join(", ") || "no finding",
    };
  },
  "review findings": async () => {
    const result = await verifyFindings({
      findings: [
        "The debug log prints every path to stdout (" +
          TICK +
          "console.log('[DEBUG-load]', path)" +
          TICK +
          ").",
        "The quote " + TICK + "retry(3)" + TICK + " is not in this diff at all.",
      ],
      diff: DIFF,
    });
    return {
      judged: result.judged,
      summary:
        result.kept.length +
        " kept, " +
        result.dropped.length +
        " dropped (" +
        result.dropped.map((item) => item.reason).join("; ") +
        ")",
    };
  },
  "web answer": async () => {
    const result = await answerFromPage({
      url: "https://example.test/retries",
      question: "How many times does the uploader retry?",
      text:
        "## Uploads" +
        NL +
        NL +
        "The uploader does not retry a failed upload; it surfaces the error to the caller." +
        NL +
        NL +
        "## Configuration" +
        NL +
        NL +
        "Retries are configured in config.toml.",
    });
    return {
      judged: result.answered !== null,
      summary:
        result.verdict +
        " (answered " +
        Number(result.answered).toFixed(2) +
        "), " +
        result.spans.length +
        " span(s)",
    };
  },
  "plan review": async () => {
    const result = await reviewPlan({
      plan:
        "## Steps" +
        NL +
        NL +
        "- Add a cache layer between the loader and the store." +
        NL +
        "- Rename config.timeout to config.deadline, updating its two callers in src/cli.mjs.",
    });
    return {
      judged: result.judged,
      summary: result.judged
        ? (result.missingVerification ?? []).length +
          " step(s) without verification, " +
          (result.missingCallers ?? []).length +
          " without callers"
        : result.reason,
    };
  },
  "ci triage": async () => {
    const result = await classifyCi({
      step: "npm run check",
      log:
        "not ok 3 - writes the file" +
        NL +
        "  Error: expected 1, got 2 at test/write.test.mjs:12" +
        NL +
        "# fail 1",
      reruns: 1,
    });
    return {
      judged: result.judged,
      summary: result.judged
        ? result.kind + " " + Number(result.confidence).toFixed(2)
        : result.reason,
    };
  },
  promotion: async () => {
    const result = await promoteCorrections({
      corrections: [
        { correction: "printed the commands instead of running them, again", occurrences: 3 },
      ],
      guidance:
        "AGENTS.md: When asked to commit or push, run the commands — never reply with example commands as a substitute.",
    });
    const row = result.rows?.[0];
    return {
      judged: result.judged,
      summary: row?.promotion
        ? row.promotion +
          (typeof row.covered === "number" ? ", already covered " + row.covered.toFixed(2) : "")
        : (result.reason ?? "no promotion"),
    };
  },
};

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
const names = Object.keys(CASES).filter((name) => !only || name.includes(only));
if (names.length === 0) {
  console.error("judges-live: no case matches " + only + "; try " + Object.keys(CASES).join(", "));
  process.exitCode = 2;
} else {
  let failed = 0;
  for (const name of names) {
    try {
      const result = await CASES[name]();
      if (!result.judged) failed += 1;
      console.log((result.judged ? "ok   " : "FAIL ") + name + " — " + result.summary);
    } catch (error) {
      failed += 1;
      console.log(
        "FAIL " + name + " — " + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  console.log(
    failed === 0
      ? "all " + names.length + " judgments reached their judge"
      : failed + " of " + names.length + " did not reach a judgment",
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

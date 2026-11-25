import { test } from "node:test";
import assert from "node:assert/strict";

import piDeslopExtension from "../index.ts";
import { reviewBranch } from "../codeslop.mjs";
import { findLoweredBar } from "../lowered.mjs";
import { formatFindings } from "../patterns.mjs";

/** A diff for one file. Lines start with "+" added, " " context or "-" removed. */
function diffOf(file, lines, mode = "") {
  const count = (marks) => lines.filter((line) => marks.includes(line[0])).length;
  const gone = mode === "deleted";
  return [
    `diff --git a/${file} b/${file}`,
    ...(gone ? ["deleted file mode 100644"] : []),
    `--- a/${file}`,
    `+++ ${gone ? "/dev/null" : `b/${file}`}`,
    `@@ -1,${count(" -")} +${gone ? "0,0" : `1,${count(" +")}`} @@`,
    ...lines,
    "",
  ].join("\n");
}
const added = (file, ...lines) =>
  diffOf(
    file,
    lines.map((line) => `+${line}`),
  );
const removed = (file, ...lines) =>
  diffOf(
    file,
    lines.map((line) => `-${line}`),
  );
/** The findings of one diff as "id/severity" pairs. */
const kinds = (diff, messages) =>
  findLoweredBar(diff, messages).map((item) => `${item.id}/${item.severity}`);

// Fixture lines are built from parts so this file does not itself carry a directive.
const SUPPRESSIONS = {
  "src/a.ts": [
    ["// @ts", "-ignore"].join(""),
    ["// @ts", "-expect-error"].join(""),
    ["/* eslint", "-disable no-console */"].join(""),
    ["const n = x as number; // eslint", "-disable-line no-undef"].join(""),
    ["/* istanbul", " ignore next */"].join(""),
    ["// c8", " ignore next 3"].join(""),
    ["// nosemgrep", ": rule-id"].join(""),
    ["const k = 'abc'; // gitleaks", ":allow"].join(""),
  ],
  "tool.py": [
    ["import os  # no", "qa: F401"].join(""),
    ["x = f()  # type", ": ignore[attr-defined]"].join(""),
    ["y = 1  # nosemgrep", ""].join(""),
    ["if x:  # pragma", ": no cover"].join(""),
  ],
  "main.go": [["_ = f() //no", "lint:errcheck"].join(""), ["_ = g() // no", "lint"].join("")],
  "lib.rs": [["#[al", "low(dead_code)]"].join(""), ["#![al", "low(unused)]"].join("")],
  ".github/workflows/ci.yml": [["      - run: ./scan.sh # gitleaks", ":allow"].join("")],
};

test("a new suppression directive is a strong flag in every language it is written in", () => {
  for (const [file, lines] of Object.entries(SUPPRESSIONS))
    for (const line of lines) {
      const found = findLoweredBar(added(file, line));
      assert.deepEqual(
        found.map((item) => [item.id, item.severity, item.sign]),
        [["suppression", "high", "lowered-bar"]],
        `${file}: ${line}`,
      );
      assert.ok(found[0].excerpts[0].startsWith(`${file}:1: `), found[0].excerpts[0]);
    }
});

test("a reason on the same line or an adjacent comment downgrades the flag to weak", () => {
  const ts = ["// @ts", "-expect-error: upstream typings declare this as a string"].join("");
  assert.deepEqual(kinds(added("src/a.ts", ts)), ["suppression/low"]);
  const lint = ["/* eslint", "-disable-next-line no-console -- the CLI prints its result */"].join(
    "",
  );
  assert.deepEqual(kinds(added("src/a.ts", lint)), ["suppression/low"]);
  const bare = ["// eslint", "-disable-next-line no-console"].join("");
  const above = added("src/a.ts", "// the worker has no logger to hand until it boots", bare);
  assert.deepEqual(kinds(above), ["suppression/low"]);
  const below = added("src/a.ts", bare, "// stdout is the interface of this tool");
  assert.deepEqual(kinds(below), ["suppression/low"]);
  const far = added(
    "src/a.ts",
    "// the worker has no logger to hand until it boots",
    "const a = 1;",
    bare,
  );
  assert.deepEqual(kinds(far), ["suppression/high"]);
});

test("a rule name or a code after the directive is not a reason", () => {
  for (const [file, line] of [
    ["a.ts", ["// eslint", "-disable-next-line no-console, no-undef, prefer-const"].join("")],
    ["a.py", ["import os  # no", "qa: F401"].join("")],
    ["a.ts", ["// @ts", "-ignore TS2322"].join("")],
  ])
    assert.deepEqual(kinds(added(file, line)), ["suppression/high"], line);
});

test("a directive that is only text, a string or an old line is not a new suppression", () => {
  const mention = ["// we do not use @ts", "-ignore here; fix the type instead"].join("");
  assert.deepEqual(kinds(added("src/a.ts", mention)), []);
  const quoted = `const sample = "${["// @ts", "-ignore"].join("")}";`;
  assert.deepEqual(kinds(added("src/a.ts", quoted)), []);
  const prose = ["Use # no", "qa to silence a line."].join("");
  assert.deepEqual(kinds(added("docs/guide.md", prose)), []);
  const old = diffOf("src/a.ts", [`-${["// @ts", "-ignore"].join("")}`, " const kept = 1;"]);
  assert.deepEqual(kinds(old), []);
  const context = diffOf("src/a.ts", [` ${["// @ts", "-ignore"].join("")}`, "+const next = 1;"]);
  assert.deepEqual(kinds(context), []);
});

test("a clean diff produces no flags", () => {
  const clean = [
    added("src/a.ts", "export const total = (items: number[]) => items.length;"),
    added("tool.py", "def total(items):", "    return len(items)"),
    added("src/b.rs", "#[derive(Debug)]", "struct Row;"),
  ].join("\n");
  assert.deepEqual(findLoweredBar(clean), []);
  assert.deepEqual(findLoweredBar(""), []);
  assert.deepEqual(findLoweredBar(undefined), []);
});

test("a skipped or focused test is a strong flag in each language", () => {
  const cases = {
    "src/a.test.ts": [
      "it.skip('adds', () => {});",
      "describe.only('suite', () => {});",
      "xit('adds', () => {});",
      "xdescribe('suite', () => {});",
      "test.skip('adds', () => {});",
    ],
    "test/b.test.mjs": ["test('adds', { skip: true }, () => {});", "  t.skip();"],
    "pkg/c_test.go": ["\tt.Skip()", "\tt.SkipNow()"],
    "src/lib.rs": ["#[ignore]", '    #[ignore = "slow"]'],
    "tests/test_d.py": ["@pytest.mark.skip", "    pytest.skip()"],
  };
  for (const [file, lines] of Object.entries(cases))
    for (const line of lines)
      assert.deepEqual(kinds(added(file, line)), ["easier-test/high"], `${file}: ${line}`);
});

test("a skip with a stated reason is weak, and a test name is not a reason", () => {
  assert.deepEqual(kinds(added("pkg/c_test.go", '\tt.Skip("flaky on the shared CI runners")')), [
    "easier-test/low",
  ]);
  assert.deepEqual(kinds(added("pkg/c_test.go", '\tt.Skip("flaky")')), ["easier-test/high"]);
  assert.deepEqual(
    kinds(added("src/a.test.ts", "it.skip('handles an empty list with no items', () => {});")),
    ["easier-test/high"],
  );
  const commented = added(
    "src/a.test.ts",
    "// waits on the upstream fix for the timer mock",
    "it.skip('adds', () => {});",
  );
  assert.deepEqual(kinds(commented), ["easier-test/low"]);
});

test("a skip call outside a test file, in a string or in a comment is not flagged", () => {
  assert.deepEqual(kinds(added("src/queue.ts", "queue.skip(count);")), []);
  assert.deepEqual(kinds(added("src/a.test.ts", "const fixture = \"it.skip('x')\";")), []);
  assert.deepEqual(kinds(added("src/a.test.ts", "// never use it.skip here")), []);
  assert.deepEqual(kinds(removed("src/a.test.ts", "it.skip('adds', () => {});")), []);
});

test("a deleted test file is a strong flag, unless the code it tests went with it", () => {
  const gone = diffOf("src/parse.test.ts", ["-assert.equal(parse('1'), 1);"], "deleted");
  assert.deepEqual(kinds(gone), ["easier-test/high"]);
  const goneGo = diffOf("pkg/parse_test.go", ["-func TestParse(t *testing.T) {}"], "deleted");
  assert.deepEqual(kinds(goneGo), ["easier-test/high"]);
  const source = diffOf("src/parse.ts", ["-export const parse = () => 1;"], "deleted");
  assert.deepEqual(kinds(`${gone}\n${source}`), []);
  const other = diffOf("src/other.ts", ["-export const other = 1;"], "deleted");
  assert.deepEqual(kinds(`${gone}\n${other}`), ["easier-test/high"]);
});

test("assertions removed from a test file that stays are a strong flag", () => {
  const stripped = diffOf("src/a.test.ts", [
    " test('adds', () => {",
    "-  assert.equal(add(1, 2), 3);",
    "-  assert.equal(add(2, 2), 4);",
    "+  add(1, 2);",
    " });",
  ]);
  const found = findLoweredBar(stripped);
  assert.deepEqual(
    found.map((item) => `${item.id}/${item.severity}`),
    ["easier-test/high"],
  );
  assert.match(found[0].excerpts[0], /^src\/a\.test\.ts:\d+: .*assert/);
  const pytest = diffOf("tests/test_a.py", [
    " def test_add():",
    "-    assert add(1, 2) == 3",
    "+    add(1, 2)",
  ]);
  assert.deepEqual(kinds(pytest), ["easier-test/high"]);
});

test("an assertion reworded, moved or traded one for one is not removed", () => {
  const reworded = diffOf("src/a.test.ts", [
    "-  assert.equal(add(1, 2), 3);",
    "+  assert.deepEqual(add(1, 2), 3);",
  ]);
  assert.deepEqual(kinds(reworded), []);
  const grown = diffOf("src/a.test.ts", [
    "-  assert.equal(add(1, 2), 3);",
    "+  assert.equal(add(1, 2), 3);",
    "+  assert.equal(add(2, 2), 4);",
  ]);
  assert.deepEqual(kinds(grown), []);
});

test("a whole test case removed with its assertions is weak, not strong", () => {
  const dropped = diffOf("src/a.test.ts", [
    "-test('adds', () => {",
    "-  assert.equal(add(1, 2), 3);",
    "-});",
    " test('keeps', () => {",
    "   assert.ok(true);",
    " });",
  ]);
  assert.deepEqual(kinds(dropped), ["easier-test/low"]);
});

test("a clean test change produces no flags", () => {
  const clean = diffOf("src/a.test.ts", [
    "+test('subtracts', () => {",
    "+  assert.equal(sub(3, 1), 2);",
    "+});",
  ]);
  assert.deepEqual(findLoweredBar(clean), []);
});

test("a fixed sleep or wait in a test is a strong flag", () => {
  const cases = {
    "src/a.test.ts": [
      "  await new Promise((resolve) => setTimeout(resolve, 1000));",
      "  await setTimeout(500);",
      "  await sleep(1000);",
      "  await delay(10);",
      "  await page.waitForTimeout(500);",
      "  cy.wait(1000);",
    ],
    "tests/test_a.py": ["    time.sleep(0.5)", "    await asyncio.sleep(1)"],
    "pkg/a_test.go": ["\ttime.Sleep(time.Second)"],
    "src/a_test.rs": ["    std::thread::sleep(Duration::from_millis(50));"],
  };
  for (const [file, lines] of Object.entries(cases))
    for (const line of lines)
      assert.deepEqual(kinds(added(file, line)), ["flake-mask/high"], `${file}: ${line}`);
});

test("a test retry or a raised test timeout is a strong flag", () => {
  const cases = {
    "src/a.test.ts": [
      "test('adds', { retry: 3 }, () => {});",
      "test('adds', { timeout: 30_000 }, () => {});",
      "jest.setTimeout(60000);",
      "jest.retryTimes(3);",
      "  this.timeout(10000);",
      "  this.retries(2);",
    ],
    "jest.config.ts": ["  testTimeout: 30_000,"],
    "tests/test_a.py": ["@pytest.mark.flaky(reruns=3)"],
  };
  for (const [file, lines] of Object.entries(cases))
    for (const line of lines)
      assert.deepEqual(kinds(added(file, line)), ["flake-mask/high"], `${file}: ${line}`);
  const raised = diffOf("src/a.test.ts", [
    "-test('adds', { timeout: 1000 }, () => {});",
    "+test('adds', { timeout: 30_000 }, () => {});",
  ]);
  const found = findLoweredBar(raised);
  assert.deepEqual(kinds(raised), ["flake-mask/high"]);
  assert.match(found[0].excerpts[0], /timeout: 1000 -> 30000/);
});

test("a reason next to a sleep, retry or timeout downgrades the flag to weak", () => {
  const sleep = added(
    "src/a.test.ts",
    "// the subject under test is the timer itself",
    "  await sleep(1, signal);",
  );
  assert.deepEqual(kinds(sleep), ["flake-mask/low"]);
  assert.deepEqual(
    kinds(
      added(
        "src/a.test.ts",
        "test('adds', { retry: 3 }, () => {}); // until the upstream race is fixed",
      ),
    ),
    ["flake-mask/low"],
  );
});

test("a sleep, retry or timeout outside a test, in a string, or tightened is not flagged", () => {
  assert.deepEqual(kinds(added("src/poll.ts", "await sleep(POLL_MS, signal);")), []);
  assert.deepEqual(
    kinds(added("src/a.test.ts", '  await jobs.start({ command: "sleep 30" });')),
    [],
  );
  assert.deepEqual(kinds(added("src/a.test.ts", "// never await sleep(1000) here")), []);
  assert.deepEqual(kinds(removed("src/a.test.ts", "  await delay(10);")), []);
  const tightened = diffOf("src/a.test.ts", [
    "-test('adds', { timeout: 30_000 }, () => {});",
    "+test('adds', { timeout: 1000 }, () => {});",
  ]);
  assert.deepEqual(kinds(tightened), []);
  const request = added("src/a.test.ts", "  await page.goto(url, { timeout: 5000 });");
  assert.deepEqual(kinds(request), []);
  const held = diffOf("config.json", ['-  "timeout": 10,', '+  "timeout": 30,']);
  assert.deepEqual(kinds(held), []);
});

test("a commit message about a flake-masking change can downgrade it", () => {
  const wait = added("src/a.test.ts", "  await delay(10);");
  assert.deepEqual(
    kinds(wait, ["test: keep a short sleep until the job emits ready, tracked in #12"]),
    ["flake-mask/low"],
  );
  assert.deepEqual(kinds(wait, ["test: skip the timer test until the fix lands"]), [
    "flake-mask/high",
  ]);
});

test("a coverage floor lowered or a budget ceiling raised is a strong flag", () => {
  const floor = diffOf("package.json", [
    '   "c8": {',
    '-    "lines": 90,',
    '+    "lines": 70,',
    "   }",
  ]);
  const found = findLoweredBar(floor);
  assert.deepEqual(
    found.map((item) => `${item.id}/${item.severity}`),
    ["weaker-check/high"],
  );
  assert.match(found[0].excerpts[0], /^package\.json:\d+: lines: 90 -> 70/);
  const cli = diffOf("package.json", [
    '-  "cover": "c8 --check-coverage --lines 90 npm test",',
    '+  "cover": "c8 --check-coverage --lines 80 npm test",',
  ]);
  assert.deepEqual(kinds(cli), ["weaker-check/high"]);
  const budget = diffOf("bundle.config.json", ['-  "maxSize": 150,', '+  "maxSize": 400,']);
  assert.deepEqual(kinds(budget), ["weaker-check/high"]);
  const yaml = diffOf(".github/ci.yml", ["-  fail_under: 85", "+  fail_under: 60"]);
  assert.deepEqual(kinds(yaml), ["weaker-check/high"]);
});

test("a threshold held, raised, or a ceiling lowered or unrelated number is not a flag", () => {
  for (const [before, after] of [
    ['"lines": 70,', '"lines": 90,'],
    ['"maxSize": 400,', '"maxSize": 150,'],
    ['"lines": 90,', '"lines": 90,'],
    ['"timeout": 30,', '"timeout": 10,'],
    ['"version": 9,', '"version": 2,'],
  ])
    assert.deepEqual(
      kinds(diffOf("config.json", [`-  ${before}`, `+  ${after}`])),
      [],
      `${before} -> ${after}`,
    );
  const lowered = diffOf("src/limits.ts", ["-const lines = 90;", "+const lines = 70;"]);
  assert.deepEqual(kinds(lowered), []);
});

test("a CI check removed from a workflow is a strong flag", () => {
  const dropped = diffOf(".github/workflows/ci.yml", [
    "     steps:",
    "       - uses: actions/checkout@v4",
    "-      - run: npm test",
    "-      - run: npm run lint",
    "       - run: npm run build",
  ]);
  const found = findLoweredBar(dropped);
  assert.deepEqual(
    found.map((item) => [item.id, item.severity, item.count]),
    [["weaker-check", "high", 2]],
  );
  assert.match(found[0].excerpts[0], /^\.github\/workflows\/ci\.yml:\d+: removed: .*npm test/);
  const scan = diffOf(".github/workflows/security.yml", [
    "-      - uses: github/codeql-action/analyze@v3",
  ]);
  assert.deepEqual(kinds(scan), ["weaker-check/high"]);
  const gone = diffOf(".github/workflows/test.yml", ["-      - run: go test ./..."], "deleted");
  assert.deepEqual(kinds(gone), ["weaker-check/high"]);
});

test("a CI step that is reworded, moved or not a check is not a removed check", () => {
  const bumped = diffOf(".github/workflows/ci.yml", [
    "-      - uses: github/codeql-action/analyze@v3",
    "+      - uses: github/codeql-action/analyze@v4",
  ]);
  assert.deepEqual(kinds(bumped), []);
  const moved = [
    diffOf(".github/workflows/ci.yml", ["-      - run: npm test"]),
    diffOf(".github/workflows/test.yml", ["+      - run: npm test"]),
  ].join("\n");
  assert.deepEqual(kinds(moved), []);
  const setup = diffOf(".github/workflows/ci.yml", [
    "-      - uses: actions/setup-node@v4",
    "-      - run: npm ci",
  ]);
  assert.deepEqual(kinds(setup), []);
});

test("a check that is told to pass whatever it finds is a strong flag", () => {
  const soft = diffOf(".github/workflows/ci.yml", [
    "       - run: npm run lint",
    "+        continue-on-error: true",
  ]);
  assert.deepEqual(kinds(soft), ["weaker-check/high"]);
  const masked = diffOf(".github/workflows/ci.yml", ["+      - run: npm test || true"]);
  assert.deepEqual(kinds(masked), ["weaker-check/high"]);
  const build = diffOf(".github/workflows/ci.yml", ["+      - run: npm run build || true"]);
  assert.deepEqual(kinds(build), []);
});

test("a lint rule switched off in a config file is a strong flag", () => {
  const cases = {
    ".oxlintrc.json": ['+    "no-unused-vars": "off",', '+    "eqeqeq": 0,'],
    "eslint.config.mjs": ["+  rules: { 'no-console': 'off' },"],
    "tsconfig.json": ['+    "strict": false,', '+    "noImplicitAny": false,'],
    "ruff.toml": ['+ignore = ["E501"]'],
    "Cargo.toml": ['+unwrap_used = "allow"'],
  };
  for (const [file, lines] of Object.entries(cases))
    for (const line of lines)
      assert.deepEqual(kinds(diffOf(file, [line])), ["weaker-check/high"], `${file}: ${line}`);
});

test("a rule turned on, a flag in an unrelated file or a commented reason is handled", () => {
  assert.deepEqual(kinds(diffOf(".oxlintrc.json", ['+    "no-debugger": "error",'])), []);
  assert.deepEqual(kinds(diffOf("tsconfig.json", ['+    "declaration": false,'])), []);
  assert.deepEqual(kinds(diffOf("src/settings.ts", ["+  mode: 'off',"])), []);
  const reason = diffOf("eslint.config.mjs", [
    "+  // the generated client trips this rule on every file",
    "+  rules: { 'no-console': 'off' },",
  ]);
  assert.deepEqual(kinds(reason), ["weaker-check/low"]);
});

test("a clean config and workflow change produces no flags", () => {
  const clean = [
    diffOf("package.json", ['-    "lines": 70,', '+    "lines": 90,']),
    diffOf(".github/workflows/ci.yml", ["+      - run: npm test", "+      - run: npm run lint"]),
    diffOf(".oxlintrc.json", ['+    "no-debugger": "error",']),
  ].join("\n");
  assert.deepEqual(findLoweredBar(clean), []);
});

test("a stub that fails with not implemented is a strong flag", () => {
  const cases = {
    "src/a.ts": [
      'export const sync = () => { throw new Error("not implemented"); };',
      "  throw new NotImplementedError('todo');",
      "  return Promise.reject(new Error(`Not yet implemented`));",
    ],
    "tool.py": ["    raise NotImplementedError", "    raise NotImplementedError('later')"],
    "main.go": ['\tpanic("not implemented")', '\tpanic("TODO")'],
    "lib.rs": ["    todo!()", '    unimplemented!("later")', '    todo!("wire this up")'],
  };
  for (const [file, lines] of Object.entries(cases))
    for (const line of lines)
      assert.deepEqual(kinds(added(file, line)), ["unfinished/high"], `${file}: ${line}`);
});

test("a stub with a comment saying why is weak", () => {
  const stub = added(
    "tool.py",
    "    # subclasses supply the real parser for their format",
    "    raise NotImplementedError",
  );
  assert.deepEqual(kinds(stub), ["unfinished/low"]);
});

test("an empty catch block is a strong flag", () => {
  const cases = {
    "src/a.ts": [
      ["try { run(); } catch (error) {}"],
      ["try { run(); } catch {}"],
      ["load().catch(() => {});"],
      ["} catch (error) {", "}"],
      ["} catch (error) {", "  // ignore", "}"],
    ],
    "tool.py": [["except ValueError:", "    pass"]],
    "main.go": [["if err != nil {", "}"]],
  };
  for (const [file, groups] of Object.entries(cases))
    for (const lines of groups)
      assert.deepEqual(kinds(added(file, ...lines)), ["unfinished/high"], lines.join(" | "));
});

test("a catch that handles the error, or explains the silence, is not flagged strongly", () => {
  const handled = [
    ["} catch (error) {", "  log(error);", "}"],
    ["} catch (error) {", "  throw error;", "}"],
    ["load().catch((error) => log(error));"],
  ];
  for (const lines of handled) assert.deepEqual(kinds(added("src/a.ts", ...lines)), []);
  const explained = added(
    "src/a.ts",
    "} catch (error) {",
    "  // the file may vanish between the stat and the read",
    "}",
  );
  assert.deepEqual(kinds(explained), ["unfinished/low"]);
  const goHandled = added("main.go", "if err != nil {", "\treturn err", "}");
  assert.deepEqual(kinds(goHandled), []);
});

test("a TODO standing where the body should be is a strong flag", () => {
  const cases = {
    "src/a.ts": [["export function sync() {", "  // TODO: implement", "}"]],
    "tool.py": [["def sync():", "    # TODO implement", "    pass"]],
    "main.go": [["func Sync() error {", "\t// FIXME", "}"]],
    "lib.rs": [["fn sync() {", "    // TODO", "}"]],
  };
  for (const [file, groups] of Object.entries(cases))
    for (const lines of groups)
      assert.deepEqual(kinds(added(file, ...lines)), ["unfinished/high"], lines.join(" | "));
});

test("a TODO beside real code, or one that names its tracker, is not a strong flag", () => {
  const beside = added(
    "src/a.ts",
    "function sync() {",
    "  // TODO: batch these",
    "  push(items);",
    "}",
  );
  assert.deepEqual(kinds(beside), []);
  const tracked = added("src/a.ts", "function sync() {", "  // TODO(#412): implement", "}");
  assert.deepEqual(kinds(tracked), ["unfinished/low"]);
});

test("stubs in a test file, a quoted example and removed stubs are not flagged", () => {
  assert.deepEqual(kinds(added("src/a.test.ts", 'throw new Error("not implemented");')), []);
  assert.deepEqual(
    kinds(added("src/a.ts", "const sample = \"throw new Error('not implemented')\";")),
    [],
  );
  assert.deepEqual(kinds(added("src/a.ts", "// throw new Error('not implemented')")), []);
  assert.deepEqual(kinds(removed("src/a.ts", 'throw new Error("not implemented");')), []);
  assert.deepEqual(kinds(added("docs/guide.md", "raise NotImplementedError")), []);
});

test("a clean source change produces no flags", () => {
  const clean = [
    added("src/a.ts", "export function sync(items) {", "  push(items);", "}"),
    added("tool.py", "def sync(items):", "    push(items)"),
    added("main.go", "func Sync() error {", "\treturn push()", "}"),
  ].join("\n");
  assert.deepEqual(findLoweredBar(clean), []);
});

const TS_SUPPRESSION = added("src/a.ts", ["// @ts", "-ignore"].join(""));
const SKIPPED_TEST = added("src/a.test.ts", "it.skip('adds', () => {});");
const LOWERED_FLOOR = diffOf("package.json", ['-  "lines": 90,', '+  "lines": 70,']);
const STUB = added("tool.py", "    raise NotImplementedError");

test("a commit message that names the change and gives a reason downgrades that category", () => {
  const cases = [
    [
      TS_SUPPRESSION,
      "suppression",
      "fix(api): suppress the type error because the generated client is wrong",
    ],
    [SKIPPED_TEST, "easier-test", "test: skip the timer test until the upstream fix lands"],
    [
      LOWERED_FLOOR,
      "weaker-check",
      "ci: lower the coverage threshold, generated code is tracked in #12",
    ],
    [STUB, "unfinished", "feat(sync): stub the parser for now, follow-up tracked in #7"],
  ];
  for (const [diff, id, message] of cases) {
    assert.deepEqual(kinds(diff), [`${id}/high`]);
    assert.deepEqual(kinds(diff, [message]), [`${id}/low`], message);
  }
});

test("a commit message with no reason, or about something else, leaves the flag strong", () => {
  assert.deepEqual(kinds(SKIPPED_TEST, ["test: skip the timer test"]), ["easier-test/high"]);
  assert.deepEqual(kinds(SKIPPED_TEST, ["feat: add a retry because users asked for one"]), [
    "easier-test/high",
  ]);
  assert.deepEqual(kinds(TS_SUPPRESSION, ["fix(api): skip the timer test until the fix lands"]), [
    "suppression/high",
  ]);
  assert.deepEqual(kinds(TS_SUPPRESSION, []), ["suppression/high"]);
});

test("a message downgrades only the category it is about", () => {
  const both = `${TS_SUPPRESSION}\n${SKIPPED_TEST}`;
  const found = findLoweredBar(both, ["test: skip the timer test until the upstream fix lands"]);
  assert.deepEqual(found.map((item) => `${item.id}/${item.severity}`).sort(), [
    "easier-test/low",
    "suppression/high",
  ]);
});

test("findings print in the shape the other deslop passes use", () => {
  const [found] = findLoweredBar(TS_SUPPRESSION);
  assert.equal(
    formatFindings([found]).startsWith(
      '- new suppression of a lint, type or coverage check (lowered-bar, high): "src/a.ts:1: ',
    ),
    true,
  );
  assert.match(formatFindings([found]), /Fix: .+\.$/);
  const [weak] = findLoweredBar(TS_SUPPRESSION, ["fix: suppress it because the client is wrong"]);
  assert.match(formatFindings([weak]), /\(lowered-bar, low\)/);
});

/** A fake exec that answers git calls from a table of `subcommand` to stdout, or null for a failure. */
function fakeGit(answers) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const sub = args.find((arg, at) => at > 0 && !arg.startsWith("-") && args[at - 1] !== "-C");
    const out = answers[sub];
    return out === null || out === undefined
      ? { code: 1, stdout: "", stderr: "fatal" }
      : { code: 0, stdout: out, stderr: "" };
  };
  return { exec, calls };
}
const review = (diff, log = "") =>
  fakeGit({ "symbolic-ref": "origin/main", "merge-base": "abc123\n", diff, log });

test("the branch review reports a lowered bar beside the code-slop findings", async () => {
  const git = review(`${TS_SUPPRESSION}\n${SKIPPED_TEST}`);
  const text = await reviewBranch(git.exec, "/repo");
  assert.match(text, /^deslop code: 2 proposals in 2 files changed since origin\/main\./);
  assert.match(text, /\(lowered-bar, high\)/);
  assert.match(text, /Nothing was edited/);
});

test("the review reads commit messages only when something strong needs them, and read-only", async () => {
  const quiet = review(added("src/a.ts", "export const total = 1;"));
  await reviewBranch(quiet.exec, "/repo");
  assert.equal(
    quiet.calls.some((call) => call.includes("log")),
    false,
  );

  const git = review(SKIPPED_TEST, "test: skip the timer test until the upstream fix lands\n\x1e");
  const text = await reviewBranch(git.exec, "/repo");
  const log = git.calls.find((call) => call.includes("log"));
  assert.deepEqual(log.slice(0, 3), ["git", "-C", "/repo"]);
  assert.ok(log.includes("abc123..HEAD"));
  assert.ok(log.includes("--no-color"));
  assert.match(text, /no proposals/, "a weak flag alone is not reported");

  const strong = review(SKIPPED_TEST, "feat: add a thing\n\x1e");
  assert.match(await reviewBranch(strong.exec, "/repo"), /\(lowered-bar, high\)/);
  const unreadable = review(SKIPPED_TEST, null);
  assert.match(await reviewBranch(unreadable.exec, "/repo"), /\(lowered-bar, high\)/);
});

test("a weak lowered-bar flag shows beside a strong one", async () => {
  const git = review(
    `${SKIPPED_TEST}\n${TS_SUPPRESSION}`,
    "test: skip the timer test until the upstream fix lands\n\x1e",
  );
  const text = await reviewBranch(git.exec, "/repo");
  assert.match(text, /\(lowered-bar, low\)/);
  assert.match(text, /\(lowered-bar, high\)/);
});

test("/deslop code includes the lowered-bar pass and edits nothing", async () => {
  const commands = {};
  const messages = [];
  const notices = [];
  piDeslopExtension({
    registerCommand: (name, command) => (commands[name] = command),
    sendUserMessage: (...args) => messages.push(args),
    on: () => {},
    exec: review(LOWERED_FLOOR).exec,
  });
  const ctx = { cwd: "/repo", ui: { notify: (...args) => notices.push(args) } };
  await commands.deslop.handler("code", ctx);
  assert.equal(messages.length, 0);
  assert.match(notices[0][0], /^deslop code: 1 proposal in 1 file changed since origin\/main\./);
  assert.match(notices[0][0], /threshold lowered, CI check removed or lint rule switched off/);
});

test("the passes stay fast on a huge diff of long and repetitive lines", () => {
  const catches = Array.from({ length: 4000 }, () => "} catch (error) {").join("\n");
  const comments = Array.from({ length: 4000 }, () => "// ".concat("word ".repeat(40))).join("\n");
  for (const diff of [
    added("src/a.ts", catches),
    added("src/b.ts", comments),
    added("a.yml", comments),
  ]) {
    const start = performance.now();
    findLoweredBar(diff);
    assert.ok(performance.now() - start < 1_500, "a check took longer than a second and a half");
  }
});

test("assertions moved from one test file to another are not removed", () => {
  const moved = [
    diffOf("src/a.test.ts", ["-  assert.equal(add(1, 2), 3);", "-  assert.equal(add(2, 2), 4);"]),
    added("src/b.test.ts", "assert.equal(add(1, 2), 3);", "assert.equal(add(2, 2), 4);"),
  ].join("\n");
  assert.deepEqual(kinds(moved), []);
});

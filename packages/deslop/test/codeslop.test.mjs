import { test } from "node:test";
import assert from "node:assert/strict";

import piDeslopExtension from "../index.ts";
import { findCodeSlop, parseDiff, reviewBranch } from "../codeslop.mjs";
import { formatFindings } from "../patterns.mjs";

/** A unified diff for one file. Lines start with "+" added, " " context or "-" removed. */
function diffOf(file, lines) {
  const count = (marks) => lines.filter((line) => marks.includes(line[0])).length;
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${count(" -")} +1,${count(" +")} @@`,
    ...lines,
    "",
  ].join("\n");
}
const added = (file, text) =>
  diffOf(
    file,
    text.split("\n").map((line) => `+${line}`),
  );
const idsOf = (diff) => findCodeSlop(diff).map((item) => item.id);

test("only added lines are parsed, with their new line numbers", () => {
  const diff = diffOf("src/a.ts", [" keep", "-gone", "+one", "+two", " tail"]);
  const [file] = parseDiff(diff);
  assert.equal(file.path, "src/a.ts");
  assert.deepEqual(
    file.hunks[0].lines.map(({ n, kind, text }) => [n, kind, text]),
    [
      [1, "ctx", "keep"],
      [2, "add", "one"],
      [3, "add", "two"],
      [4, "ctx", "tail"],
    ],
  );
  assert.deepEqual(file.removed, ["gone"]);
});

test("a deleted file, a test file and a non-code file are not examined", () => {
  const swallow = "try { run(); } catch { return null; }";
  assert.deepEqual(idsOf(added("src/a.test.ts", swallow)), []);
  assert.deepEqual(idsOf(added("test/helper.mjs", swallow)), []);
  assert.deepEqual(idsOf(added("README.md", swallow)), []);
  assert.deepEqual(idsOf(added("dist/app.js", swallow)), []);
  const deleted = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-catch {}",
  ];
  assert.deepEqual(idsOf(deleted.join("\n")), []);
});

test("an error swallowed into null, false or an empty result is found", () => {
  const cases = {
    "src/a.ts": [
      "try { await run(); } catch { return null; }",
      "const rows = await load().catch(() => []);",
      "try { parse(text); } catch (error) {}",
      "async function f() {\n  try {\n    return await run();\n  } catch (error) {\n    return false;\n  }\n}",
    ],
    "tool.py": [
      "try:\n    run()\nexcept ValueError:\n    pass",
      "try:\n    return load()\nexcept Exception:\n    return None",
    ],
    "run.go": ["res, err := run()\nif err != nil {\n\treturn nil\n}"],
  };
  for (const [file, texts] of Object.entries(cases))
    for (const text of texts) {
      const found = findCodeSlop(added(file, text)).find((item) => item.id === "swallowed");
      assert.ok(found, `${file}: ${text}`);
      assert.match(found.excerpts[0], new RegExp(`^${file.replace(".", "\\.")}:\\d+: `));
    }
});

test("an error that is logged, rethrown, passed on or explained is not swallowed", () => {
  const cases = {
    "src/a.ts": [
      "try { run(); } catch (error) { log(error); return null; }",
      "try { run(); } catch (error) { throw new Error('run failed', { cause: error }); }",
      "try {\n  run();\n} catch (error) {\n  return fallbackFor(error);\n}",
      "try {\n  run();\n} catch {\n  // ENOENT: the file is optional\n  return null;\n}",
      "const rows = await load().catch((error) => report(error));",
    ],
    "tool.py": ["try:\n    run()\nexcept ValueError:\n    log(error)\n    raise"],
    "run.go": ["res, err := run()\nif err != nil {\n\treturn nil, err\n}"],
  };
  for (const [file, texts] of Object.entries(cases))
    for (const text of texts)
      assert.equal(idsOf(added(file, text)).includes("swallowed"), false, `${file}: ${text}`);
});

test("findings are shaped for the prose reporter", () => {
  const found = findCodeSlop(added("src/a.ts", "try { run(); } catch { return null; }"));
  assert.equal(found.length, 1);
  assert.equal(found[0].sign, "code-slop");
  assert.equal(found[0].count, 1);
  const text = formatFindings(found);
  assert.match(
    text,
    /^- error swallowed into a quiet result \(code-slop, medium\): "src\/a\.ts:1: /,
  );
  assert.match(text, /Fix: .+\.$/);
});

test("a comment that only repeats the next line is found", () => {
  const cases = {
    "src/a.ts": [
      "// increment the counter\ncounter += 1;",
      "// return the user\nreturn user;",
      "// set the name\nthis.name = name;",
      "// loop over the files\nfor (const file of files) {",
    ],
    "tool.py": ["# open the config file\nconfig_file = open(path)"],
  };
  for (const [file, texts] of Object.entries(cases))
    for (const text of texts) {
      const found = findCodeSlop(added(file, text)).find((item) => item.id === "echo-comment");
      assert.ok(found, `${file}: ${text}`);
    }
});

test("a comment that gives a reason, a number or a name is kept", () => {
  for (const text of [
    "// retry once: the server drops idle sockets\nreturn send(request);",
    "// 8 bytes per entry\nconst size = entries * 8;",
    "// work around the parser bug in v3\nreturn parse(text);",
    "// TODO: remove the counter\ncounter += 1;",
    "// sorted by recency so the newest wins\nreturn rows.sort(byAge);",
    "// eslint-disable-next-line no-console\nconsole.log(user);",
    "/** The user. */\nreturn user;",
    "const total = 1; // the counter\nreturn total;",
  ])
    assert.equal(idsOf(added("src/a.ts", text)).includes("echo-comment"), false, text);
});

test("an any cast or a bare ts-ignore that only silences the type checker is found", () => {
  for (const text of [
    "const value = input as any;",
    "run(<any>input);",
    "const rows = data as unknown as Row[];",
    "// @ts-ignore\nrun(input);",
    "// @ts-expect-error\nrun(input);",
    "x.y = (z as any).w;",
  ]) {
    const found = findCodeSlop(added("src/a.ts", text)).find((item) => item.id === "silenced-type");
    assert.ok(found, text);
  }
});

test("a typed cast, a reasoned suppression and a non-TypeScript file are left alone", () => {
  for (const text of [
    "const value = input as Row;",
    "const anyOf = rules.filter(Boolean);",
    "// @ts-expect-error: the library types omit the signal option\nrun(input);",
    "const note = 'a cast as any value';",
  ])
    assert.equal(idsOf(added("src/a.ts", text)).includes("silenced-type"), false, text);
  assert.deepEqual(idsOf(added("src/a.mjs", "const x = 1 as any;")), []);
});

test("a fallback or guard nobody asked for is found", () => {
  for (const text of [
    "// fallback in case the config is missing\nconst config = load() ?? {};",
    "if (!user) {\n  // should never happen\n  return;\n}",
    "// just in case the hook runs twice\nreset();",
    "// backwards compatible with the old format\nconst id = row.id ?? row.legacyId;",
    'const name = opts.name ?? env.NAME ?? "unknown";',
  ]) {
    const found = findCodeSlop(added("src/a.ts", text)).find((item) => item.id === "fallback");
    assert.ok(found, text);
  }
});

test("one default and plain comments are not an unrequested fallback", () => {
  for (const text of [
    "const limit = opts.limit ?? 10;",
    "const name = opts.name || 'x';",
    "// the parent directory is used when none is given\nreturn parent;",
    "const fallbackModel = pick(models);",
    "if (a || b || c) {\n  run();\n}",
  ])
    assert.equal(idsOf(added("src/a.ts", text)).includes("fallback"), false, text);
});

const deepIf = [
  "function run(a) {",
  "  if (a) {",
  "    if (a.b) {",
  "      for (const x of a.b) {",
  "        if (x.ok) {",
  "          use(x);",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

test("an if inside three other blocks, and an else after a return, are found", () => {
  const deep = findCodeSlop(added("src/a.ts", deepIf)).find((item) => item.id === "nesting");
  assert.ok(deep, "deep nesting");
  assert.equal(deep.count, 1);
  assert.match(deep.excerpts[0], /^src\/a\.ts:5: if \(x\.ok\) \{/);
  for (const [file, text] of [
    ["src/a.ts", "if (x) {\n  return 1;\n} else {\n  return 2;\n}"],
    ["src/a.ts", "if (x) {\n  throw new Error('x');\n} else if (y) {\n  run();\n}"],
    ["tool.py", "if x:\n    return 1\nelse:\n    return 2"],
    [
      "tool.py",
      "def f(a):\n    if a:\n        for b in a:\n            while b:\n                if b.ok:\n                    use(b)",
    ],
  ])
    assert.ok(idsOf(added(file, text)).includes("nesting"), text);
});

test("shallow blocks, a flat else and nesting in a new function are not flagged", () => {
  for (const [file, text] of [
    ["src/a.ts", "if (x) {\n  run();\n} else {\n  stop();\n}"],
    [
      "src/a.ts",
      "function f(a) {\n  if (a) {\n    for (const x of a) {\n      use(x);\n    }\n  }\n}",
    ],
    [
      "src/a.ts",
      "if (a) {\n  if (b) {\n    run();\n  }\n}\nfunction g() {\n  if (c) {\n    if (d) {\n      use();\n    }\n  }\n}",
    ],
    ["tool.py", "if x:\n    run()\nelse:\n    stop()"],
  ])
    assert.equal(idsOf(added(file, text)).includes("nesting"), false, text);
});

test("a new function, class or interface with one user is found", () => {
  const cases = [
    ["src/a.ts", "function wrapUser(user) {\n  return { user };\n}\nconst row = wrapUser(user);"],
    ["src/a.ts", "const toRow = (item) => ({ item });\nexport const rows = items.map(toRow);"],
    ["src/a.ts", "export async function loadAll() {\n  return [];\n}\nawait loadAll();"],
    ["tool.py", "def wrap_user(user):\n    return user\n\nrow = wrap_user(user)"],
    ["run.go", "func wrapUser(user User) Row {\n\treturn Row{user}\n}\nrow := wrapUser(user)"],
    ["src/a.ts", "class UserCache {\n}\nconst cache = new UserCache();"],
    [
      "src/a.ts",
      "interface Store {\n  get(): void;\n}\nclass MemoryStore implements Store {\n}\nrun(new MemoryStore(), 1);\nrun(new MemoryStore(), 2);",
    ],
  ];
  for (const [file, text] of cases) {
    const found = findCodeSlop(added(file, text)).find((item) => item.id === "single-use");
    assert.ok(found, text);
  }
});

test("shared, public, modified or tested abstractions are not single-use", () => {
  const cases = [
    "function wrapUser(user) {\n  return { user };\n}\nconst a = wrapUser(1);\nconst b = wrapUser(2);",
    "export function publicApi() {\n  return 1;\n}",
    "function main() {\n  run();\n}\nmain();",
    "const x = (item) => item;\nconst y = x(1) + x(2);",
    "interface Store {\n  get(): void;\n}\nclass A implements Store {\n}\nclass B implements Store {\n}",
    "function ok() {\n  return 1;\n}\nconst fn = 'ok';",
  ];
  for (const text of cases)
    assert.equal(idsOf(added("src/a.ts", text)).includes("single-use"), false, text);
  const modified = diffOf("src/a.ts", [
    "-function wrapUser(user) {",
    "+function wrapUser(user, extra) {",
    "+  return { user, extra };",
    "+}",
    "+const row = wrapUser(user);",
  ]);
  assert.equal(idsOf(modified).includes("single-use"), false, "a changed function is not new");
});

test("a new function that its own test also calls is still counted by every user", () => {
  const source = added(
    "src/a.ts",
    "function wrapUser(user) {\n  return { user };\n}\nconst row = wrapUser(user);",
  );
  const testFile = added("src/a.test.ts", "assert.ok(wrapUser(1));");
  assert.equal(idsOf(source).includes("single-use"), true);
  assert.equal(idsOf(`${source}\n${testFile}`).includes("single-use"), false);
});

const SWALLOW_DIFF = added("src/a.ts", "try { run(); } catch { return null; }");

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

test("the branch review diffs against the merge base with the default branch", async () => {
  const git = fakeGit({
    "symbolic-ref": "origin/main\n",
    "merge-base": "abc123\n",
    diff: SWALLOW_DIFF,
  });
  const text = await reviewBranch(git.exec, "/repo");
  assert.match(text, /^deslop code: 1 proposal in 1 file changed since origin\/main\./);
  assert.match(text, /error swallowed into a quiet result \(code-slop, medium\)/);
  assert.match(text, /Nothing was edited/);
  const diffCall = git.calls.find((call) => call.includes("diff"));
  assert.ok(diffCall.includes("abc123"), "diffs from the merge base");
  assert.ok(diffCall.includes("--no-color"));
  for (const call of git.calls)
    assert.ok(
      ["symbolic-ref", "rev-parse", "merge-base", "diff"].some((sub) => call.includes(sub)),
      `only read-only git: ${call.join(" ")}`,
    );
});

test("a named base is used as given, and an unsafe one is refused", async () => {
  const git = fakeGit({ "merge-base": "abc123\n", diff: "" });
  const text = await reviewBranch(git.exec, "/repo", "release/1.0");
  assert.match(text, /no changes since release\/1\.0/i);
  assert.ok(git.calls.some((call) => call.includes("release/1.0")));
  const refused = await reviewBranch(git.exec, "/repo", "--output=/tmp/x");
  assert.match(refused, /not a usable base/);
});

test("with no default branch, no merge base or a failing diff the review says so", async () => {
  assert.match(await reviewBranch(fakeGit({}).exec, "/repo"), /could not find a default branch/);
  const noBase = fakeGit({ "symbolic-ref": "origin/main", "merge-base": null });
  assert.match(await reviewBranch(noBase.exec, "/repo"), /could not find a merge base/);
  const noDiff = fakeGit({ "symbolic-ref": "origin/main", "merge-base": "abc", diff: null });
  assert.match(await reviewBranch(noDiff.exec, "/repo"), /git diff failed/);
});

test("a clean diff reports no proposals", async () => {
  const git = fakeGit({
    "symbolic-ref": "origin/main",
    "merge-base": "abc",
    diff: added("src/a.ts", "export const total = items.length;"),
  });
  assert.match(await reviewBranch(git.exec, "/repo"), /^deslop code: no proposals in 1 file/);
});

function extension(exec) {
  const commands = {};
  const messages = [];
  const notices = [];
  piDeslopExtension({
    registerCommand: (name, command) => (commands[name] = command),
    sendUserMessage: (...args) => messages.push(args),
    on: () => {},
    exec,
  });
  const ctx = { cwd: "/repo", ui: { notify: (...args) => notices.push(args) } };
  return { run: (args) => commands.deslop.handler(args, ctx), messages, notices };
}

test("/deslop code reports in the UI and never asks the agent to edit", async () => {
  const git = fakeGit({ "symbolic-ref": "origin/main", "merge-base": "abc", diff: SWALLOW_DIFF });
  const pi = extension(git.exec);
  await pi.run("code");
  assert.equal(pi.messages.length, 0);
  assert.equal(pi.notices.length, 1);
  assert.match(pi.notices[0][0], /^deslop code: 1 proposal/);
  await pi.run("code develop");
  assert.ok(git.calls.some((call) => call.includes("develop")));
});

test("/deslop with a path still sends the prose request, and PI_DESLOP=0 stops the code pass", async () => {
  const git = fakeGit({});
  const pi = extension(git.exec);
  await pi.run("docs/guide.md");
  assert.equal(pi.messages.length, 1);
  assert.equal(git.calls.length, 0);
  process.env.PI_DESLOP = "0";
  try {
    await pi.run("code");
  } finally {
    delete process.env.PI_DESLOP;
  }
  assert.equal(git.calls.length, 0);
  assert.match(pi.notices.at(-1)[0], /disabled/);
});

test("the code checks stay fast on a huge diff of long and deeply nested lines", () => {
  const long = "x".repeat(450);
  const body = Array.from({ length: 30_000 }, (_, at) => `${" ".repeat(at % 40)}if (${long}) {`);
  const inputs = [
    added("src/a.ts", body.join("\n")),
    added("src/b.ts", "a ?? ".repeat(80) + "b"),
    added("src/c.ts", Array.from({ length: 20_000 }, (_, at) => `function f${at}() {}`).join("\n")),
    added("tool.py", "except:\n".repeat(30_000)),
  ];
  for (const diff of inputs) {
    const start = performance.now();
    findCodeSlop(diff);
    assert.ok(performance.now() - start < 1_500, "a check took longer than a second and a half");
  }
});

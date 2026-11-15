import { test } from "node:test";
import assert from "node:assert/strict";

import { findCodeSlop, parseDiff } from "../codeslop.mjs";
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

// Independent real-binary fixture; no model, credentials, installs or user configuration.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runQuality } from "../../packages/quality/quality.mjs";
import { lintComments } from "../../scripts/comment-lint.mjs";

const run = promisify(execFile);
const cwd = await mkdtemp(join(tmpdir(), "pi-quality-real-"));
try {
  await run("git", ["init", "--quiet", cwd]);
  const files = {
    "package.json": JSON.stringify({ name: "quality-fixture", type: "module", main: "main.ts" }),
    "deadwood.toml": 'entries = ["main.ts"]\n',
    "main.ts": "export function main(x: number) {\n" +
      Array.from({ length: 7 }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n") +
      "\n  return -1;\n}\nmain(1);\n",
    "unused.ts": "export const abandoned = 1;\n",
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(cwd, name), text);
  const exec = async (cmd, args, opts) => {
    try {
      const result = await run(cmd, args, { ...opts, encoding: "utf8" });
      return { code: 0, ...result };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr, killed: error.killed };
    }
  };
  const report = await runQuality({ cwd, exec });
  assert.equal(report.checks.length, 2);
  const crap = report.checks.find((check) => check.tool === "crap");
  const deadwood = report.checks.find((check) => check.tool === "deadwood");
  assert.equal(crap.status, "findings", JSON.stringify(report));
  const risk = JSON.parse(crap.output);
  assert.ok(risk.findings.some((finding) => finding.name === "main" && finding.crap > 30));
  assert.equal(deadwood.status, "findings", JSON.stringify(report));
  const unused = JSON.parse(deadwood.output);
  assert.ok(unused.findings.some((finding) => finding.file === "unused.ts"));
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(join(cwd, name), "utf8"), text);
  const needless = lintComments("fixture.ts", "// increment counter\ncounter++;");
  assert.equal(needless.length, 1);
  assert.deepEqual(lintComments("fixture.ts", "/** Returns a stable identity for callers. */\nfunction identity() { return cached; }"), []);
  const rulePath = fileURLToPath(new URL("../../scripts/comment-lint.mjs", import.meta.url));
  const docs = "/** Counter records completed work for callers. */\nexport let counter = 0;\n";
  const commentPath = join(cwd, "comments.ts");
  await writeFile(commentPath, docs + "// increment counter\ncounter++;\n");
  const rejected = await run(process.execPath, [rulePath, cwd]).then(
    () => ({ code: 0, stderr: "" }),
    (error) => ({ code: error.code, stderr: error.stderr }),
  );
  assert.equal(rejected.code, 1, "actual lint CLI must reject needless narration");
  assert.match(rejected.stderr, /comments\.ts:3: no-needless-comment/);
  await writeFile(commentPath, docs + "counter++;\n");
  const accepted = await run(process.execPath, [rulePath, cwd]);
  assert.match(accepted.stdout, /Comment lint passes/);
  assert.equal(await readFile(commentPath, "utf8"), docs + "counter++;\n");
  console.log("PASS: real crap flags main >30; real deadwood flags unused.ts; scans preserve source; actual lint CLI rejects narration and accepts preserved documentation in a separate repository");
} finally {
  await rm(cwd, { recursive: true, force: true });
}

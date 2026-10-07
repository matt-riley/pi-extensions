import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyRegistration } from "./registration.mjs";

test("loads every manifest entry and fails duplicate registrations and broken imports", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "extensions"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "user-agent");
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const entries = ["config", "first", "duplicate", "broken", "last"];
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ pi: { extensions: entries.map((name) => `./extensions/${name}.mjs`) } }),
  );
  await writeFile(
    path.join(root, "extensions/config.mjs"),
    `import {writeFileSync} from "node:fs"; import path from "node:path";
export default (pi) => {writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "router.json"), "{}"); pi.registerCommand("config", {});};`,
  );
  await writeFile(
    path.join(root, "extensions/first.mjs"),
    'export default (pi) => { pi.registerCommand("one", {}); pi.on("start", () => {}); }',
  );
  await writeFile(
    path.join(root, "extensions/duplicate.mjs"),
    'export default (pi) => pi.registerCommand("one", {});',
  );
  await writeFile(path.join(root, "extensions/broken.mjs"), 'import "./missing.mjs";');
  await writeFile(
    path.join(root, "extensions/last.mjs"),
    'export default (pi) => pi.registerVirtualModel({provider: "test", id: "model"});',
  );
  const results = await verifyRegistration(root);
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true, false, false, true],
  );
  assert.match(results[2].detail, /Duplicate command/);
  assert.match(results[3].detail, /missing.mjs/);
  assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, "user-agent"));
  await assert.rejects(access(path.join(root, "user-agent", "router.json")));
});

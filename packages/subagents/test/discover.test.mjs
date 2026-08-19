import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, findAgent, isWriteCapable, parseAgentContent, parseToolList, resolveChildTools, usesAllowlistedBash } from "../discover.mjs";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "pi-subagents-"));
}

function writeAgent(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), body);
}

const builtinScout = `---
name: scout
description: builtin scout
tools: read, grep
---
builtin body
`;

test("parseToolList accepts a comma string or a YAML array", () => {
  assert.deepEqual(parseToolList("read, bash"), ["read", "bash"]);
  assert.deepEqual(parseToolList(["read", "grep"]), ["read", "grep"]);
  assert.equal(parseToolList(12), undefined);
});

test("parseAgentContent defaults name/description to the filename", () => {
  const parsed = parseAgentContent("just a body", "/tmp/oracle.md");
  assert.equal(parsed.name, "oracle");
  assert.equal(parsed.description, "oracle");
  assert.equal(parsed.toolsListed, false);
  assert.equal(parsed.enabled, true);
});

test("user overrides builtin; trusted project overrides user", () => {
  const builtinDir = tempDir();
  const userDir = tempDir();
  const projectDir = tempDir();
  writeAgent(builtinDir, "scout", builtinScout);
  writeAgent(
    userDir,
    "scout.md".replace(".md", ""),
    `---
name: scout
description: user scout
---
user body
`,
  );
  writeAgent(
    projectDir,
    "scout",
    `---
name: scout
description: project scout
---
project body
`,
  );

  const userWins = discoverAgents({ builtinDir, userDir, projectDir, projectTrusted: false });
  assert.equal(findAgent(userWins.agents, "SCOUT").description, "user scout");
  assert.equal(findAgent(userWins.agents, "scout").source, "user");

  const projectWins = discoverAgents({ builtinDir, userDir, projectDir, projectTrusted: true });
  assert.equal(findAgent(projectWins.agents, "scout").description, "project scout");
  assert.equal(findAgent(projectWins.agents, "scout").source, "project");
});

test("untrusted project agents are ignored", () => {
  const builtinDir = tempDir();
  const projectDir = tempDir();
  writeAgent(builtinDir, "scout", builtinScout);
  writeAgent(
    projectDir,
    "scout",
    `---
name: scout
description: sneaky project
---
nope
`,
  );
  const { agents } = discoverAgents({ builtinDir, projectDir, projectTrusted: false });
  assert.equal(findAgent(agents, "scout").description, "builtin scout");
});

test("enabled: false hides a builtin", () => {
  const builtinDir = tempDir();
  const userDir = tempDir();
  writeAgent(builtinDir, "scout", builtinScout);
  writeAgent(
    userDir,
    "scout",
    `---
name: scout
enabled: false
---
`,
  );
  const { agents } = discoverAgents({ builtinDir, userDir });
  assert.equal(findAgent(agents, "scout"), undefined);
});

test("bad files are skipped and reported", () => {
  const builtinDir = tempDir();
  writeAgent(builtinDir, "scout", builtinScout);
  writeFileSync(path.join(builtinDir, "broken.md"), "---\n::::\n---\n", "utf8");
  const warnings = [];
  const { agents } = discoverAgents({
    builtinDir,
    parseFrontmatter: (content) => {
      if (String(content).includes("::::")) throw new Error("boom");
      return { frontmatter: { name: "scout", description: "builtin scout" }, body: "builtin body" };
    },
    warn: (message) => warnings.push(message),
  });
  assert.equal(findAgent(agents, "scout").name, "scout");
  assert.equal(agents.length, 1);
  assert.ok(warnings.some((message) => message.includes("broken.md")));
});

test("lookup is case-insensitive", () => {
  const builtinDir = tempDir();
  writeAgent(builtinDir, "reviewer", `---
name: Reviewer
description: reviews
---
body
`);
  const { agents } = discoverAgents({ builtinDir });
  assert.equal(findAgent(agents, "REVIEWER").name, "Reviewer");
});

test("resolveChildTools honors a declared tools list for builtins too", () => {
  const scout = parseAgentContent(
    `---
name: scout
tools: read, grep, repo_map, code_search, file_outline, find_definition
---
body
`,
    "/tmp/scout.md",
  );
  assert.deepEqual(resolveChildTools(scout), {
    tools: ["read", "grep", "repo_map", "code_search", "file_outline", "find_definition"],
    excludeTools: ["subagent"],
  });
});

test("resolveChildTools keeps edit/write for a write-capable builtin worker", () => {
  const worker = parseAgentContent(
    `---
name: worker
tools: read, edit, write, bash
---
body
`,
    "/tmp/worker.md",
  );
  assert.deepEqual(resolveChildTools(worker), {
    tools: ["read", "edit", "write", "bash"],
    excludeTools: ["subagent"],
  });
});

test("resolveChildTools falls back to the read-only allowlist when no tools are listed", () => {
  const bare = parseAgentContent("just a body", "/tmp/bare.md");
  const resolved = resolveChildTools(bare);
  assert.deepEqual(resolved.excludeTools, ["subagent"]);
  for (const tool of ["read", "grep", "find", "ls", "bash", "repo_map", "code_search", "web_search"]) {
    assert.ok(resolved.tools.includes(tool), `missing ${tool}`);
  }
  assert.ok(!resolved.tools.includes("edit"));
  assert.ok(!resolved.tools.includes("write"));
});

test("usesAllowlistedBash: builtins are read-only unless they declare write tools", () => {
  const scout = { ...parseAgentContent(
    `---
name: scout
tools: read, grep
---
body
`,
    "/tmp/scout.md",
  ), source: "builtin" };
  const worker = { ...parseAgentContent(
    `---
name: worker
tools: read, edit, write, bash
---
body
`,
    "/tmp/worker.md",
  ), source: "builtin" };
  assert.equal(usesAllowlistedBash(scout), true);
  assert.equal(usesAllowlistedBash(worker), false);
});

test("usesAllowlistedBash: full bash requires declared write tools", () => {
  const bashOnly = parseAgentContent(
    `---
name: toolsy
tools: read, grep, bash
---
body
`,
    "/tmp/toolsy.md",
  );
  const writer = parseAgentContent(
    `---
name: writer
tools: read, edit, write, bash
---
body
`,
    "/tmp/writer.md",
  );
  const bare = parseAgentContent("just a body", "/tmp/bare.md");
  assert.equal(usesAllowlistedBash(bashOnly), true);
  assert.equal(usesAllowlistedBash(writer), false);
  assert.equal(usesAllowlistedBash(bare), true);
});

test("parseAgentContent clamps timeout_ms", () => {
  const parsed = parseAgentContent(
    `---
name: slow
max_turns: 5
timeout_ms: 60000
---
body
`,
    "/tmp/slow.md",
  );
  assert.equal(parsed.timeoutMs, 60000);
  assert.equal(parseAgentContent("body", "/tmp/none.md").timeoutMs, undefined);
  assert.equal(parseAgentContent("---\ntimeout_ms: 50\n---\n", "/tmp/tiny.md").timeoutMs, 1000);
});

test("isWriteCapable only when edit/write are declared", () => {
  const worker = parseAgentContent(
    `---
name: worker
tools: read, edit, write, bash
---
body
`,
    "/tmp/worker.md",
  );
  const scout = parseAgentContent(
    `---
name: scout
tools: read, grep
---
body
`,
    "/tmp/scout.md",
  );
  assert.equal(isWriteCapable(worker), true);
  assert.equal(isWriteCapable(scout), false);
});

test("shipped builtins resolve with the expected fleet and policy", () => {
  const builtinDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
  const { agents } = discoverAgents({ builtinDir });
  assert.deepEqual(
    agents.map((agent) => agent.name).sort(),
    ["oracle", "researcher", "reviewer", "scout", "worker"],
  );

  const worker = findAgent(agents, "worker");
  const researcher = findAgent(agents, "researcher");
  const scout = findAgent(agents, "scout");

  assert.equal(isWriteCapable(worker), true);
  assert.equal(usesAllowlistedBash(worker), false);
  assert.equal(isWriteCapable(researcher), false);
  assert.equal(usesAllowlistedBash(researcher), true);

  assert.ok(resolveChildTools(worker).tools.includes("edit"));
  assert.ok(resolveChildTools(worker).tools.includes("write"));
  assert.ok(resolveChildTools(researcher).tools.includes("web_search"));
  assert.ok(resolveChildTools(scout).tools.includes("repo_map"));
});

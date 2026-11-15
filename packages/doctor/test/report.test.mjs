import { test } from "node:test";
import assert from "node:assert/strict";

import { collectReport, formatReport } from "../report.mjs";

const tool = (name, exposure = "direct") => ({ name, exposure });

/** A fake host that is healthy unless a test overrides a part. */
const host = (overrides = {}) => ({
  piVersion: "1.5.0",
  nodeVersion: "v22.1.0",
  tools: () => [tool("read"), tool("bash"), tool("codemode"), tool("tool_search")],
  activeTools: () => ["read", "bash", "codemode", "tool_search"],
  router: () => ({ state: "ok", path: "/agent/router.json" }),
  agentFiles: () => [{ path: "/agent/agents/scout.md", ok: true }],
  ...overrides,
});

test("a healthy host reports versions, tool count and no problems", async () => {
  const report = collectReport(host());
  assert.equal(report.pi.version, "1.5.0");
  assert.equal(report.node.version, "v22.1.0");
  assert.equal(report.tools.status, "ok");
  assert.equal(report.tools.total, 4);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.unknown, []);
});

test("duplicate tool names are listed with how many times they appear", () => {
  const report = collectReport(
    host({ tools: () => [tool("read"), tool("find_code", "deferred"), tool("find_code")] }),
  );
  assert.deepEqual(report.tools.duplicates, [{ name: "find_code", count: 2 }]);
  assert.ok(report.problems.some((p) => /duplicate tool name.*find_code/i.test(p)));
});

test("deferred tools are listed, and flagged when neither tool_search nor codemode is active", () => {
  const tools = [tool("read"), tool("find_code", "deferred"), tool("doctor_report", "deferred")];
  const reachable = collectReport(
    host({ tools: () => tools, activeTools: () => ["read", "codemode"] }),
  );
  assert.deepEqual(reachable.tools.deferred, ["doctor_report", "find_code"]);
  assert.equal(reachable.tools.deferredReachable, true);
  assert.deepEqual(reachable.problems, []);

  const stranded = collectReport(host({ tools: () => tools, activeTools: () => ["read", "bash"] }));
  assert.equal(stranded.tools.deferredReachable, false);
  assert.ok(stranded.problems.some((p) => /deferred.*tool_search or codemode/i.test(p)));
});

test("codemode-exposure tools need codemode specifically", () => {
  const tools = [tool("mcp__x__a", "codemode")];
  const report = collectReport(host({ tools: () => tools, activeTools: () => ["tool_search"] }));
  assert.deepEqual(report.tools.codemodeOnly, ["mcp__x__a"]);
  assert.ok(report.problems.some((p) => /codemode/i.test(p) && /mcp__x__a/.test(p)));
  const ok = collectReport(host({ tools: () => tools, activeTools: () => ["codemode"] }));
  assert.deepEqual(ok.problems, []);
});

test("a registry that throws is unknown, not a failure", () => {
  const report = collectReport(
    host({
      tools: () => {
        throw new Error("stale ctx after /new");
      },
    }),
  );
  assert.equal(report.tools.status, "unknown");
  assert.match(report.tools.reason, /stale ctx after \/new/);
  assert.deepEqual(report.problems, []);
  assert.equal(report.unknown.length, 1);
  assert.match(report.unknown[0], /tool registry/i);
});

test("an active-tools list that throws leaves reachability unknown", () => {
  const report = collectReport(
    host({
      tools: () => [tool("find_code", "deferred")],
      activeTools: () => {
        throw new Error("nope");
      },
    }),
  );
  assert.equal(report.tools.status, "ok");
  assert.equal(report.tools.deferredReachable, "unknown");
  assert.deepEqual(report.problems, []);
  assert.ok(report.unknown.some((u) => /active tools/i.test(u)));
});

test("a missing router.json is fine (defaults apply); a broken one is a problem", () => {
  const missing = collectReport(
    host({ router: () => ({ state: "missing", path: "/a/router.json" }) }),
  );
  assert.deepEqual(missing.problems, []);
  assert.equal(missing.router.state, "missing");
  const broken = collectReport(
    host({ router: () => ({ state: "invalid", path: "/a/router.json", error: "not valid JSON" }) }),
  );
  assert.ok(broken.problems.some((p) => /router\.json/.test(p) && /not valid JSON/.test(p)));
});

test("agent files that do not parse are named", () => {
  const report = collectReport(
    host({
      agentFiles: () => [
        { path: "/agents/ok.md", ok: true },
        { path: "/agents/bad.md", ok: false, error: "bad yaml" },
      ],
    }),
  );
  assert.equal(report.agents.checked, 2);
  assert.deepEqual(report.agents.broken, [{ path: "/agents/bad.md", error: "bad yaml" }]);
  assert.ok(report.problems.some((p) => /bad\.md/.test(p)));
});

test("a failing agent or router read is unknown, and does not stop the rest of the report", () => {
  const report = collectReport(
    host({
      router: () => {
        throw new Error("EACCES");
      },
      agentFiles: () => {
        throw new Error("EIO");
      },
    }),
  );
  assert.equal(report.tools.status, "ok");
  assert.equal(report.router.state, "unknown");
  assert.equal(report.agents.status, "unknown");
  assert.deepEqual(report.problems, []);
  assert.equal(report.unknown.length, 2);
});

test("missing versions are unknown rather than guessed", () => {
  const report = collectReport(host({ piVersion: undefined }));
  assert.equal(report.pi.version, null);
  assert.ok(report.unknown.some((u) => /pi version/i.test(u)));
});

test("the text report leads with the verdict and names every problem and unknown", () => {
  const text = formatReport(
    collectReport(
      host({
        tools: () => [tool("a"), tool("a")],
        router: () => {
          throw new Error("EACCES");
        },
      }),
    ),
  );
  assert.match(text, /^doctor: 1 problem, 1 unknown/m);
  assert.match(text, /pi 1\.5\.0/);
  assert.match(text, /node v22\.1\.0/);
  assert.match(text, /duplicate tool name/i);
  assert.match(text, /router\.json.*unknown/i);
  const healthy = formatReport(collectReport(host()));
  assert.match(healthy, /^doctor: no problems/m);
});

test("the report is plain data: it survives JSON and never mutates the host's lists", () => {
  const list = [tool("b"), tool("a")];
  const report = collectReport(host({ tools: () => list }));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.deepEqual(list, [tool("b"), tool("a")]);
});

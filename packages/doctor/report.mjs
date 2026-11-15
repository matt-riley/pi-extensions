// report.mjs — the doctor's report, computed from a host it is handed.
//
// Pure: every fact comes from a function on `host`, so tests drive it with a fake
// and the extension wires it to Pi. Each probe runs on its own. A probe that
// throws makes its part of the report "unknown", never a problem: a stale
// session context after /new throws from the registry getters, and that is not
// something the user broke. Read-only throughout.

const REACH_DEFERRED = ["tool_search", "codemode"];

/** Run a probe; the reason is the thrown message. */
function probe(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

const sorted = (names) => [...names].sort();

function toolsSection(host, problems, unknown) {
  const all = probe(() => host.tools());
  if (!all.ok) {
    unknown.push(`tool registry: ${all.reason}`);
    return { status: "unknown", reason: all.reason };
  }
  const tools = Array.isArray(all.value) ? all.value : [];
  const counts = new Map();
  for (const entry of tools) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const duplicates = sorted([...counts].filter(([, n]) => n > 1).map(([name]) => name)).map(
    (name) => ({ name, count: counts.get(name) }),
  );
  const exposures = {};
  for (const entry of tools) {
    const exposure = entry.exposure ?? "direct";
    exposures[exposure] = (exposures[exposure] ?? 0) + 1;
  }
  const names = (exposure) =>
    sorted(new Set(tools.filter((t) => (t.exposure ?? "direct") === exposure).map((t) => t.name)));
  const deferred = names("deferred");
  const codemodeOnly = names("codemode");

  const active = probe(() => host.activeTools());
  let deferredReachable = true;
  let codemodeReachable = true;
  if (deferred.length > 0 || codemodeOnly.length > 0) {
    if (!active.ok) {
      unknown.push(`active tools: ${active.reason}`);
      deferredReachable = "unknown";
      codemodeReachable = "unknown";
    } else {
      const on = new Set(active.value);
      deferredReachable = REACH_DEFERRED.some((name) => on.has(name));
      codemodeReachable = on.has("codemode");
    }
  }

  for (const { name, count } of duplicates) {
    problems.push(`duplicate tool name: ${name} is registered ${count} times`);
  }
  if (deferred.length > 0 && deferredReachable === false) {
    problems.push(
      `${deferred.length} deferred tool(s) (${deferred.join(", ")}) cannot be reached: neither tool_search or codemode is active`,
    );
  }
  if (codemodeOnly.length > 0 && codemodeReachable === false) {
    problems.push(
      `${codemodeOnly.length} codemode-exposure tool(s) (${codemodeOnly.join(", ")}) need codemode, which is not active`,
    );
  }
  return {
    status: "ok",
    total: tools.length,
    exposures,
    duplicates,
    deferred,
    deferredReachable,
    codemodeOnly,
    codemodeReachable,
  };
}

function routerSection(host, problems, unknown) {
  const result = probe(() => host.router());
  if (!result.ok) {
    unknown.push(`router.json: ${result.reason}`);
    return { state: "unknown", reason: result.reason };
  }
  const { state, path, error } = result.value;
  if (state === "invalid") problems.push(`router.json does not parse (${path}): ${error}`);
  return { state, path, ...(error ? { error } : {}) };
}

function agentsSection(host, problems, unknown) {
  const result = probe(() => host.agentFiles());
  if (!result.ok) {
    unknown.push(`agent files: ${result.reason}`);
    return { status: "unknown", reason: result.reason };
  }
  const files = result.value;
  const broken = files
    .filter((file) => !file.ok)
    .map((file) => ({ path: file.path, error: file.error ?? "does not parse" }));
  for (const file of broken)
    problems.push(`agent file does not parse: ${file.path}: ${file.error}`);
  return { status: "ok", checked: files.length, broken };
}

/** Everything the doctor knows, as plain data. `problems` are things to fix; `unknown` are things it could not see. */
export function collectReport(host) {
  const problems = [];
  const unknown = [];
  const piVersion = host.piVersion ?? null;
  if (!piVersion) unknown.push("pi version: the host did not report one");
  const nodeVersion = host.nodeVersion ?? null;
  if (!nodeVersion) unknown.push("node version: not reported");
  return {
    pi: { version: piVersion },
    node: { version: nodeVersion },
    tools: toolsSection(host, problems, unknown),
    router: routerSection(host, problems, unknown),
    agents: agentsSection(host, problems, unknown),
    problems,
    unknown,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The report as text: verdict first, then each fact, then what to look at. */
export function formatReport(report) {
  const verdict =
    report.problems.length === 0 && report.unknown.length === 0
      ? "doctor: no problems"
      : `doctor: ${plural(report.problems.length, "problem")}, ${report.unknown.length} unknown`;
  const lines = [verdict, ""];
  lines.push(`pi ${report.pi.version ?? "unknown"} · node ${report.node.version ?? "unknown"}`);

  const tools = report.tools;
  if (tools.status === "unknown") {
    lines.push(`tools: unknown (${tools.reason})`);
  } else {
    const mix = Object.entries(tools.exposures)
      .map(([name, n]) => `${n} ${name}`)
      .join(", ");
    lines.push(`tools: ${tools.total} registered (${mix || "none"})`);
    if (tools.deferred.length > 0) {
      lines.push(
        `  deferred: ${tools.deferred.join(", ")} — reachable via tool_search or codemode: ${tools.deferredReachable}`,
      );
    }
    if (tools.codemodeOnly.length > 0) {
      lines.push(
        `  codemode exposure: ${tools.codemodeOnly.join(", ")} — codemode active: ${tools.codemodeReachable}`,
      );
    }
  }

  const router = report.router;
  lines.push(
    router.state === "unknown"
      ? `router.json: unknown (${router.reason})`
      : `router.json: ${router.state === "missing" ? "not present, defaults apply" : router.state}`,
  );
  lines.push(
    report.agents.status === "unknown"
      ? `agent files: unknown (${report.agents.reason})`
      : `agent files: ${report.agents.checked} checked, ${report.agents.broken.length} do not parse`,
  );

  if (report.problems.length > 0)
    lines.push("", "Problems:", ...report.problems.map((p) => `- ${p}`));
  if (report.unknown.length > 0) {
    lines.push("", "Could not check:", ...report.unknown.map((u) => `- ${u}`));
  }
  return lines.join("\n");
}

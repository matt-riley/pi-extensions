// A blinded A/B run of two prompt or skill variants over a directory of cases.
//
// Variant directory (every part optional, at least one present):
//   SYSTEM.md   appended to the system prompt
//   AGENTS.md   copied into the workspace as its project context file
//   skills/     each entry loaded with --skill
//   prompts/    loaded with --prompt-template
// Cases directory: one subdirectory per case, its name project-shaped:
//   prompt.md   what a user would type (required)
//   fixture/    files committed into the workspace before the run
//   accept.sh   run by the harness in the workspace afterwards; exit 0 accepts
//   case.json   optional {"split": "...", "expectRead": ["path", ...]}
//
// The model never sees a variant label, the cases directory or the output
// directory: each run gets a fresh workspace named after the case, under a
// neutral temporary directory, and a private agent directory.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ISOLATION_FLAGS,
  MAX_RUNS,
  REPORTED_COST_CEILING,
  privateAgentDir,
  runPi,
  summarize,
} from "./run-pi.mjs";
import { bannedWords, promptProblems, sanitize } from "./sanitize.mjs";

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** Every file under `dir`, as sorted paths relative to it. */
async function listFiles(dir) {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

/** sha256 over a directory's relative paths and contents, for the frozen protocol. */
async function hashDir(dir) {
  const hash = createHash("sha256");
  for (const file of await listFiles(dir)) {
    hash.update(`${file}\0`);
    hash.update(await readFile(path.join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function refuseVisiblePaths(files, where) {
  for (const file of files) {
    const banned = bannedWords(file);
    if (banned.length)
      throw new Error(`${where}/${file} names the measurement (${banned.join(", ")})`);
  }
}

/** Read and check one variant directory. Paths it puts in front of the model are checked. */
async function loadVariant(dir) {
  const root = path.resolve(dir);
  const parts = {
    system: path.join(root, "SYSTEM.md"),
    agents: path.join(root, "AGENTS.md"),
    skills: path.join(root, "skills"),
    prompts: path.join(root, "prompts"),
  };
  const present = Object.fromEntries(
    await Promise.all(Object.entries(parts).map(async ([key, file]) => [key, await exists(file)])),
  );
  if (!Object.values(present).some(Boolean))
    throw new Error(`${dir}: needs SYSTEM.md, AGENTS.md, skills/ or prompts/`);
  for (const key of ["skills", "prompts"])
    if (present[key]) refuseVisiblePaths(await listFiles(parts[key]), key);
  return {
    root,
    system: present.system ? await readFile(parts.system, "utf8") : null,
    hasAgents: present.agents,
    skills: present.skills ? (await readdir(parts.skills)).sort() : [],
    hasPrompts: present.prompts,
    hash: await hashDir(root),
  };
}

/** Read and check every case. Throws on the first giveaway name or prompt. */
export async function loadCases(dir) {
  const root = path.resolve(dir);
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const cases = [];
  for (const name of names) {
    const caseDir = path.join(root, name);
    const id = sanitize(name);
    const prompt = (await readFile(path.join(caseDir, "prompt.md"), "utf8")).trim();
    if (!prompt) throw new Error(`${name}/prompt.md is empty`);
    const problems = promptProblems(prompt);
    if (problems.length) throw new Error(`${name}/prompt.md ${problems.join("; ")}`);
    const fixture = path.join(caseDir, "fixture");
    refuseVisiblePaths(await listFiles(fixture), `${name}/fixture`);
    const meta = (await exists(path.join(caseDir, "case.json")))
      ? JSON.parse(await readFile(path.join(caseDir, "case.json"), "utf8"))
      : {};
    cases.push({
      id,
      dir: caseDir,
      prompt,
      fixture,
      accept: (await exists(path.join(caseDir, "accept.sh")))
        ? path.join(caseDir, "accept.sh")
        : null,
      split: typeof meta.split === "string" ? meta.split : null,
      expectRead: Array.isArray(meta.expectRead) ? meta.expectRead.map(String) : [],
      hash: await hashDir(caseDir),
    });
  }
  if (!cases.length) throw new Error(`${dir}: no case directories`);
  if (cases.length * 2 > MAX_RUNS)
    throw new Error(`${cases.length} cases need ${cases.length * 2} runs; the cap is ${MAX_RUNS}`);
  return cases;
}

/** Files the model opened with `read`, relative to the workspace or the agent directory. */
export function openedFiles(events, { workspace, agentDir }) {
  const opened = [];
  for (const event of events) {
    if (event.type !== "tool_execution_start" || event.toolName !== "read") continue;
    const raw = event.args?.path ?? event.args?.file_path;
    if (typeof raw !== "string") continue;
    const absolute = path.resolve(workspace, raw);
    const base = [workspace, agentDir].find((dir) => absolute.startsWith(dir + path.sep));
    opened.push(base ? path.relative(base, absolute) : absolute);
  }
  return [...new Set(opened)];
}

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, stdio: "pipe", timeout: 10000 },
  );

/** Build a workspace for one run: fixture files, the variant's AGENTS.md, one commit. */
async function workspaceFor(item, variant) {
  // Real paths, so the paths pi reports in tool calls compare equal.
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "pi-work-")));
  const workspace = path.join(parent, item.id);
  await mkdir(workspace);
  if (await exists(item.fixture)) await cp(item.fixture, workspace, { recursive: true });
  if (variant.hasAgents) {
    if (await exists(path.join(workspace, "AGENTS.md")))
      throw new Error(`${item.id}: fixture and variant both supply AGENTS.md`);
    await cp(path.join(variant.root, "AGENTS.md"), path.join(workspace, "AGENTS.md"));
  }
  git(workspace, "init", "--quiet");
  git(workspace, "add", "--all");
  git(workspace, "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "start");
  return { parent, workspace };
}

/** Copy the variant's skills and prompts into the private agent directory; return pi flags. */
async function resourceArgs(variant, agentDir) {
  const args = [];
  for (const skill of variant.skills) {
    const target = path.join(agentDir, "skills", skill);
    await cp(path.join(variant.root, "skills", skill), target, { recursive: true });
    args.push("--skill", target);
  }
  if (variant.hasPrompts) {
    const target = path.join(agentDir, "prompts");
    await cp(path.join(variant.root, "prompts"), target, { recursive: true });
    args.push("--prompt-template", target);
  }
  if (variant.system !== null) args.push("--append-system-prompt", variant.system);
  return args;
}

/** One case under one variant; artifacts go to `output`, never into the workspace. */
async function runOne({ item, label, variant, model, output, bin }) {
  const agentDir = await realpath(await privateAgentDir(model));
  const { parent, workspace } = await workspaceFor(item, variant);
  try {
    for (const dir of [agentDir, workspace]) {
      const banned = bannedWords(dir);
      if (banned.length) throw new Error(`${dir} names the measurement; set TMPDIR elsewhere`);
    }
    const args = [
      ...ISOLATION_FLAGS,
      "--no-approve",
      "--provider",
      model.provider,
      "--model",
      model.model,
      "--thinking",
      "off",
      "--tools",
      "read,bash,edit,write",
      ...(await resourceArgs(variant, agentDir)),
      item.prompt,
    ];
    const started = Date.now();
    const run = await runPi({ args, cwd: workspace, agentDir, bin });
    const { text, cost, tokens } = summarize(run.events);
    const accepted = item.accept
      ? spawnSync("sh", [item.accept], { cwd: workspace, stdio: "ignore", timeout: 30000 })
          .status === 0
      : null;
    const opened = openedFiles(run.events, { workspace, agentDir });
    const followed = item.expectRead.length
      ? item.expectRead.every((want) =>
          opened.some((file) => file === want || file.endsWith(`/${want}`)),
        )
      : null;
    const prefix = path.join(output, `${item.id}-${label}`);
    await writeFile(`${prefix}-events.json`, JSON.stringify(run.events, null, 2));
    await writeFile(`${prefix}-stderr.txt`, run.stderr);
    await writeFile(`${prefix}-final.md`, text);
    return {
      case: item.id,
      split: item.split,
      variant: label,
      accepted,
      followed,
      opened,
      bashCommands: run.events
        .filter((event) => event.type === "tool_execution_start" && event.toolName === "bash")
        .map((event) => event.args?.command),
      exitCode: run.exitCode,
      reason: run.reason,
      turns: run.turns,
      durationMs: Date.now() - started,
      cost,
      tokens,
      humanCorrections: null,
      rework: null,
      text,
    };
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
}

/** One file per case for the judge: both final answers by neutral label, order shuffled. */
async function writeBlind(output, results, pick = randomInt) {
  const dir = path.join(output, "blind");
  await mkdir(dir);
  const key = {};
  for (const id of new Set(results.map((result) => result.case))) {
    const pair = ["a", "b"].map((label) =>
      results.find((result) => result.case === id && result.variant === label),
    );
    if (pair.some((result) => !result)) continue; // A capped run leaves nothing to compare.
    const order = pick(2) === 0 ? pair : [pair[1], pair[0]];
    key[id] = order.map((result) => result.variant);
    const body = [
      `# ${id}`,
      "",
      "Rate both responses on the same 1-5 scale in one pass, then say which is better and why.",
      "",
      ...order.flatMap((result, index) => [`## Response ${index + 1}`, "", result.text, ""]),
    ].join("\n");
    await writeFile(path.join(dir, `${id}.md`), body);
  }
  await writeFile(path.join(output, "blind-key.json"), JSON.stringify(key, null, 2));
}

/**
 * Run every case under both variants, alternating which goes first, until the
 * run cap or the reported-cost ceiling. `output` must not exist: a finished
 * eval is not rerun to make the result look better.
 */
export async function runVariantEval({ variantA, variantB, casesDir, output, model, bin, pick }) {
  const variants = { a: await loadVariant(variantA), b: await loadVariant(variantB) };
  const cases = await loadCases(casesDir);
  await mkdir(output); // Refuse overwriting an earlier run.
  const protocol = {
    scope: "Two prompt/skill variants on the same cases; outputs blinded for the judge.",
    provider: model.provider,
    model: model.model,
    thinking: "off",
    maxRuns: MAX_RUNS,
    reportedCostCeiling: REPORTED_COST_CEILING,
    variants: { a: { hash: variants.a.hash }, b: { hash: variants.b.hash } },
    cases: cases.map((item) => ({ id: item.id, split: item.split, hash: item.hash })),
    order: "Alternating a/b by case; no prompt tuning after run start",
    humanCorrections: null,
    rework: null,
  };
  await writeFile(path.join(output, "protocol.json"), JSON.stringify(protocol, null, 2));
  const results = [];
  let reportedCost = 0;
  try {
    for (const [index, item] of cases.entries()) {
      for (const label of index % 2 ? ["b", "a"] : ["a", "b"]) {
        if (reportedCost >= REPORTED_COST_CEILING || results.length >= MAX_RUNS) break;
        const result = await runOne({ item, label, variant: variants[label], model, output, bin });
        if (result.cost !== null) reportedCost += result.cost;
        results.push(result);
        await writeFile(
          path.join(output, "results.json"),
          JSON.stringify({ protocol, reportedCost, results }, null, 2),
        );
        console.log(
          `${item.id} ${label}: accepted=${result.accepted ?? "n/a"} followed=${result.followed ?? "n/a"}, ${result.durationMs}ms, cost=${result.cost ?? "unknown"}`,
        );
      }
    }
    await writeBlind(output, results, pick);
  } finally {
    console.log(
      `Eval artifacts: ${output}; ${results.length}/${cases.length * 2} runs; reported cost ${reportedCost}`,
    );
  }
  return { protocol, reportedCost, results };
}

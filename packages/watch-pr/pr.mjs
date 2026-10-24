// pr.mjs — where a pull request stands, from what GitHub says right now.
//
// Taking a PR to merge is a loop: look at the checks for the head commit, the
// merge state, the unresolved review threads; fix what is red; rebase; look
// again. The looking is the same every time, so it is code. The verdict is
// deliberately blunt — "ready" means nothing is outstanding on the head SHA
// named, not that merging is authorised.

const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);

const THREADS_QUERY =
  "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){" +
  "reviewThreads(first:100){nodes{isResolved isOutdated path comments(first:1){nodes{body}}}}}}}";

/** One rollup entry as {name, outcome}: a CheckRun and a commit status disagree on field names. */
export function checkOutcome(check) {
  const name = check.name ?? check.context ?? "(unnamed)";
  if (check.__typename === "StatusContext" || check.state !== undefined) {
    if (FAILED_STATES.has(check.state)) return { name, outcome: "failed" };
    return { name, outcome: check.state === "SUCCESS" ? "passed" : "pending" };
  }
  if (check.status !== "COMPLETED") return { name, outcome: "pending" };
  if (FAILED_CONCLUSIONS.has(check.conclusion)) return { name, outcome: "failed" };
  return { name, outcome: "passed" }; // SUCCESS, NEUTRAL, SKIPPED
}

/**
 * snapshot: { pr: gh pr view JSON, threads: [{isResolved, isOutdated, path, ...}] }
 * Returns { verdict: "closed" | "needs-action" | "pending" | "ready", lines }.
 */
export function assess({ pr, threads }) {
  const head = String(pr.headRefOid ?? "").slice(0, 8);
  const lines = [`PR #${pr.number} head ${head} (${pr.url})`];
  if (pr.state !== "OPEN") {
    lines.push(`state: ${pr.state}`);
    return { verdict: "closed", lines };
  }
  const checks = (pr.statusCheckRollup ?? []).map(checkOutcome);
  const failed = checks.filter((c) => c.outcome === "failed");
  const pending = checks.filter((c) => c.outcome === "pending");
  const open = (threads ?? []).filter((t) => !t.isResolved && !t.isOutdated);
  const action = [];
  if (pr.mergeStateStatus === "DIRTY") action.push("merge conflicts with the base branch");
  if (pr.mergeStateStatus === "BEHIND") action.push(`behind ${pr.baseRefName}: rebase`);
  if (pr.reviewDecision === "CHANGES_REQUESTED") action.push("changes requested");
  for (const c of failed) action.push(`check failed: ${c.name}`);
  for (const t of open) {
    const body = (t.comments?.nodes?.[0]?.body ?? "").replace(/\s+/g, " ").slice(0, 120);
    action.push(`unresolved thread on ${t.path}: ${body}`);
  }
  if (pr.isDraft) action.push("still a draft");
  lines.push(
    `checks: ${checks.length - failed.length - pending.length} passed, ${failed.length} failed, ${pending.length} pending`,
  );
  if (checks.length === 0) lines.push("no checks reported for this head: a gap, not a pass");
  lines.push(...action.map((a) => `- ${a}`));
  if (action.length) return { verdict: "needs-action", lines };
  if (pending.length) {
    lines.push(...pending.map((c) => `- waiting on: ${c.name}`));
    return { verdict: "pending", lines };
  }
  lines.push("nothing outstanding on this head. This is not authority to merge.");
  return { verdict: "ready", lines };
}

/** exec(args) resolves to gh's stdout, or null on a non-zero exit. */
export async function fetchSnapshot(exec, ref) {
  const fields =
    "number,url,state,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup";
  const viewed = await exec(["pr", "view", ...(ref ? [ref] : []), "--json", fields]);
  if (viewed === null)
    return {
      error: "gh could not read the pull request (no PR for this branch, or not signed in).",
    };
  const pr = JSON.parse(viewed);
  const repo = await exec(["repo", "view", "--json", "owner,name"]);
  if (repo === null)
    return { pr, threads: [], note: "review threads unavailable: gh repo view failed" };
  const { owner, name } = JSON.parse(repo);
  const graph = await exec([
    "api",
    "graphql",
    "-f",
    `query=${THREADS_QUERY}`,
    "-F",
    `o=${owner.login}`,
    "-F",
    `r=${name}`,
    "-F",
    `n=${pr.number}`,
  ]);
  if (graph === null)
    return { pr, threads: [], note: "review threads unavailable: graphql call failed" };
  const nodes = JSON.parse(graph).data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return { pr, threads: nodes };
}

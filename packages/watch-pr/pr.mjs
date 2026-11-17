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
const PASSED_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING_STATUSES = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "PENDING"]);

const THREADS_QUERY = `query($o:String!,$r:String!,$n:Int!,$endCursor:String) {
  repository(owner:$o,name:$r) {
    pullRequest(number:$n) {
      headRefOid
      reviewThreads(first:100,after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved isOutdated path comments(first:1) { nodes { body } } }
      }
    }
  }
}`;

/** One rollup entry as {name, outcome}: a CheckRun and a commit status disagree on field names. */
export function checkOutcome(check) {
  const name = check?.name ?? check?.context ?? "(unnamed)";
  if (check?.__typename === "StatusContext" || check?.state !== undefined) {
    if (FAILED_STATES.has(check.state)) return { name, outcome: "failed" };
    if (check.state === "SUCCESS") return { name, outcome: "passed" };
    return { name, outcome: check.state === "PENDING" ? "pending" : "unknown" };
  }
  if (check?.status !== "COMPLETED")
    return { name, outcome: PENDING_STATUSES.has(check?.status) ? "pending" : "unknown" };
  if (FAILED_CONCLUSIONS.has(check.conclusion)) return { name, outcome: "failed" };
  return { name, outcome: PASSED_CONCLUSIONS.has(check.conclusion) ? "passed" : "unknown" };
}

/**
 * snapshot: { pr: gh pr view JSON, threads: [{isResolved, isOutdated, path, ...}] }
 * Returns { verdict: "closed" | "needs-action" | "unknown" | "pending" | "ready", lines }.
 */
export function assess({ pr, threads, note }) {
  const head = String(pr.headRefOid ?? "").slice(0, 8);
  const lines = [`PR #${pr.number} head ${head} (${pr.url})`];
  if (pr.state !== "OPEN") {
    lines.push(`state: ${pr.state}`);
    return { verdict: ["CLOSED", "MERGED"].includes(pr.state) ? "closed" : "unknown", lines };
  }
  const checks = (pr.statusCheckRollup ?? []).map(checkOutcome);
  const failed = checks.filter((c) => c.outcome === "failed");
  const pending = checks.filter((c) => c.outcome === "pending");
  const unknown = checks.filter((c) => c.outcome === "unknown");
  const gaps = unknown.map((c) => `unknown check result: ${c.name}`);
  if (!head) gaps.push("head SHA unavailable");
  if (!checks.length) gaps.push("no checks reported for this head: a gap, not a pass");
  if (!Array.isArray(threads)) gaps.push("review threads unavailable");
  if (note) gaps.push(note);
  if (!["CLEAN", "HAS_HOOKS", "DIRTY", "BEHIND", "BLOCKED"].includes(pr.mergeStateStatus))
    gaps.push(`merge state unknown: ${pr.mergeStateStatus ?? "(missing)"}`);
  if (!["", null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(pr.reviewDecision))
    gaps.push("review decision unknown");
  const open = (threads ?? []).filter((t) => !t.isResolved && !t.isOutdated);
  const action = [];
  if (pr.mergeStateStatus === "DIRTY") action.push("merge conflicts with the base branch");
  if (pr.mergeStateStatus === "BEHIND") action.push(`behind ${pr.baseRefName}: rebase`);
  if (pr.mergeStateStatus === "BLOCKED") action.push("merge blocked by GitHub policy");
  if (pr.reviewDecision === "CHANGES_REQUESTED") action.push("changes requested");
  if (pr.reviewDecision === "REVIEW_REQUIRED") action.push("required review outstanding");
  for (const c of failed) action.push(`check failed: ${c.name}`);
  for (const t of open) {
    const body = (t.comments?.nodes?.[0]?.body ?? "").replace(/\s+/g, " ").slice(0, 120);
    action.push(`unresolved thread on ${t.path}: ${body}`);
  }
  if (pr.isDraft) action.push("still a draft");
  lines.push(
    `checks: ${checks.length - failed.length - pending.length - unknown.length} passed, ${failed.length} failed, ${pending.length} pending, ${unknown.length} unknown`,
  );
  lines.push(...action.map((a) => `- ${a}`), ...gaps.map((gap) => `- ${gap}`));
  if (action.length) return { verdict: "needs-action", lines };
  if (gaps.length) return { verdict: "unknown", lines };
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
  let pr;
  try {
    pr = JSON.parse(viewed);
  } catch {
    return { error: "gh returned invalid pull request JSON." };
  }
  if (!pr || typeof pr !== "object" || Array.isArray(pr))
    return { error: "gh returned invalid pull request data." };
  if (["CLOSED", "MERGED"].includes(pr.state)) return { pr, threads: [] };
  const unavailable = (reason) => ({
    pr,
    threads: [],
    note: `review threads unavailable: ${reason}`,
  });
  let url;
  try {
    url = new URL(pr.url);
  } catch {
    return unavailable("invalid pull request URL");
  }
  const target = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!["http:", "https:"].includes(url.protocol) || !target || Number(target[3]) !== pr.number)
    return unavailable("invalid pull request URL");
  const graph = await exec([
    "api",
    "graphql",
    "--hostname",
    url.host,
    "--paginate",
    "--slurp",
    "-f",
    `query=${THREADS_QUERY}`,
    "-F",
    `o=${target[1]}`,
    "-F",
    `r=${target[2]}`,
    "-F",
    `n=${pr.number}`,
  ]);
  if (graph === null) return unavailable("graphql call failed");
  let pages;
  try {
    pages = JSON.parse(graph);
  } catch {
    return unavailable("invalid GraphQL JSON");
  }
  if (!Array.isArray(pages) || !pages.length) return unavailable("missing GraphQL pages");
  const threads = [];
  for (const page of pages) {
    const pull = page?.data?.repository?.pullRequest;
    const connection = pull?.reviewThreads;
    if (
      page?.errors?.length ||
      !Array.isArray(connection?.nodes) ||
      typeof connection?.pageInfo?.hasNextPage !== "boolean" ||
      connection.nodes.some(
        (thread) =>
          typeof thread?.isResolved !== "boolean" || typeof thread?.isOutdated !== "boolean",
      )
    )
      return unavailable("incomplete GraphQL response");
    if (pull.headRefOid !== pr.headRefOid)
      return unavailable("PR head changed or unavailable during retrieval; read again");
    threads.push(...connection.nodes);
  }
  if (pages.at(-1).data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage)
    return unavailable("pagination incomplete");
  return { pr, threads };
}

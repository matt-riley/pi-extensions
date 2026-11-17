// aggregate.mjs — the swarm result contract. A slice whose child did not finish,
// or whose text does not open with PASS, ISSUES or BLOCKED, is a gap; a gap is
// never a pass, and neither is an empty swarm.

const VERDICT = /^[\s#*_>]*(PASS|ISSUES|BLOCKED)\b/;
const SHA = /\b[0-9a-f]{7,40}\b/gi;
const CLEAN = new Set(["completed", "wrapped up"]);

/** The verdict word on the first non-blank line, or null. */
function verdictOf(text) {
  const first = String(text ?? "")
    .split("\n")
    .find((line) => line.trim());
  return first ? (VERDICT.exec(first)?.[1] ?? null) : null;
}

/** Whether `text` names the expected commit, in full or by a prefix of 7 or more. */
function recordsSha(text, sha) {
  const want = String(sha).toLowerCase();
  return [...String(text ?? "").matchAll(SHA)].some((m) => want.startsWith(m[0].toLowerCase()));
}

/**
 * @param {{slice:string, required?:boolean, text?:string, status:string}[]} results
 * @param {{expectSha?:string}} [opts]
 * With no slice marked required, every slice is required.
 */
export function aggregate(results, { expectSha } = {}) {
  const list = Array.isArray(results) ? results : [];
  const anyRequired = list.some((r) => r.required === true);
  const rows = list.map((r) => {
    const row = { ...r, required: anyRequired ? r.required === true : true };
    if (!CLEAN.has(r.status)) return { ...row, verdict: "GAP", why: `child ${r.status}` };
    const verdict = verdictOf(r.text);
    if (!verdict)
      return { ...row, verdict: "GAP", why: "does not open with PASS, ISSUES or BLOCKED" };
    if (expectSha && !recordsSha(r.text, expectSha))
      return { ...row, verdict: "GAP", why: `did not record ${expectSha.slice(0, 12)}` };
    return { ...row, verdict };
  });
  const gaps = rows.filter((r) => r.verdict === "GAP");
  const required = rows.filter((r) => r.required);
  let overall = "ISSUES";
  if (!rows.length) overall = "INCOMPLETE";
  else if (required.every((r) => r.verdict === "PASS")) overall = "PASS";
  else if (required.some((r) => r.verdict === "GAP")) overall = "INCOMPLETE";
  return { rows, gaps, overall };
}

/** One table for the parent to report: overall first, then a row per slice. */
export function formatAggregate({ rows, overall }) {
  const lines = [`overall: ${overall}`];
  if (!rows.length) lines.push("no results: an empty swarm is not a pass");
  for (const r of rows)
    lines.push(
      `- ${r.slice}: ${r.verdict}${r.required ? "" : " (optional)"}${r.why ? `: ${r.why}` : ""}`,
    );
  return lines.join("\n");
}

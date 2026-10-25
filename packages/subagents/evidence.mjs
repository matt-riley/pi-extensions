// Parent-specified command contracts + observed host events. Child prose is not evidence.

export function collectEvidence(events, event) {
  if (event?.type === "tool_execution_start" && event.toolName === "bash") {
    events.push({
      id: event.toolCallId,
      command: String(event.args?.command ?? ""),
      success: null,
      output: "",
    });
  } else if (event?.type === "tool_execution_end") {
    const record = events.findLast((item) => item.id === event.toolCallId);
    if (record) {
      record.success = event.isError === false ? true : event.isError === true ? false : null;
      record.output = (event.result?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .slice(0, 500);
    }
  }
}

export function assessEvidence({
  criteria = [],
  evidence = [],
  before,
  after,
  status,
  transcriptSaved = true,
}) {
  const sameRevision = Boolean(before?.fingerprint && before.fingerprint === after?.fingerprint);
  const checks = criteria.map(({ criterion, command }) => {
    const observed = evidence.findLast((item) => item.command === command);
    return { criterion, command, observed: observed ?? null };
  });
  const gaps = [];
  if (!criteria.length)
    gaps.push("No parent-specified acceptance commands; task outcome is unknown.");
  if (!sameRevision)
    gaps.push(
      "Revision unavailable or changed during the run; repeat checks against the final state.",
    );
  if (!transcriptSaved) gaps.push("Transcript could not be saved; evidence is not durable.");
  if (!["completed", "wrapped up"].includes(status)) gaps.push(`Execution ended: ${status}.`);
  for (const check of checks)
    if (check.observed?.success !== true) gaps.push(`Not passed: ${check.criterion}`);
  const failed = checks.some((check) => check.observed?.success === false);
  const outcome = failed
    ? "failed"
    : checks.length && !gaps.length
      ? "verified"
      : evidence.length || checks.length
        ? "partial"
        : "unknown";
  return {
    outcome,
    scope: "Only the parent-specified acceptance command contracts; not a model judgment",
    revision: after,
    before,
    checks,
    evidence,
    gaps,
  };
}

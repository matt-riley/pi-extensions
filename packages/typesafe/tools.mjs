// tools.mjs — the tool names this extension registers. Plain .mjs so other
// packages (e.g. plan-mode's PLAN_TOOLS allowlist) can import the names
// without executing the extension factory. Both are read-only: typesafe_ask's
// `command` is gated read-only, and read_relevant only reads.
export const TYPESAFE_TOOLS = ["typesafe_ask", "read_relevant"];

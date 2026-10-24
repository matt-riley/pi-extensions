// tools.mjs — the tool names this extension registers. Plain .mjs so other
// modules can import the names without executing the extension factory. All
// are read-only: typesafe_ask's `command` is gated read-only; the discovery
// tools only read.
export const TYPESAFE_TOOLS = ["typesafe_ask", "read_relevant", "find_code"];

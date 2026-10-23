// MCP-shaped hints stored on Pi 1.4.0 ToolDefinition.annotations.
//
// readOnlyHint — the tool does not modify its environment.
// destructiveHint — the tool may delete or overwrite data. Meaningful when not
// read-only; false on readers so the two hints cannot contradict.
// openWorldHint — the tool reaches external entities (the web, TypeSafe), not
// a closed local domain.
//
// A derived cache under .pi/cache is not a user-data mutation: the code-search
// tools stay read-only. The cache is rebuilt from the repo and a failed write
// is ignored.

export const LOCAL_READ = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

export const OPEN_READ = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
});

export const LOCAL_DESTRUCTIVE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
});

export const OPEN_DESTRUCTIVE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
});

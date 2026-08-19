// mode-flags.mjs — tiny process-wide mode state shared across pi extensions.
//
// Multiple pi extensions load into the same Node process and can import this
// module by the same file path, so they share one copy of its module-level
// state (Node's module cache keys by resolved path). That makes this a cheap
// cross-extension coordination point: one extension sets a flag, another
// reads it, with no event bus or IPC needed.
//
// Currently just a read-only-mode flag: plan-mode sets it while active so
// other extensions (e.g. pi-subagents) can check whether the process is
// under a read-only planning session.

let readOnlyMode = false;

export function setReadOnlyMode(on) {
  readOnlyMode = Boolean(on);
}

export function isReadOnlyMode() {
  return readOnlyMode;
}

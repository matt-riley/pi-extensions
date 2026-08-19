// child-env.mjs — reference-counted PI_SUBAGENT_CHILD env var management.
//
// spawn.mjs spawns multiple children in one turn; each one wraps its
// createAgentSession call in withChildEnv() so the child process sees
// PI_SUBAGENT_CHILD=1 while its extensions load. Naive set-on-enter /
// restore-on-exit breaks when two spawns overlap: spawn A's exit can delete
// the env var while spawn B's loader is still mid-reload, letting B's child
// load pi-subagents as if it were a top-level parent (index.ts checks this
// var at factory time). Reference counting fixes that: only the first entry
// (0->1) sets the var (recording whatever was there before), and only the
// last exit (1->0) restores it.

export const CHILD_ENV = "PI_SUBAGENT_CHILD";

let depth = 0;
let prevValue;

export function acquireChildEnv() {
  if (depth === 0) {
    prevValue = process.env[CHILD_ENV];
    process.env[CHILD_ENV] = "1";
  }
  depth += 1;
}

export function releaseChildEnv() {
  if (depth === 0) return;
  depth -= 1;
  if (depth === 0) {
    if (prevValue === undefined) delete process.env[CHILD_ENV];
    else process.env[CHILD_ENV] = prevValue;
    prevValue = undefined;
  }
}

// Test-only: current depth, so tests can assert without reaching into module state directly.
export function childEnvDepthForTest() {
  return depth;
}

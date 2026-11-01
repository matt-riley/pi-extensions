# Pi's sandbox example and this collection

Reference: [Pi v1.4.0 sandbox extension](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/extensions/sandbox/index.ts).
The matching source and package manifest were inspected in the installed Pi
1.4.0 distribution. Its package pins `@anthropic-ai/sandbox-runtime` to `0.0.26`.

The example replaces the built-in `bash` tool using host `createBashTool` and
custom `BashOperations`, and wraps user shell commands through `user_bash`.
`SandboxManager.wrapWithSandbox` supplies filesystem/network restrictions using
macOS `sandbox-exec` or Linux `bubblewrap`. This is a concrete OS-isolation
implementation to adapt, complementary to the current guardrail's decisions.

## What needs adapting

| Boundary | Example behavior | Requirement for this collection |
| --- | --- | --- |
| Dependencies | Imports an installed third-party runtime and extra Pi runtime exports | A direct copy violates AGENTS.md and the convention checker. Keep an optional sandbox integration separately packaged, or explicitly revise the zero-runtime-dependency contract before integrating it here. Do not add a checker exception merely to copy the example. |
| Startup failure | Unsupported platforms and initialization failures disable sandboxing; bash falls back to the local tool | If sandboxing is requested, initialization failure must block covered execution and report why. An unsandboxed mode must be an explicit choice. |
| Policy provenance | Project settings override global/default filesystem and network arrays, including `enabled` | A project must not silently weaken an operator's restrictions. Separate operator-owned limits from project requests and report the effective policy. |
| Built-in tools | Wraps `bash`; native `read`, `write` and `edit` still run in the parent Pi process | Describe this as shell isolation. Add separate file-tool enforcement or isolate the whole process before claiming session-wide filesystem isolation. |
| Background commands | Does not wrap this collection's jobs | Apply the same launch policy in `packages/jobs/process.mjs` for both pipe and PTY execution, before spawning. Preserve process-group cleanup, human takeover, dimensions and exit evidence. |
| Child sessions | Does not configure this collection's in-process child-session tools | Pass an enforced policy through `packages/subagents/spawn.mjs` and cover child tool construction. Parent bash replacement alone does not establish child isolation. |
| Other extensions | Does not isolate their Node filesystem, HTTP or subprocess operations | State that extension code remains trusted. Whole-process isolation is a separate boundary. |
| Current directory | Captures the initial cwd for the replacement bash tool | Resolve and bind policy to the actual session/job workspace, including session changes. |
| Lifecycle | Initializes at session start and resets on shutdown | Verify reload and session-switch behavior along with shutdown, cancellation, timeout and surviving descendants. |

## Acceptance before enabling it

Use a disposable workspace and test actual OS denials: an allowed workspace
write succeeds, an outside write fails, a protected read fails and a denied
network request fails. Repeat applicable checks through built-in bash, user
shell execution, background pipe/PTY jobs and child sessions. Also test missing
runtime and initialization failure, policy weakening attempts, and cleanup.
Mocks of `wrapWithSandbox` prove wiring, not containment.

No sandbox package, dependency, user setting or execution policy is installed
or enabled by the workflow-research changes. The example supplies the design
starting point; its default fallback and coverage do not yet satisfy these
collection-wide requirements.

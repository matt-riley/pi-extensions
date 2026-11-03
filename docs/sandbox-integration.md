# Pi's sandbox example and this collection

**This collection does not enable OS-level sandboxing.** Its guardrail checks
what an agent asks to do; it does not contain every filesystem or network action.
These notes describe what a future sandbox integration would need to cover.

Pi ships a [sandbox extension example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/extensions/sandbox/index.ts).
The matching source and manifest were inspected in the installed Pi 1.4.0
distribution. Its package pins `@anthropic-ai/sandbox-runtime` to `0.0.26`.

The example replaces built-in `bash` using `createBashTool` and custom
`BashOperations`, and wraps user shell commands through `user_bash`.
`SandboxManager.wrapWithSandbox` applies filesystem and network restrictions
through macOS `sandbox-exec` or Linux `bubblewrap`.

That is a useful starting point, not a drop-in sandbox for the whole collection.
In particular, the example falls back to unsandboxed bash when initialization
fails, and it does not cover the file tools, background jobs or child sessions.

## What needs adapting

### Installation and policy

- **Dependencies:** the example imports an installed third-party runtime and
  extra Pi runtime exports. A direct copy violates this repository's dependency
  contract. Package an optional integration separately, or explicitly revise
  that contract; do not add a checker exception just to copy the example.
- **Startup failure:** requested sandboxing must fail closed and report why.
  Running without a sandbox must be an explicit choice, not a quiet fallback.
- **Policy ownership:** the example lets project settings override global/default
  filesystem and network arrays, including `enabled`. A project must not silently
  weaken operator-owned restrictions. Keep those limits separate from project
  requests and show the effective policy.

### Execution paths

| Path | What an integration must cover |
| --- | --- |
| Built-in tools | Wrapping bash leaves `read`, `write` and `edit` in the parent process. Call it shell isolation unless file-tool enforcement or whole-process isolation is also provided. |
| Background jobs | Enforce policy before both pipe and PTY launches in `packages/jobs/process.mjs`. Preserve process-group cleanup, takeover, dimensions and exit evidence. |
| Child sessions | Pass policy through `packages/subagents/spawn.mjs` and enforce it when constructing child tools. Replacing parent bash is not enough. |
| Other extensions | Their Node filesystem, HTTP and subprocess operations remain trusted. Whole-process isolation is a separate boundary. |
| Working directory | Bind policy to the actual session/job workspace, not only the initial cwd. |
| Lifecycle | Cover reload, session switches, shutdown, cancellation, timeouts and surviving descendants. |

## Acceptance before enabling it

Use a disposable workspace and test actual OS denials:

1. A permitted workspace write succeeds.
2. A write outside the permitted area fails.
3. A protected read fails.
4. A denied network request fails.

Repeat the applicable checks through built-in bash, user shell commands,
background pipe/PTY jobs and child sessions. Also test missing runtime,
initialization failure, attempts to weaken policy, and cleanup.

Mocks of `wrapWithSandbox` prove wiring, not containment. No sandbox package,
user setting or execution policy is installed or enabled by the workflow-research
changes; the example's fallback and coverage do not yet meet these requirements.

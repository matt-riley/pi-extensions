# pi-doctor: is my Pi set up the way I think it is?

A read-only health report, for when a tool is missing or doubled, or routing or a
subagent misbehaves.

```
/doctor
```

The same report is available to the agent as the deferred `doctor_report` tool
(read-only, no arguments), returned as text and as structured data.

## What it reports

- **Versions.** Pi's version and Node's.
- **Tool registry** (`pi.getAllTools()`): how many tools, by exposure; **duplicate
  names**; **deferred** tools, which only `tool_search` or `codemode` can reach;
  and **codemode-exposure** tools, which need `codemode` itself. A problem is
  raised when such tools exist and the thing that reaches them is not active
  (`pi.getActiveTools()`).
- **`router.json`**: absent (defaults apply, not a problem), parses, or does not
  parse, with the router's own error.
- **Agent files**: every `.md` in `~/.pi/agent/agents` and `<cwd>/.pi/agents` is
  run through the subagents parser, and the ones that do not parse are named.

## Unknown is not a failure

Each probe runs on its own. If one throws, for example the registry getters after
`/new` has replaced the session, that part is reported as *unknown* and the rest of
the report is unaffected. The first line is the verdict: `doctor: no problems`, or
`doctor: N problems, M unknown`.

## What it does not do

No cache cleanup, no API-key checks, no edits to any config: it reads, and prints.

`report.mjs` is pure and runs over an injected host, so it is tested with a fake
one; `files.mjs` reads `router.json` and the agent files with the same loaders
the router and subagents use.

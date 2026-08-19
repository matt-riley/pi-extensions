# 🧩 pi-extensions

Personal [Pi coding agent](https://pi.dev) extensions, built for my own use and
made shareable. Zero build step, zero runtime dependencies — each extension is
plain TypeScript loaded directly by pi.

## Extensions

| Package | Use it for |
| --- | --- |
| [`pi-exit`](./packages/exit) | `/exit` alias for pi's built-in `/quit`. |
| [`pi-plan-mode`](./packages/plan-mode) | Codex-like read-only `/plan` mode that writes a Markdown plan you edit before implementation. |
| [`pi-web-fetch`](./packages/web-fetch) | Browser-grade `web_fetch` / `batch_web_fetch` / `web_search`: clean markdown/HTML/text/JSON extraction, page metadata, GitHub URLs via `gh`, bounded-concurrency batches, keyless DuckDuckGo search. |

## Install

Clone the repo into pi's global extensions directory; pi auto-discovers the
extensions from the `pi` key in `package.json`:

```sh
git clone https://github.com/matt-riley/pi-extensions ~/.pi/agent/extensions/pi-extensions
```

then `/reload` in pi (or restart it). To update later:

```sh
git -C ~/.pi/agent/extensions/pi-extensions pull
```

then `/reload` again.

## Requirements

- **Pi** with extension support (auto-discovers `~/.pi/agent/extensions/*`).
- **No dependencies.** The only imports are pi's own `typebox` built-in and
  `node:` core modules. The `@earendil-works/pi-coding-agent` import is
  type-only and erased at runtime.

## Related

- [matt-riley/lore](https://github.com/matt-riley/lore) — local-first memory
  and continuity for the Copilot CLI *and* pi (installed separately).

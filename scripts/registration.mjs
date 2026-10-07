import { readFile, mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

// The SDK is injected by pi. Offline loading must never start a child session.
const SDK_STUB = `data:text/javascript,${encodeURIComponent(`
const unavailable = () => { throw new Error("SDK execution is unavailable in the registration stub"); };
export const getAgentDir = unavailable, parseFrontmatter = unavailable,
  createAgentSession = unavailable, DefaultResourceLoader = unavailable, SessionManager = unavailable;
`)}`;

export async function verifyRegistration(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const fixture = await mkdtemp(path.join(tmpdir(), "pi-registration-config-"));
  process.env.PI_CODING_AGENT_DIR = fixture;
  const seen = new Map();
  const results = [];
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "@earendil-works/pi-coding-agent"
        ? { url: SDK_STUB, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  try {
    for (const entry of manifest.pi.extensions) {
      let count = 0;
      const capture = (kind, name, definition) => {
        if (typeof name !== "string" || !name) throw new Error(`Invalid ${kind} name`);
        if (kind !== "event" && seen.has(`${kind}:${name}`))
          throw new Error(`Duplicate ${kind}: ${name}`);
        if (kind === "event" && typeof definition !== "function")
          throw new Error(`Invalid event handler: ${name}`);
        seen.set(`${kind}:${name}`, entry);
        count++;
      };
      const pi = {
        registerTool: (def) => capture("tool", def.name, def),
        registerCommand: (name, def) => capture("command", name, def),
        registerFlag: (name, def) => capture("flag", name, def),
        registerShortcut: (name, def) => capture("shortcut", name, def),
        registerVirtualModel: (def) => {
          if (!def.provider || !def.id) throw new Error("Virtual model requires provider and id");
          capture("model", `${def.provider}/${def.id}`, def);
        },
        on: (name, handler) => capture("event", name, handler),
      };
      try {
        const loaded = await import(pathToFileURL(path.resolve(root, entry)).href);
        await loaded.default(pi);
        if (!count) throw new Error("No registrations captured");
        results.push({ name: entry, ok: true, detail: `${count} registrations` });
      } catch (error) {
        results.push({ name: entry, ok: false, detail: error.message });
      }
    }
  } finally {
    hooks.deregister();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(fixture, { recursive: true, force: true });
  }
  return results;
}

#!/usr/bin/env node
// Repository invariants, checked from syntax rather than matching import text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { parseFrontmatter } from "../packages/skill-select/library.mjs";

const SDK = "@earendil-works/pi-coding-agent";
const SDK_EXPORTS = {
  "packages/subagents/index.ts": ["getAgentDir", "parseFrontmatter"],
  "packages/subagents/spawn.mjs": [
    "createAgentSession",
    "DefaultResourceLoader",
    "SessionManager",
    "getAgentDir",
  ],
};

export function runtimeImports(source, filename) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.isTypeOnly && !node.importClause?.isTypeOnly) {
        const bindings = node.importClause?.namedBindings ?? node.exportClause;
        const elements =
          (bindings && ts.isNamedImports(bindings)) || (bindings && ts.isNamedExports(bindings))
            ? bindings.elements
            : null;
        const names = elements
          ?.filter((item) => !item.isTypeOnly)
          .map((item) => (item.propertyName ?? item.name).text);
        if (!elements || elements.length === 0 || names.length || node.importClause?.name) {
          imports.push({
            specifier: node.moduleSpecifier.text,
            names: node.importClause?.name ? ["default", ...(names ?? [])] : names,
          });
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const arg = node.arguments[0];
      imports.push({
        specifier: arg && ts.isStringLiteralLike(arg) ? arg.text : null,
        names: null,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

export function checkConventions(root) {
  const errors = [];
  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    } catch {
      errors.push(`${file}: missing or invalid JSON`);
      return {};
    }
  };
  const manifest = readJson("package.json");
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries)) errors.push("package.json: pi.extensions must be an array");
  const registered = Array.isArray(entries) ? entries : [];
  if (new Set(registered).size !== registered.length)
    errors.push("package.json: duplicate extension registration");
  const packageDirs = fs
    .readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((item) => item.isDirectory());
  const expected = new Set(packageDirs.map((item) => `./packages/${item.name}/index.ts`));
  for (const entry of registered)
    if (!expected.has(entry)) errors.push(`Unknown extension registration: ${entry}`);
  for (const dir of packageDirs) {
    const base = `packages/${dir.name}`;
    if (!registered.includes(`./${base}/index.ts`))
      errors.push(`${base}: missing root registration`);
    for (const file of ["index.ts", "README.md"])
      if (!fs.existsSync(path.join(root, base, file))) errors.push(`${base}/${file}: missing`);
    const metadata = readJson(`${base}/package.json`);
    for (const field of ["name", "description"])
      if (typeof metadata[field] !== "string" || !metadata[field].trim())
        errors.push(`${base}/package.json: missing ${field}`);
    if (Object.hasOwn(metadata, "pi"))
      errors.push(`${base}/package.json: per-package pi registration is forbidden`);
    checkDependencies(metadata, `${base}/package.json`);
  }
  checkDependencies(manifest, "package.json");
  function checkDependencies(metadata, file) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      if (Object.keys(metadata[field] ?? {}).length)
        errors.push(`${file}: ${field} violates zero runtime dependencies`);
    }
  }
  for (const dir of ["packages", "shared"]) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const file of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      if (
        !/\.(?:ts|mjs)$/.test(file) ||
        file.endsWith(".d.ts") ||
        file.split(path.sep).includes("test")
      )
        continue;
      const relative = `${dir}/${file.split(path.sep).join("/")}`;
      for (const entry of runtimeImports(
        fs.readFileSync(path.join(root, relative), "utf8"),
        relative,
      )) {
        const specifier = entry.specifier;
        if (
          specifier?.startsWith("node:") ||
          specifier?.startsWith("./") ||
          specifier?.startsWith("../") ||
          specifier === "typebox"
        )
          continue;
        const allowed = SDK_EXPORTS[relative];
        if (
          specifier === SDK &&
          entry.names?.length &&
          allowed &&
          entry.names.every((name) => allowed.includes(name))
        )
          continue;
        errors.push(`${relative}: unapproved runtime import ${specifier ?? "<computed>"}`);
      }
    }
  }
  return errors;
}

// A prompt that names "the `x` skill" must name one this repo or the curated
// library owns. A skill that only exists under a harness's own root (e.g.
// ~/.codex/skills/.system) can vanish on that harness's next update, which is
// how /review once depended on Codex's review-agent.
const SKILL_REFERENCE = /\bthe (?:`([a-z0-9][a-z0-9-]*)`|([a-z0-9]+(?:-[a-z0-9]+)+)) skill\b/gi;
const DEFAULT_SKILL_LIBRARY = path.join(os.homedir(), ".pi", "agent", "skill-library");

function ownedSkillNames(dirs) {
  const names = new Set();
  const visited = new Set();
  const walk = (dir) => {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(real, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) walk(full);
      } else if (/^skill\.md$/i.test(entry.name)) {
        const { name } = parseFrontmatter(fs.readFileSync(full, "utf8"));
        names.add(name || path.basename(real));
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return names;
}

/** @returns {{ errors: string[], skipped: string | null }} */
export function checkSkillReferences(root, { library = DEFAULT_SKILL_LIBRARY } = {}) {
  if (!fs.existsSync(library))
    return {
      errors: [],
      skipped: `skill library ${library} not found; skill references unchecked`,
    };
  const promptDir = path.join(root, "prompts");
  if (!fs.existsSync(promptDir)) return { errors: [], skipped: null };
  const owned = ownedSkillNames([root, library]);
  const errors = [];
  for (const file of fs
    .readdirSync(promptDir)
    .filter((name) => name.endsWith(".md"))
    .sort()) {
    const text = fs.readFileSync(path.join(promptDir, file), "utf8");
    for (const match of text.matchAll(SKILL_REFERENCE)) {
      const name = match[1] ?? match[2];
      if (!owned.has(name))
        errors.push(
          `prompts/${file}: references the "${name}" skill, which is not in this repo or ${library}`,
        );
    }
  }
  return { errors, skipped: null };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = path.resolve(import.meta.dirname, "..");
  const references = checkSkillReferences(root);
  if (references.skipped) console.log(`Skipped: ${references.skipped}`);
  const errors = [...checkConventions(root), ...references.errors];
  for (const error of errors) console.error(error);
  if (!errors.length) console.log("Repository conventions pass");
  process.exitCode = errors.length ? 1 : 0;
}

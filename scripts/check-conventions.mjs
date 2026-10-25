#!/usr/bin/env node
// Repository invariants, checked from syntax rather than matching import text.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { parseFrontmatter } from "../packages/skill-select/library.mjs";

// TypeScript's bundled/native line (v7+) ships no compiler API at the package
// root — only a version shim and `typescript/unstable/*`. Parsing imports below
// needs `createSourceFile`, so say why instead of failing inside the first
// parse with "Cannot read properties of undefined (reading 'Latest')".
if (typeof ts?.createSourceFile !== "function" || ts.ScriptTarget === undefined) {
  throw new Error(
    `check-conventions needs the TypeScript 5 compiler API, and the installed ` +
      `typescript (${ts?.version ?? "unknown"}) does not expose it. Keep typescript on v5 until this ` +
      "checker moves to typescript/unstable/*.",
  );
}

const HOST_EXPORTS = {
  "@earendil-works/pi-coding-agent": {
    "packages/subagents/index.ts": ["getAgentDir", "parseFrontmatter"],
    "packages/subagents/spawn.mjs": [
      "createAgentSession",
      "DefaultResourceLoader",
      "SessionManager",
      "getAgentDir",
    ],
  },
  "@earendil-works/pi-tui": {
    "packages/jobs/index.ts": ["ScrollView", "matchesKey", "truncateToWidth"],
    "packages/workbench/index.ts": [
      "Input",
      "SelectList",
      "ScrollView",
      "matchesKey",
      "truncateToWidth",
    ],
  },
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
        const allowed = HOST_EXPORTS[specifier]?.[relative];
        if (entry.names?.length && allowed && entry.names.every((name) => allowed.includes(name)))
          continue;
        errors.push(`${relative}: unapproved runtime import ${specifier ?? "<computed>"}`);
      }
    }
  }
  return errors;
}

// Text files only: a binary that happens to hold a control byte is not a bug,
// and a stray byte inside a PNG is not a check that compares nothing.
const TEXT_FILE = /\.(?:ts|mjs|js|json|md|yml|yaml|toml|sh|txt)$/i;
const ALLOWED_CONTROL = "\n\t\r";

/**
 * Control bytes in text: a `\b` written through a template literal arrives as
 * a real backspace (0x08), so the regex that wanted a word boundary silently
 * required a backspace character instead — it matches nothing, and a check
 * that matches nothing still reports success. The same channel eats \u0000,
 * \f and \v. Cheap to look for, and the failure it prevents is invisible.
 */
export function controlByteErrors(root) {
  const errors = [];
  const skip = new Set(["node_modules", ".git", "coverage", "dist"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !TEXT_FILE.test(entry.name)) continue;
      let text;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const bad = [...text].find(
        (character) => character.charCodeAt(0) < 32 && !ALLOWED_CONTROL.includes(character),
      );
      if (bad !== undefined) {
        const code = bad.charCodeAt(0).toString(16).padStart(2, "0");
        errors.push(
          `${path.relative(root, full)}: control byte 0x${code} — a stray backspace from a template literal makes a regex match nothing`,
        );
      }
    }
  };
  walk(root);
  return errors;
}

// A helper that already lives in shared/ gets re-typed into the next package
// instead of imported, and then drifts: five copies of usableNumber disagreed
// about a blank string, and three copies of the off-flag list could disagree
// about what "off" means. shared/ is the one home, and this keeps it that way.
const SHARED_HELPERS = [
  {
    pattern: /\bfunction\s+usableNumber\s*\(/,
    what: "a local usableNumber",
    home: "shared/systemone.mjs",
  },
  {
    pattern: /\[\s*"0"\s*,\s*"false"\s*,\s*"off"\s*,\s*"no"\s*\]/,
    what: "a local off-flag list",
    home: "shared/env-flag.mjs",
  },
];

/** Copies of a shared helper in packages/, found by definition rather than by name. */
export function sharedHelperErrors(root) {
  const errors = [];
  const packages = path.join(root, "packages");
  if (!fs.existsSync(packages)) return errors;
  for (const file of fs.readdirSync(packages, { recursive: true })) {
    if (!/\.(?:ts|mjs)$/.test(file) || file.endsWith(".d.ts")) continue;
    const relative = `packages/${file.split(path.sep).join("/")}`;
    // A test may stub a helper to prove the caller handles it; the drift this
    // guards against is in runtime code.
    if (relative.split("/").includes("test")) continue;
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    for (const { pattern, what, home } of SHARED_HELPERS) {
      if (pattern.test(text)) errors.push(`${relative}: ${what} belongs in ${home}`);
    }
  }
  return errors;
}

// A file past 1000 lines stops being reviewable, and the two that already are
// must not be joined by a third: the split is a chore, so the next one should
// cost a decision rather than appear inside a feature diff. Everything past 800
// is printed on every run, so growth is visible before it becomes that chore.
const FILE_SIZE_LIMIT = 1000;
const FILE_SIZE_WATCH = 800;
// Recorded when the rule landed. An entry that fits under the limit again must
// be removed, so the list can only shrink; it is empty because both files that
// were over it have been split. Leaving it empty is the point: a new offender is
// a decision, not a line added here to silence the gate.
const FILE_SIZE_BASELINE = new Set();

const lineCount = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** Files too long to review, plus the watch list that makes growth visible. */
export function fileSizeReport(root, baseline = FILE_SIZE_BASELINE) {
  const errors = [];
  const watch = [];
  for (const dir of ["packages", "shared"]) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const file of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      if (!/\.(?:ts|mjs)$/.test(file) || file.endsWith(".d.ts")) continue;
      const relative = `${dir}/${file.split(path.sep).join("/")}`;
      // A test file accumulates cases by design; the rule is about reading code.
      if (relative.split("/").includes("test")) continue;
      const lines = lineCount(fs.readFileSync(path.join(root, relative), "utf8"));
      if (lines > FILE_SIZE_LIMIT && !baseline.has(relative))
        errors.push(
          `${relative}: ${lines} lines is past the ${FILE_SIZE_LIMIT}-line limit — split it`,
        );
      if (lines <= FILE_SIZE_LIMIT && baseline.has(relative))
        errors.push(`${relative}: now ${lines} lines, so remove it from FILE_SIZE_BASELINE`);
      if (lines > FILE_SIZE_WATCH) watch.push({ relative, lines });
    }
  }
  watch.sort((left, right) => right.lines - left.lines);
  return { errors, watch };
}

// Essential prompt dependencies belong to this checkout, not a personal
// library that may be empty locally or absent on a clean runner.
const SKILL_REFERENCE = /\bthe (?:`([a-z0-9][a-z0-9-]*)`|([a-z0-9]+(?:-[a-z0-9]+)+)) skill\b/gi;

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
      if (["node_modules", ".git", "archived", "fixtures"].includes(entry.name.toLowerCase()))
        continue;
      const full = path.join(real, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) walk(full);
      } else if (/^skill\.md$/i.test(entry.name)) {
        const { name, description } = parseFrontmatter(fs.readFileSync(full, "utf8"));
        if (name && description) names.add(name);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return names;
}

/** @returns {string[]} */
export function checkSkillReferences(root) {
  const promptDir = path.join(root, "prompts");
  if (!fs.existsSync(promptDir)) return [];
  const owned = ownedSkillNames([path.join(root, ".agents", "skills")]);
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
          `prompts/${file}: references the "${name}" skill, which is not valid in .agents/skills`,
        );
    }
  }
  return errors;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = path.resolve(import.meta.dirname, "..");
  const sizes = fileSizeReport(root);
  for (const { relative, lines } of sizes.watch)
    console.log(`watch: ${relative} is ${lines} lines`);
  const errors = [
    ...checkConventions(root),
    ...controlByteErrors(root),
    ...sharedHelperErrors(root),
    ...checkSkillReferences(root),
    ...sizes.errors,
  ];
  for (const error of errors) console.error(error);
  if (!errors.length) console.log("Repository conventions pass");
  process.exitCode = errors.length ? 1 : 0;
}

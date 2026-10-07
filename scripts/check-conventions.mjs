#!/usr/bin/env node
// Repository invariants, checked from syntax rather than matching import text.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const errors = checkConventions(path.resolve(import.meta.dirname, ".."));
  for (const error of errors) console.error(error);
  if (!errors.length) console.log("Repository conventions pass");
  process.exitCode = errors.length ? 1 : 0;
}

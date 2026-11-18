// File writer for the lint-rules skill. It does not install Oxlint or Go.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RULE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ALPHA = "Oxlint JS plugins are alpha and are not covered by semver.";
const NO_TYPES = "Type-aware rules cannot be written as JS plugins.";
const NO_MODULE_PLUGIN =
  "golangci-lint module plugins need a custom binary, so this scaffold does not use them.";
const GO_KEYWORDS = new Set([
  "break",
  "default",
  "func",
  "interface",
  "select",
  "case",
  "defer",
  "go",
  "map",
  "struct",
  "chan",
  "else",
  "goto",
  "package",
  "switch",
  "const",
  "fallthrough",
  "if",
  "range",
  "type",
  "continue",
  "for",
  "import",
  "return",
  "var",
]);

const RENDER = {
  typescript: typescriptFiles,
  "go-ruleguard": ruleguardFiles,
  "go-analysis": analysisFiles,
};

export function parseScaffoldArgs(argv) {
  const args = [...argv];
  const kind = args.shift();
  const name = args.shift();
  let dir;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag !== "--dir") throw new Error(`Unknown argument ${JSON.stringify(flag)}.`);
    dir = args.shift();
    if (!dir) throw new Error("--dir needs a path");
  }
  if (!kind || !name || dir === undefined)
    throw new Error(
      "Usage: node packages/quality/scaffold.mjs <typescript|go-ruleguard|go-analysis> <rule-name> --dir <target>",
    );
  return { kind, name, dir };
}

export function scaffoldRule({ kind, name, dir } = {}) {
  if (!Object.hasOwn(RENDER, kind))
    throw new Error(
      `Unknown scaffold kind ${JSON.stringify(kind)}. Expected typescript, go-ruleguard, or go-analysis.`,
    );
  if (typeof name !== "string" || !RULE_NAME.test(name))
    throw new Error(`Rule name must be kebab-case, got ${JSON.stringify(name)}.`);
  if (typeof dir !== "string" || dir.trim() === "") throw new Error("dir is required");
  const root = path.resolve(dir);
  const files = RENDER[kind](name);
  const rels = Object.keys(files).sort();
  const existing = rels.filter((rel) => fs.existsSync(contained(root, rel)));
  if (existing.length > 0) throw new Error(`${existing.join(", ")} already exists`);
  for (const rel of rels) {
    const target = contained(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[rel]);
  }
  return { kind, name, dir: root, files: rels };
}

function contained(root, rel) {
  const target = path.resolve(root, rel);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("scaffold path escapes the target directory");
  return target;
}

function goPackage(name) {
  const collapsed = name.replaceAll("-", "");
  if (reserved(collapsed)) return `rule${collapsed}`;
  return collapsed;
}

function goIdent(name) {
  const parts = name.split("-");
  const ident =
    parts[0] +
    parts
      .slice(1)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
  if (!reserved(ident)) return ident;
  return `rule${ident.charAt(0).toUpperCase()}${ident.slice(1)}`;
}

function reserved(ident) {
  return GO_KEYWORDS.has(ident) || ident === "main" || ident === "init";
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function typescriptFiles(name) {
  return {
    "package.json": json({
      name: `oxlint-rule-${name}`,
      private: true,
      description: `Local Oxlint JS plugin scaffold. ${ALPHA}`,
      type: "module",
      scripts: { test: "node --test plugin.test.mjs" },
      devDependencies: { oxlint: "1.94.0" },
    }),
    ".oxlintrc.json": json({
      jsPlugins: ["./plugin.mjs"],
      rules: { [`local/${name}`]: "error" },
    }),
    "plugin.mjs": pluginSource(name),
    "plugin.test.mjs": pluginTest(name),
  };
}

function pluginSource(name) {
  return `// ${ALPHA}
// ${NO_TYPES}
// Use built-in type-aware linting via oxlint-tsgolint for rules that need types.
// Rename meta.name and the "local/${name}" rule key together.

const rule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      unexpected: "do not call exampleSmell with no arguments",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "Identifier" &&
          callee.name === "exampleSmell" &&
          node.arguments.length === 0
        ) {
          context.report({ node, messageId: "unexpected" });
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "local" },
  rules: { "${name}": rule },
};

export default plugin;
`;
}

function pluginTest(name) {
  return `import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "./plugin.mjs";

// oxlint is pinned to 1.94.0 because JS plugins are not covered by semver.
RuleTester.describe = describe;
RuleTester.it = it;

const rule = plugin.rules["${name}"];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("${name}", rule, {
  valid: ["exampleSmell(1);", "other();"],
  invalid: [
    {
      code: "exampleSmell();",
      errors: [{ messageId: "unexpected" }],
    },
  ],
});
`;
}

function ruleguardFiles(name) {
  const pkg = goPackage(name);
  const ident = goIdent(name);
  return {
    "go.mod": goMod(
      pkg,
      "1.22.0",
      [
        ["github.com/quasilyte/go-ruleguard", "v0.4.5"],
        ["github.com/quasilyte/go-ruleguard/dsl", "v0.3.22"],
      ],
      [
        ["github.com/go-toolsmith/astcopy", "v1.0.2"],
        ["github.com/go-toolsmith/astequal", "v1.0.3"],
        ["github.com/quasilyte/gogrep", "v0.5.0"],
        ["github.com/quasilyte/stdinfo", "v0.0.0-20220114132959-f7386bf02567"],
        ["golang.org/x/exp/typeparams", "v0.0.0-20240213143201-ec583247a57a"],
        ["golang.org/x/tools", "v0.30.0"],
      ],
    ),
    "go.sum": RULEGUARD_SUM,
    "doc.go": docGo(
      pkg,
      "is a gocritic ruleguard scaffold for a small syntactic rule.\n// Replace the sample pattern and keep both fixtures.",
    ),
    "rules.go": rulesGo(pkg, ident),
    "rules_test.go": rulesTest(pkg),
    ".golangci.yml": golangciYml(),
    "testdata/bad.go": `package bad

func exampleSmell() {}

func use() {
\texampleSmell()
}
`,
    "testdata/good.go": `package good

func exampleSmell(n int) {}

func use() {
\texampleSmell(1)
\tother()
}

func other() {}
`,
  };
}

function analysisFiles(name) {
  const pkg = goPackage(name);
  return {
    "go.mod": goMod(
      pkg,
      "1.26.0",
      [["golang.org/x/tools", "v0.52.0"]],
      [
        ["golang.org/x/mod", "v0.42.0"],
        ["golang.org/x/sync", "v0.24.0"],
      ],
    ),
    "go.sum": ANALYSIS_SUM,
    "doc.go": docGo(
      pkg,
      "is a go/analysis scaffold for a rule that needs types.\n// Replace the sample pattern and keep both analysistest fixtures.",
    ),
    "analyzer.go": analyzerGo(pkg),
    "analyzer_test.go": analyzerTest(pkg),
    "testdata/src/bad/bad.go": `package bad

func exampleSmell() error { return nil }

func use() {
\texampleSmell() // want \`exampleSmell returns error\`
}
`,
    "testdata/src/good/good.go": `package good

func exampleSmell() int { return 0 }

func use() {
\texampleSmell()
}
`,
  };
}

function goMod(pkg, goLine, requires, indirect) {
  const entry = ([mod, version], suffix) => `\t${mod} ${version}${suffix}`;
  const direct =
    requires.length === 1
      ? `require ${requires[0][0]} ${requires[0][1]}\n`
      : `require (\n${requires.map((item) => entry(item, "")).join("\n")}\n)\n`;
  const extra = `require (\n${indirect.map((item) => entry(item, " // indirect")).join("\n")}\n)\n`;
  return `module example.com/lint/${pkg}\n\ngo ${goLine}\n\n${direct}\n${extra}`;
}

// Checksums from `go mod tidy` for the pins above. `go test` does not fill a
// missing go.sum, so the generated module has to carry one.
const RULEGUARD_SUM = `github.com/go-toolsmith/astcopy v1.0.2 h1:YnWf5Rnh1hUudj11kei53kI57quN/VH6Hp1n+erozn0=
github.com/go-toolsmith/astcopy v1.0.2/go.mod h1:4TcEdbElGc9twQEYpVo/aieIXfHhiuLh4aLAck6dO7Y=
github.com/go-toolsmith/astequal v1.0.2/go.mod h1:9Ai4UglvtR+4up+bAD4+hCj7iTo4m/OXVTSLnCyTAx4=
github.com/go-toolsmith/astequal v1.0.3 h1:+LVdyRatFS+XO78SGV4I3TCEA0AC7fKEGma+fH+674o=
github.com/go-toolsmith/astequal v1.0.3/go.mod h1:9Ai4UglvtR+4up+bAD4+hCj7iTo4m/OXVTSLnCyTAx4=
github.com/go-toolsmith/strparse v1.0.0 h1:Vcw78DnpCAKlM20kSbAyO4mPfJn/lyYA4BJUDxe2Jb4=
github.com/go-toolsmith/strparse v1.0.0/go.mod h1:YI2nUKP9YGZnL/L1/DLFBfixrcjslWct4wyljWhSRy8=
github.com/google/go-cmp v0.5.8/go.mod h1:17dUlkBOakJ0+DkrSSNjCkIjxS6bF9zb3elmeNGIjoY=
github.com/google/go-cmp v0.6.0 h1:ofyhxvXcZhMsU5ulbFiLKl/XBFqE1GSq7atu8tAmTRI=
github.com/google/go-cmp v0.6.0/go.mod h1:17dUlkBOakJ0+DkrSSNjCkIjxS6bF9zb3elmeNGIjoY=
github.com/quasilyte/go-ruleguard v0.4.5 h1:AGY0tiOT5hJX9BTdx/xBdoCubQUAE2grkqY2lSwvZcA=
github.com/quasilyte/go-ruleguard v0.4.5/go.mod h1:Vl05zJ538vcEEwu16V/Hdu7IYZWyKSwIy4c88Ro1kRE=
github.com/quasilyte/go-ruleguard/dsl v0.3.22 h1:wd8zkOhSNr+I+8Qeciml08ivDt1pSXe60+5DqOpCjPE=
github.com/quasilyte/go-ruleguard/dsl v0.3.22/go.mod h1:KeCP03KrjuSO0H1kTuZQCWlQPulDV6YMIXmpQss17rU=
github.com/quasilyte/gogrep v0.5.0 h1:eTKODPXbI8ffJMN+W2aE0+oL0z/nh8/5eNdiO34SOAo=
github.com/quasilyte/gogrep v0.5.0/go.mod h1:Cm9lpz9NZjEoL1tgZ2OgeUKPIxL1meE7eo60Z6Sk+Ng=
github.com/quasilyte/stdinfo v0.0.0-20220114132959-f7386bf02567 h1:M8mH9eK4OUR4lu7Gd+PU1fV2/qnDNfzT635KRSObncs=
github.com/quasilyte/stdinfo v0.0.0-20220114132959-f7386bf02567/go.mod h1:DWNGW8A4Y+GyBgPuaQJuWiy0XYftx4Xm/y5Jqk9I6VQ=
golang.org/x/exp/typeparams v0.0.0-20220428152302-39d4317da171/go.mod h1:AbB0pIl9nAr9wVwH+Z2ZpaocVmF5I4GyWCDIsVjR0bk=
golang.org/x/exp/typeparams v0.0.0-20240213143201-ec583247a57a h1:rrd/FiSCWtI24jk057yBSfEfHrzzjXva1VkDNWRXMag=
golang.org/x/exp/typeparams v0.0.0-20240213143201-ec583247a57a/go.mod h1:AbB0pIl9nAr9wVwH+Z2ZpaocVmF5I4GyWCDIsVjR0bk=
golang.org/x/tools v0.30.0 h1:BgcpHewrV5AUp2G9MebG4XPFI1E2W41zU1SaqVA9vJY=
golang.org/x/tools v0.30.0/go.mod h1:c347cR/OJfw5TI+GfX7RUPNMdDRRbjvYTS0jPyvsVtY=
`;

const ANALYSIS_SUM = `github.com/google/go-cmp v0.6.0 h1:ofyhxvXcZhMsU5ulbFiLKl/XBFqE1GSq7atu8tAmTRI=
github.com/google/go-cmp v0.6.0/go.mod h1:17dUlkBOakJ0+DkrSSNjCkIjxS6bF9zb3elmeNGIjoY=
golang.org/x/mod v0.42.0 h1:ICeL3t2L30ljSPHHxDnR4fqVcBt/zR2zJAb9juavmQg=
golang.org/x/mod v0.42.0/go.mod h1:u5fzIrRInkL8MaO1cbRkUHT64v303YIT5KEqpNr7jRs=
golang.org/x/sync v0.24.0 h1:iqiDrGoDgyuvAKrhLQthUEzU/R378N78gXbBjxed7oA=
golang.org/x/sync v0.24.0/go.mod h1:sUUOizhqBxiL6pEWpqNLUiaJn1ShEbZ6BBqskPbjZm0=
golang.org/x/tools v0.52.0 h1:ryxg4U63oaUYk7uOLTF37n43f4qgtGvqV4Ioit1BaEs=
golang.org/x/tools v0.52.0/go.mod h1:ItcP5UNaVGG+Yc4eIYmaFLNJ4soEopkx5Y2d4lcEurs=
`;

function docGo(pkg, summary) {
  return `// Package ${pkg} ${summary}
package ${pkg}
`;
}

function rulesGo(pkg, ident) {
  return `//go:build ruleguard

package ${pkg}

import "github.com/quasilyte/go-ruleguard/dsl"

// ${ident} matches a no-argument call. Replace this pattern.
// A rule that needs types belongs in the go-analysis scaffold.
// ${NO_MODULE_PLUGIN}
func ${ident}(m dsl.Matcher) {
\tm.Match(\`exampleSmell()\`).
\t\tReport(\`exampleSmell with no arguments is the scaffold pattern; replace this rule\`)
}
`;
}

function rulesTest(pkg) {
  return `package ${pkg}

import (
\t"go/parser"
\t"go/token"
\t"os"
\t"strings"
\t"testing"

\t"github.com/quasilyte/go-ruleguard/ruleguard"
)

func TestRuleguardFixture(t *testing.T) {
\tfset := token.NewFileSet()
\tengine := ruleguard.NewEngine()
\tengine.InferBuildContext()
\trules, err := os.Open("rules.go")
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tdefer rules.Close()
\terr = engine.Load(&ruleguard.LoadContext{Fset: fset}, "rules.go", rules)
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tbad := diagnostics(t, engine, fset, "testdata/bad.go")
\tif len(bad) != 1 || !strings.Contains(bad[0], "replace this rule") {
\t\tt.Fatalf("bad fixture: %#v", bad)
\t}
\tgood := diagnostics(t, engine, fset, "testdata/good.go")
\tif len(good) != 0 {
\t\tt.Fatalf("good fixture: %#v", good)
\t}
}

func diagnostics(t *testing.T, engine *ruleguard.Engine, fset *token.FileSet, filename string) []string {
\tt.Helper()
\tsrc, err := os.ReadFile(filename)
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tfile, err := parser.ParseFile(fset, filename, src, parser.ParseComments)
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tvar found []string
\terr = engine.Run(&ruleguard.RunContext{
\t\tFset: fset,
\t\tReport: func(data *ruleguard.ReportData) {
\t\t\tfound = append(found, data.Message)
\t\t},
\t}, file)
\tif err != nil {
\t\tt.Fatal(err)
\t}
\treturn found
}
`;
}

function golangciYml() {
  return `# Small syntactic rules use gocritic's ruleguard.
# ${NO_MODULE_PLUGIN}
# Merge this block into the repository’s existing v2 config instead of replacing a stricter one.
version: "2"
linters:
  default: none
  enable:
    - gocritic
  settings:
    gocritic:
      disable-all: true
      enabled-checks:
        - ruleguard
      settings:
        ruleguard:
          failOn: all
          rules: \${base-path}/rules.go
`;
}

function analyzerGo(pkg) {
  return `package ${pkg}

import (
\t"go/ast"
\t"go/types"

\t"golang.org/x/tools/go/analysis"
)

// ${NO_MODULE_PLUGIN}
// Replace the sample pattern. Keep the analysistest fixtures.

var Analyzer = &analysis.Analyzer{
\tName: "${pkg}",
\tDoc:  "reports a call to exampleSmell whose result type is error",
\tRun:  run,
}

func run(pass *analysis.Pass) (any, error) {
\terrorType := types.Universe.Lookup("error").Type()
\tfor _, file := range pass.Files {
\t\tast.Inspect(file, func(node ast.Node) bool {
\t\t\treturn visit(pass, node, errorType)
\t\t})
\t}
\treturn nil, nil
}

func visit(pass *analysis.Pass, node ast.Node, errorType types.Type) bool {
\tcall, ok := node.(*ast.CallExpr)
\tif !ok {
\t\treturn true
\t}
\tident, ok := call.Fun.(*ast.Ident)
\tif !ok || ident.Name != "exampleSmell" {
\t\treturn true
\t}
\tfn, ok := pass.TypesInfo.Uses[ident].(*types.Func)
\tif !ok {
\t\treturn true
\t}
\tsig, ok := fn.Type().(*types.Signature)
\tif !ok || sig.Results() == nil || sig.Results().Len() != 1 {
\t\treturn true
\t}
\tif !types.Identical(sig.Results().At(0).Type(), errorType) {
\t\treturn true
\t}
\tpass.Reportf(call.Pos(), "exampleSmell returns error")
\treturn true
}
`;
}

function analyzerTest(pkg) {
  return `package ${pkg}

import (
\t"testing"

\t"golang.org/x/tools/go/analysis/analysistest"
)

func TestAnalyzer(t *testing.T) {
\tanalysistest.Run(t, analysistest.TestData(), Analyzer, "bad", "good")
}
`;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const written = scaffoldRule(parseScaffoldArgs(process.argv.slice(2)));
    console.log(written.files.join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

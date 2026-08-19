// fallback-parser.mjs — line-based symbol extraction for non-TS/JS languages.
//
// Heuristic per language family: no tokenizer, no reliable scope ranges
// (endLine stays -1; search framing falls back to the next symbol's line).
// Covers the common cases well enough for outlines and definitions.

const EXT_TABLE = {
  ".py": "py",
  ".pyw": "py",
  ".go": "go",
  ".rs": "rs",
  ".rb": "rb",
  ".rake": "rb",
  ".java": "java",
  ".kt": "kt",
  ".kts": "kt",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".md": "md",
  ".mdx": "md",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "sh",
  ".bash": "sh",
  ".zsh": "sh",
  ".sql": "sql",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".vue": "vue",
  ".svelte": "svelte",
};

/**
 * Language label for a repo-relative path ("ts", "py", "go", …, "other").
 * The ts/js family shares one label so cache/search treat them uniformly.
 */
export function langForFile(relPath) {
  const dot = relPath.lastIndexOf(".");
  if (dot > 0) {
    const ext = relPath.slice(dot).toLowerCase();
    if (
      ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts" ||
      ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs" ||
      relPath.endsWith(".d.ts")
    ) {
      return "ts";
    }
    return EXT_TABLE[ext] ?? "other";
  }
  return "other";
}

// Each family is a list of [regex, kind, nameGroup] rules applied per line,
// in order; the first match wins. Signatures are the trimmed raw line (capped
// by the caller).
const FAMILIES = {
  py: [
    [/^\s*class\s+([A-Za-z_]\w*)/, "class", 1],
    [/^\s*async\s+def\s+([A-Za-z_]\w*)/, "function", 1],
    [/^\s*def\s+([A-Za-z_]\w*)/, "function", 1],
    [/^\s*from\s+([\w.]+)\s+import\s+(.+)$/, "import", 1],
    [/^\s*import\s+([\w.]+)/, "import", 1],
  ],
  go: [
    [/^\s*func\s*(\([^)]*\))?\s*([A-Z]\w*)/, "function", 2],
    [/^\s*func\s*(\([^)]*\))?\s*([a-z]\w*)/, "function", 2],
    [/^\s*type\s+(\w+)\s+struct/, "class", 1],
    [/^\s*type\s+(\w+)\s+interface/, "interface", 1],
    [/^\s*type\s+(\w+)\s*=\s*/, "type", 1],
    [/^\s*package\s+(\w+)/, "namespace", 1],
    [/^\s*import\s*\(/, "import", 0],
    [/^\s*import\s+"([^"]+)"/, "import", 1],
    [/^\s*import\s+([\w.]+)\s+"/, "import", 1],
  ],
  rs: [
    [/^\s*(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, "function", 1],
    [/^\s*(?:pub\s+)?struct\s+(\w+)/, "class", 1],
    [/^\s*(?:pub\s+)?enum\s+(\w+)/, "enum", 1],
    [/^\s*(?:pub\s+)?trait\s+(\w+)/, "interface", 1],
    [/^\s*(?:pub\s+)?type\s+(\w+)/, "type", 1],
    [/^\s*(?:pub\s+)?mod\s+(\w+)/, "namespace", 1],
    [/^\s*(?:pub\s+)?use\s+([\w:]+)/, "import", 1],
    [/^\s*impl\b/, "impl", 0],
  ],
  rb: [
    [/^\s*class\s+([A-Z]\w*)/, "class", 1],
    [/^\s*module\s+([A-Z]\w*)/, "namespace", 1],
    [/^\s*def\s+([A-Za-z_]\w*)/, "function", 1],
    [/^\s*require\s+["']([^"']+)["']/, "import", 1],
    [/^\s*include\s+([A-Z]\w*)/, "import", 1],
  ],
  java: [
    [/^\s*(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp|synchronized|native|transient|volatile|default|@\w+\s+)*\s*(?:class|interface|enum|record|@interface)\s+(\w+)/, "class", 1],
    [/^\s*(?:public|private|protected|static|final|abstract|synchronized|native|default|\s)*[\w<>\[\],.\s]+\([^;{]*\)\s*(?:throws\s+[\w.,\s]+)?\s*[{;]/, "method", 0],
    [/^\s*import\s+(?:static\s+)?([\w.]+);/, "import", 1],
  ],
  kt: [
    [/^\s*(?:public|private|protected|internal|override|open|abstract|sealed|data|enum|annotation|companion\s+object)?\s*(?:class|interface|enum\s+class|object)\s+(\w+)/, "class", 1],
    [/^\s*(?:public|private|protected|internal|override|open|suspend|tailrec|inline|operator|infix|external|abstract|final|reified|noinline|crossinline)?\s*(?:fun)\s+(\w+)/, "function", 1],
    [/^\s*import\s+([\w.*]+)/, "import", 1],
    [/^\s*package\s+([\w.]+)/, "namespace", 1],
  ],
  c: [
    [/^\s*#include\s*[<"]([^>"]+)[>"]/, "import", 1],
    [/^\s*typedef\s+(?:struct|enum|union)?\s*[\w]+\s+(\w+)\s*;/, "type", 1],
    [/^\s*(?:struct|class|enum|union)\s+(\w+)\b/, "class", 1],
    [/^\s*(?:static\s+|inline\s+|extern\s+|const\s+|volatile\s+|unsigned\s+|signed\s+)*[\w\s*]+\([^;{]*\)\s*[{;]/, "function", 0],
  ],
  md: [
    [/^\s{0,3}(#{1,6})\s+(.+)$/, "heading", 2],
  ],
};

// Generic fallback: universal declaration keywords, then any `name(` pattern.
const GENERIC_RULES = [
  [/^\s*(?:export\s+|default\s+|pub\s+|public\s+|private\s+|async\s+|static\s+)*(?:function|def|func|fn|class|struct|interface|type|enum|trait)\s+(\w+)/, "decl", 1],
  [/^\s*(\w+)\s*\(/, "function", 1],
];

/**
 * Extract symbols from a non-TS file's source lines.
 * @returns {{ name: string, kind: string, line: number, signature: string, startLine: number, endLine: number }[]}
 */
export function parseFallbackSource(source, { lang = "other" } = {}) {
  const symbols = [];
  const rules = FAMILIES[lang] ?? GENERIC_RULES;
  const lines = String(source ?? "").split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = lines[idx];
    const trimmed = raw.trim();
    // `#` lines are comments for code languages but headings for markdown.
    if (!trimmed || (lang !== "md" && trimmed.startsWith("#"))) continue;
    for (const [re, kind, nameGroup] of rules) {
      const m = re.exec(raw);
      if (!m) continue;
      let name = nameGroup > 0 ? (m[nameGroup] ?? "").trim() : "";
      if (!name && (kind === "method" || kind === "function")) {
        // Extract a plausible name from the signature line.
        const nameMatch = /([A-Za-z_]\w*)\s*\(/.exec(raw);
        if (nameMatch) name = nameMatch[1];
      }
      if (!name) break;
      symbols.push({
        name,
        kind,
        line: lineNo,
        signature: raw.replace(/\s+/g, " ").trim(),
        startLine: lineNo,
        endLine: -1, // no reliable range; search frames via next symbol
      });
      break;
    }
  }
  return symbols;
}

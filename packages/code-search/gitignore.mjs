// gitignore.mjs — minimal gitignore matcher for the pure-node fallback walker.
//
// Implements the pattern semantics we rely on: * ? [...] globs, ** (including
// leading `**/`, trailing `/**`, and bare `**`), ! negation, trailing `/`
// directory-only patterns, leading `/` anchoring, and later-rules-override.
// Parent-directory exclusions win over re-includes: the walker never descends
// into an excluded directory, which is git's rule (you cannot re-include a
// file whose parent directory is excluded).
//
// Pure functions — fully unit-testable without touching the filesystem.

/** A compiled ignore rule. */
export class IgnoreRule {
  constructor({ pattern, base, regex, negated, dirOnly, source }) {
    this.pattern = pattern; // raw pattern text (after ! and without trailing /)
    this.base = base; // dir (relative to walk root) the pattern applies under; "" = root
    this.regex = regex; // RegExp matching a path relative to `base`
    this.negated = negated;
    this.dirOnly = dirOnly;
    this.source = source; // human label for debugging/tests
  }

  matches(relToBase, isDir) {
    if (this.dirOnly && !isDir) return false;
    return this.regex.test(relToBase);
  }
}

// Escape everything except the glob metacharacters we translate ourselves.
function escapeGlobPart(part) {
  return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a single gitignore pattern (relative to `base`) into a RegExp.
 * Returns null for patterns that match nothing (e.g. empty).
 */
export function compilePattern(pattern, { base = "", source = "" } = {}) {
  if (!pattern) return null;
  let text = pattern;
  let negated = false;
  let dirOnly = false;

  if (text.startsWith("!")) {
    negated = true;
    text = text.slice(1);
  }
  // A pattern that is only "!" or trailing "!..." edge: git treats a lone "!"
  // as invalid; skip empties after stripping.
  if (!text) return null;

  // Trailing slash = directory-only pattern; strip for matching.
  if (text.endsWith("/") && !text.endsWith("\\/")) {
    dirOnly = true;
    text = text.slice(0, -1);
  }
  if (!text) return null;

  // A pattern without any slash (other than a possible trailing one, removed
  // above) matches the basename at any depth below base.
  const hasSlash = text.includes("/");
  let body = text;
  let anchored = false;
  if (hasSlash) {
    anchored = true; // patterns containing a slash are anchored to base
    if (body.startsWith("/")) body = body.slice(1);
  }

  // Translate glob → regex, handling ** specially.
  let out = "";
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (c === "/" && body[i + 1] === "*" && body[i + 2] === "*" && i + 3 === n) {
      // Trailing "/**": everything *inside* this directory (not the dir
      // itself, matching git). The literal slash is part of the group.
      out += "(?:/.*)";
      i = n;
      continue;
    }
    if (c === "*") {
      // Count consecutive stars.
      let j = i;
      while (j < n && body[j] === "*") j++;
      const starCount = j - i;
      const prevIsSlash = i > 0 && body[i - 1] === "/";
      const nextIsSlash = j < n && body[j] === "/";
      const isTrailing = j === n;
      if (starCount >= 2) {
        // `**` only behaves specially when it's a full path segment; the
        // adjacent slash is consumed so `**/` matches zero or more dirs.
        if (prevIsSlash && nextIsSlash) {
          // "/**/" — zero or more directories between two slashes
          out += "(?:.*/)?";
          i = j + 1;
        } else if (prevIsSlash && isTrailing) {
          // trailing "/**" (unreachable via the check above when it's the
          // last segment, but kept for patterns like "a/**")
          out += "(?:/.*)?";
          i = j;
        } else if (i === 0 && nextIsSlash) {
          // leading "**/" — zero or more directories at the start
          out += "(?:.*/)?";
          i = j + 1;
        } else {
          // Bare or mid-segment `**` degrades to `*` (matches git).
          out += starCount > 0 ? "[^/]*" : "";
          i = j;
        }
        continue;
      }
      out += "[^/]*";
      i = j;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      // Character class: copy through to the closing ']' (no nested escape
      // handling beyond a leading ! or ^).
      let j = i + 1;
      let cls = "";
      if (body[j] === "!" || body[j] === "^") {
        cls += "^";
        j++;
      }
      let closed = false;
      while (j < n) {
        const cc = body[j];
        cls += cc;
        j++;
        if (cc === "]") {
          closed = true;
          break;
        }
        if (cc === "\\" && j < n) {
          cls += body[j];
          j++;
        }
      }
      if (closed) {
        out += `[${cls}`; // cls already includes its closing ']'
        i = j;
      } else {
        // Unclosed '[' — literal.
        out += "\\[";
        i++;
      }
      continue;
    }
    if (c === "\\") {
      if (i + 1 < n) {
        out += escapeGlobPart(body[i + 1]);
        i += 2;
      } else {
        out += "\\\\";
        i++;
      }
      continue;
    }
    out += escapeGlobPart(c);
    i++;
  }

  let sourceRe = out;
  if (!anchored) {
    // Basename pattern: match at any depth under base.
    sourceRe = `(?:^|/)${sourceRe}$`;
  } else {
    sourceRe = `^${sourceRe}$`;
  }

  let regex;
  try {
    regex = new RegExp(sourceRe);
  } catch {
    return null;
  }

  return new IgnoreRule({ pattern, base, regex, negated, dirOnly, source });
}

/** Parse the contents of one .gitignore-style file into compiled rules. */
export function parseGitignore(text, { base = "", source = "inline" } = {}) {
  const rules = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;
    // Trailing spaces are significant in git only when escaped; we trim them
    // (git's default is to strip trailing spaces unless "\ " escaped).
    const rule = compilePattern(line, { base, source });
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Match a path (relative to the walk root, posix) against a rule list.
 * Rules apply in order; the last matching rule wins.
 * @param {string} relPath
 * @param {boolean} isDir
 * @param {IgnoreRule[]} rules
 * @returns {boolean} true = ignored
 */
export function matchPath(relPath, isDir, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.base && !(relPath === rule.base || relPath.startsWith(rule.base + "/"))) {
      continue; // rule applies only under its base dir
    }
    const relToBase = rule.base ? relPath.slice(rule.base.length + 1) : relPath;
    if (rule.matches(relToBase, isDir)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

/**
 * Collect ignore rules for a walk rooted at `rootDir`, given a function that
 * reads a file's text (for .gitignore / exclude files) or returns null.
 * Order matters: later rules override earlier ones, so the list is
 * [global excludes, .git/info/exclude, root .gitignore, ...nested].
 */
export function collectRules({ rootDir, readFile, homeDir }) {
  const rules = [];

  // Global excludes: $XDG_CONFIG_HOME/git/ignore, ~/.config/git/ignore, or
  // the legacy ~/.gitignore_global. We cannot read git config without git, so
  // these are best-effort defaults.
  const xdg = process.env.XDG_CONFIG_HOME;
  const candidates = [];
  if (xdg) candidates.push(`${xdg}/git/ignore`);
  const h = homeDir ?? (typeof process.env.HOME === "string" ? process.env.HOME : "");
  if (h) {
    candidates.push(`${h}/.config/git/ignore`);
    candidates.push(`${h}/.gitignore_global`);
  }
  for (const c of candidates) {
    const text = readFile(c);
    if (text != null) rules.push(...parseGitignore(text, { base: "", source: `global:${c}` }));
  }

  // .git/info/exclude inside the repo.
  const infoExclude = `${rootDir}/.git/info/exclude`;
  const infoText = readFile(infoExclude);
  if (infoText != null) {
    rules.push(...parseGitignore(infoText, { base: "", source: ".git/info/exclude" }));
  }

  // Root .gitignore (applied below every path in the walk).
  const rootGitignore = readFile(`${rootDir}/.gitignore`);
  if (rootGitignore != null) {
    rules.push(...parseGitignore(rootGitignore, { base: "", source: ".gitignore" }));
  }

  return rules;
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

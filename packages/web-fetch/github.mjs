// github.mjs — GitHub URL handling via the `gh` CLI.
//
// For github.com / gist.github.com URLs the `gh` CLI is a strictly better
// fetch path than scraping HTML: authenticated (higher rate limits, private
// repos), structured JSON, and raw file content. We map URL shapes to `gh api`
// REST endpoints, render the JSON into the same outcome shape the rest of the
// extension produces, and fall back to plain HTTP when `gh` is missing or
// unauthenticated.
//
// Everything except the execFile calls is pure and unit-testable.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024; // gh output cap (raw files can be big)

let ghStatus = null; // null = unknown, true/false = cached probe

// --- URL parsing ------------------------------------------------------------

// Returns null for non-GitHub hosts, and a descriptor for GitHub hosts:
//   { kind: "repo"|"profile"|"gist"|"blob"|"tree"|"raw"|"issue"|"pull"|
//          "discussion"|"release"|"releases"|"commit"|"commits"|"generic",
//     owner, repo, ref, path, number, tag, id }
// `generic` means a GitHub URL we do not special-case (actions, settings,
// wiki, …) — the caller should fall back to plain HTTP.
export function parseGithubUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const isGist = host === "gist.github.com";
  const isGithub = host === "github.com" || host === "www.github.com" || isGist;
  if (!isGithub) return null;

  const segs = parsed.pathname.split("/").filter((s) => s.length > 0);

  if (isGist) {
    // gist.github.com/<owner>/<id> or gist.github.com/<id>
    if (segs.length === 1) return { kind: "gist", id: segs[0] };
    return { kind: "gist", id: segs[1] };
  }

  if (segs.length === 0) return { kind: "generic", path: "" };
  const owner = segs[0];

  if (segs.length === 1) return { kind: "profile", owner };

  const repo = segs[1].replace(/\.git$/, "");
  const sub = segs[2];

  if (!sub) return { kind: "repo", owner, repo };

  const rest = segs.slice(3);

  switch (sub) {
    case "blob":
    case "tree":
    case "raw": {
      const [ref = "", ...pathSegs] = rest;
      return { kind: sub, owner, repo, ref, path: pathSegs.join("/") };
    }
    case "issues": {
      if (rest.length === 1 && /^\d+$/.test(rest[0])) {
        return { kind: "issue", owner, repo, number: Number(rest[0]) };
      }
      return { kind: "generic", owner, repo, sub };
    }
    case "pull":
    case "pulls": {
      if (rest.length === 1 && /^\d+$/.test(rest[0])) {
        return { kind: "pull", owner, repo, number: Number(rest[0]) };
      }
      return { kind: "generic", owner, repo, sub };
    }
    case "discussions": {
      if (rest.length === 1 && /^\d+$/.test(rest[0])) {
        return { kind: "discussion", owner, repo, number: Number(rest[0]) };
      }
      return { kind: "generic", owner, repo, sub };
    }
    case "releases": {
      if (rest[0] === "tag" && rest[1]) return { kind: "release", owner, repo, tag: rest[1] };
      if (rest[0] === "latest") return { kind: "release", owner, repo, tag: "latest" };
      return { kind: "releases", owner, repo };
    }
    case "commit": {
      if (rest[0]) return { kind: "commit", owner, repo, ref: rest[0] };
      return { kind: "generic", owner, repo, sub };
    }
    case "commits": {
      return { kind: "commits", owner, repo, ref: rest[0] ?? "" };
    }
    default:
      return { kind: "generic", owner, repo, sub };
  }
}

export function isGithubUrl(url) {
  return parseGithubUrl(url) !== null;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateNames(owner, repo) {
  if (!NAME_RE.test(owner)) throw new Error(`Invalid GitHub owner "${owner}".`);
  if (repo && !NAME_RE.test(repo)) throw new Error(`Invalid GitHub repo "${repo}".`);
}

// ref/path ambiguity: /blob/<a>/<b>/<c> can mean ref=a path=b/c, ref=a/b
// path=c, or ref=a/b/c path="". Try the plausible splits in order.
export function refPathCandidates(ref, path) {
  const total = [ref, ...(path ? path.split("/") : [])].filter((s) => s.length > 0);
  if (total.length === 0) return [{ ref: "", path: "" }];
  const max = Math.min(3, total.length);
  const out = [];
  for (let i = 0; i < max; i++) {
    out.push({ ref: total.slice(0, i + 1).join("/"), path: total.slice(i + 1).join("/") });
  }
  return out;
}

// --- gh availability --------------------------------------------------------

// Probes whether `gh` is installed AND authenticated. Cached per process;
// /reload resets it.
export async function ghAvailable() {
  if (ghStatus !== null) return ghStatus;
  try {
    await execFileAsync("gh", ["--version"], { timeout: 3000 });
    await execFileAsync("gh", ["auth", "status"], { timeout: 5000 });
    ghStatus = true;
  } catch {
    ghStatus = false;
  }
  return ghStatus;
}

// Test hook.
export function _setGhAvailable(value) {
  ghStatus = value;
}

class GhApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GhApiError";
    this.status = status;
  }
}

async function ghApi(args, { timeoutMs = 15000, signal } = {}) {
  try {
    const { stdout } = await execFileAsync("gh", ["api", ...args], {
      timeout: timeoutMs,
      signal,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
    });
    return stdout;
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    const statusMatch = /\(HTTP (\d+)\)/.exec(stderr);
    const detail = statusMatch
      ? `GitHub API ${statusMatch[1]}`
      : stderr.trim() || err?.message || "gh failed";
    throw new GhApiError(detail, statusMatch ? Number(statusMatch[1]) : undefined);
  }
}

// Test hook: replace the gh subprocess call with a fake that returns fixture
// payloads keyed by endpoint.
let ghApiImpl = ghApi;
export function _setGhApi(fn) {
  ghApiImpl = fn;
}
// --- Fetch + render ---------------------------------------------------------

// Fetches a parsed GitHub URL via gh and renders it into the standard outcome
// shape. Returns { usedGh, outcome } — outcome is undefined when the kind was
// not handled (usedGh false).
export async function fetchGithub(parsed, opts = {}) {
  switch (parsed.kind) {
    case "repo": return { usedGh: true, outcome: await fetchRepo(parsed, opts) };
    case "profile": return { usedGh: true, outcome: await fetchProfile(parsed, opts) };
    case "gist": return { usedGh: true, outcome: await fetchGist(parsed, opts) };
    case "blob":
    case "raw": return { usedGh: true, outcome: await fetchFile(parsed, opts) };
    case "tree": return { usedGh: true, outcome: await fetchTree(parsed, opts) };
    case "issue": return { usedGh: true, outcome: await fetchIssue(parsed, opts) };
    case "pull": return { usedGh: true, outcome: await fetchPull(parsed, opts) };
    case "discussion": return { usedGh: true, outcome: await fetchDiscussion(parsed, opts) };
    case "release": return { usedGh: true, outcome: await fetchRelease(parsed, opts) };
    case "releases": return { usedGh: true, outcome: await fetchReleases(parsed, opts) };
    case "commit": return { usedGh: true, outcome: await fetchCommit(parsed, opts) };
    case "commits": return { usedGh: true, outcome: await fetchCommits(parsed, opts) };
    default: return { usedGh: false };
  }
}

function outcome(parsed, fields) {
  const base = `https://github.com/${parsed.owner}/${parsed.repo ?? ""}`.replace(/\/$/, "");
  return {
    kind: "page",
    source: "github",
    finalUrl: base,
    status: 200,
    mime: "text/markdown",
    title: "",
    description: "",
    author: parsed.owner ?? "",
    siteName: "GitHub",
    published: "",
    lang: "",
    html: "",
    via: "GitHub API (gh)",
    ...fields,
  };
}

// Truncate helper honoring opts.maxChars.
function cap(text, opts) {
  const max = opts?.maxChars ?? 60000;
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  if (lastBreak > max * 0.6) cut = cut.slice(0, lastBreak);
  return { text: `${cut.trimEnd()}\n… [truncated]`, truncated: true };
}

const firstLine = (s) => (s ?? "").split("\n")[0] ?? "";

async function fetchRepo(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  const repoJson = JSON.parse(await ghApiImpl([`repos/${parsed.owner}/${parsed.repo}`], opts));
  let readme = "";
  try {
    readme = await ghApiImpl(
      ["-H", "Accept: application/vnd.github.raw", `repos/${parsed.owner}/${parsed.repo}/readme`],
      opts,
    );
  } catch (err) {
    if (err.status !== 404) throw err; // no README is fine
  }

  const md = [
    `# ${parsed.owner}/${parsed.repo}`,
    "",
    repoJson.description ? `${repoJson.description}\n` : "",
    `Stars: ${repoJson.stargazers_count ?? 0} · Forks: ${repoJson.forks_count ?? 0}` +
      ` · Language: ${repoJson.language ?? "—"} · License: ${repoJson.license?.spdx_id ?? "—"}` +
      (repoJson.updated_at ? ` · Updated: ${repoJson.updated_at.slice(0, 10)}` : ""),
    ...(Array.isArray(repoJson.topics) && repoJson.topics.length
      ? ["", `Topics: ${repoJson.topics.join(", ")}`]
      : []),
    "",
    "---",
    "",
    readme ? readme.trim() : "_No README found._",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `${parsed.owner}/${parsed.repo}`,
    description: repoJson.description ?? "",
    published: repoJson.created_at ? repoJson.created_at.slice(0, 10) : "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    jsonBody: { ...repoJson, readme },
    rawBody: JSON.stringify(repoJson, null, 2),
  });
}

async function fetchFile(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  let body = "";
  let used = null;
  for (const { ref, path } of refPathCandidates(parsed.ref, parsed.path)) {
    const endpoint = `repos/${parsed.owner}/${parsed.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
    try {
      body = await ghApiImpl(["-H", "Accept: application/vnd.github.raw", endpoint], opts);
      used = { ref, path };
      break;
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
  }
  if (used === null) {
    throw new GhApiError(
      `GitHub file not found: ${parsed.owner}/${parsed.repo} ${parsed.path || parsed.ref || ""} (ref not found or file missing)`,
      404,
    );
  }

  const ext = (used.path.split(".").pop() ?? "").toLowerCase();
  const lang = EXT_LANG[ext] ?? "";
  const bodyTrimmed = body.trim();
  const isMarkdown = ext === "md" || ext === "markdown" || ext === "mdx";

  let md;
  if (isMarkdown) {
    md = bodyTrimmed;
  } else {
    const fence = bodyTrimmed.includes("```") ? "~~~~" : "```";
    md = `${fence}${lang}\n${bodyTrimmed}\n${fence}`;
  }

  const capped = cap(md, opts);
  const textCapped = cap(bodyTrimmed, opts);
  return outcome(parsed, {
    title: `${parsed.owner}/${parsed.repo} — ${used.path} @ ${used.ref}`,
    description: "",
    published: "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: textCapped.text,
    rawBody: body,
    jsonBody: {
      url: `https://github.com/${parsed.owner}/${parsed.repo}/blob/${used.ref}/${used.path}`,
      ref: used.ref,
      path: used.path,
      size: body.length,
      content: body,
    },
  });
}

async function fetchTree(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  let listing = null;
  let used = null;
  for (const { ref, path } of refPathCandidates(parsed.ref, parsed.path)) {
    const endpoint = `repos/${parsed.owner}/${parsed.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
    try {
      listing = JSON.parse(await ghApiImpl([endpoint], opts));
      used = { ref, path };
      break;
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
  }
  if (used === null) {
    throw new GhApiError(
      `GitHub path not found: ${parsed.owner}/${parsed.repo} ${parsed.path || parsed.ref || ""}`,
      404,
    );
  }

  if (!Array.isArray(listing)) {
    // tree URL pointing at a single file — render it as a file
    const fileParsed = { ...parsed, kind: "blob", ref: used.ref, path: used.path };
    return fetchFile(fileParsed, opts);
  }

  const lines = [`# ${parsed.owner}/${parsed.repo} — ${used.path || "/"} @ ${used.ref}`, ""];
  for (const entry of listing) {
    const name = entry.name ?? "";
    if (entry.type === "dir") lines.push(`- ${name}/`);
    else {
      const size = entry.size != null ? ` (${formatBytes(entry.size)})` : "";
      lines.push(`- ${name}${size}`);
    }
  }

  const md = lines.join("\n");
  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `${parsed.owner}/${parsed.repo} — ${used.path || "/"} @ ${used.ref}`,
    description: "",
    published: "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    rawBody: JSON.stringify(listing, null, 2),
    jsonBody: listing,
  });
}

async function fetchIssue(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  const issue = JSON.parse(await ghApiImpl([`repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`], opts));
  let comments = [];
  try {
    comments = JSON.parse(
      await ghApiImpl([`repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments?per_page=50`], opts),
    );
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  return issueOutcome(parsed, "issue", issue, comments, opts);
}

async function fetchPull(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  const pull = JSON.parse(await ghApiImpl([`repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`], opts));
  let comments = [];
  try {
    comments = JSON.parse(
      await ghApiImpl([`repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments?per_page=50`], opts),
    );
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  return issueOutcome(parsed, "pull", pull, comments, opts);
}

function issueOutcome(parsed, kind, data, comments, opts) {
  const labels = (data.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter(Boolean)
    .join(", ");
  const metaBits = [
    `state: ${data.state ?? "?"}`,
    labels ? `labels: ${labels}` : "",
    data.user ? `author: ${data.user.login}` : "",
    data.created_at ? `opened: ${data.created_at.slice(0, 10)}` : "",
    data.comments != null ? `comments: ${data.comments}` : "",
  ].filter(Boolean);

  const md = [
    `# ${kind === "pull" ? "PR" : "Issue"} #${data.number}: ${data.title ?? ""}`,
    "",
    metaBits.join(" · "),
    "",
    "---",
    "",
    data.body?.trim() || "_No description._",
    ...(comments.length
      ? ["", "## Comments", "", ...comments.flatMap((c) => [
          `### ${c.user?.login ?? "?"} — ${(c.created_at ?? "").slice(0, 10)}`,
          "",
          (c.body ?? "").trim() || "_empty_",
          "",
        ])]
      : []),
  ].join("\n");

  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `${kind === "pull" ? "PR" : "Issue"} #${data.number}: ${data.title ?? ""}`,
    description: (data.body ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    published: data.created_at ? data.created_at.slice(0, 10) : "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    rawBody: JSON.stringify({ ...data, comments }, null, 2),
    jsonBody: { ...data, comments },
  });
}

async function fetchDiscussion(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  const disc = JSON.parse(
    await ghApiImpl([`repos/${parsed.owner}/${parsed.repo}/discussions/${parsed.number}`], opts),
  );
  const md = [
    `# Discussion #${disc.number}: ${disc.title ?? ""}`,
    "",
    `author: ${disc.user?.login ?? "?"} · created: ${(disc.created_at ?? "").slice(0, 10)}`,
    "",
    "---",
    "",
    disc.body?.trim() || "_No description._",
  ].join("\n");
  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `Discussion #${disc.number}: ${disc.title ?? ""}`,
    description: (disc.body ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    published: disc.created_at ? disc.created_at.slice(0, 10) : "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    rawBody: JSON.stringify(disc, null, 2),
    jsonBody: disc,
  });
}

async function fetchRelease(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  const endpoint =
    parsed.tag === "latest"
      ? `repos/${parsed.owner}/${parsed.repo}/releases/latest`
      : `repos/${parsed.owner}/${parsed.repo}/releases/tags/${encodeURIComponent(parsed.tag)}`;
  const rel = JSON.parse(await ghApiImpl([endpoint], opts));
  const md = [
    `# Release ${rel.tag_name ?? ""}${rel.name && rel.name !== rel.tag_name ? ` — ${rel.name}` : ""}`,
    "",
    `published: ${(rel.published_at ?? "").slice(0, 10)}${rel.prerelease ? " · prerelease" : ""}${rel.draft ? " · draft" : ""}`,
    "",
    "---",
    "",
    rel.body?.trim() || "_No release notes._",
  ].join("\n");
  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `Release ${rel.tag_name ?? ""}`,
    description: (rel.body ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    published: rel.published_at ? rel.published_at.slice(0, 10) : "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    rawBody: JSON.stringify(rel, null, 2),
    jsonBody: rel,
  });
}

async function fetchReleases(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  const rels = JSON.parse(await ghApiImpl([`repos/${parsed.owner}/${parsed.repo}/releases?per_page=20`], opts));
  const md = [
    `# Releases (${parsed.owner}/${parsed.repo})`,
    "",
    ...rels.flatMap((rel) => [
      `## ${rel.tag_name ?? ""}${rel.name && rel.name !== rel.tag_name ? ` — ${rel.name}` : ""}`,
      `published: ${(rel.published_at ?? "").slice(0, 10)}${rel.prerelease ? " · prerelease" : ""}`,
      "",
      rel.body?.trim() || "_No release notes._",
      "",
    ]),
  ].join("\n");
  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `Releases (${parsed.owner}/${parsed.repo})`,
    description: `${rels.length} releases`,
    published: rels[0]?.published_at?.slice(0, 10) ?? "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    rawBody: JSON.stringify(rels, null, 2),
    jsonBody: rels,
  });
}

async function fetchCommit(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  const c = JSON.parse(
    await ghApiImpl([`repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(parsed.ref)}`], opts),
  );
  const author = c.commit?.author?.name ?? c.author?.login ?? "?";
  const stats = c.stats ?? {};
  const subject = firstLine(c.commit?.message);
  const body = (c.commit?.message ?? "").split("\n").slice(1).join("\n").trim();
  const md = [
    `# ${(c.sha ?? "").slice(0, 12)} — ${subject}`,
    "",
    `${author} — ${(c.commit?.author?.date ?? "").slice(0, 10)}`,
    ...(body ? ["", "---", "", body] : []),
    "",
    `Files changed: ${stats.total ?? "?"} · Additions: ${stats.additions ?? "?"} · Deletions: ${stats.deletions ?? "?"}`,
  ].join("\n");
  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `${(c.sha ?? "").slice(0, 12)} — ${subject}`,
    description: subject,
    published: c.commit?.author?.date?.slice(0, 10) ?? "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    rawBody: JSON.stringify(c, null, 2),
    jsonBody: c,
  });
}

async function fetchCommits(parsed, opts) {
  validateNames(parsed.owner, parsed.repo);
  const refQuery = parsed.ref ? `&sha=${encodeURIComponent(parsed.ref)}` : "";
  const commits = JSON.parse(
    await ghApiImpl([`repos/${parsed.owner}/${parsed.repo}/commits?per_page=20${refQuery}`], opts),
  );
  const md = [
    `# Commits (${parsed.owner}/${parsed.repo}${parsed.ref ? ` @ ${parsed.ref}` : ""})`,
    "",
    ...commits.map((c) => {
      const msg = firstLine(c.commit?.message);
      const who = c.commit?.author?.name ?? c.author?.login ?? "?";
      const when = c.commit?.author?.date?.slice(0, 10) ?? "";
      return `- \`${(c.sha ?? "").slice(0, 7)}\` ${msg} (${who}, ${when})`;
    }),
  ].join("\n");
  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `Commits (${parsed.owner}/${parsed.repo}${parsed.ref ? ` @ ${parsed.ref}` : ""})`,
    description: `${commits.length} commits`,
    published: commits[0]?.commit?.author?.date?.slice(0, 10) ?? "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    rawBody: JSON.stringify(commits, null, 2),
    jsonBody: commits,
  });
}

async function fetchGist(parsed, opts) {
  const gist = JSON.parse(await ghApiImpl([`gists/${encodeURIComponent(parsed.id)}`], opts));
  const files = Object.values(gist.files ?? {});
  const md = [
    `# Gist ${gist.description || parsed.id}`,
    "",
    `author: ${gist.owner?.login ?? "?"} · updated: ${(gist.updated_at ?? "").slice(0, 10)} · files: ${files.map((f) => f.filename).join(", ")}`,
    "",
    ...files.flatMap((f) => [
      `## ${f.filename}`,
      "",
      `\`\`\`${EXT_LANG[(f.filename.split(".").pop() ?? "").toLowerCase()] ?? ""}\n${f.content ?? ""}\n\`\`\``,
      "",
    ]),
  ].join("\n");
  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `Gist ${gist.description || parsed.id}`,
    description: gist.description ?? "",
    published: gist.created_at?.slice(0, 10) ?? "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    rawBody: JSON.stringify(gist, null, 2),
    jsonBody: gist,
  });
}

async function fetchProfile(parsed, opts) {
  const u = JSON.parse(await ghApiImpl([`users/${encodeURIComponent(parsed.owner)}`], opts));
  const md = [
    `# ${u.login}${u.name ? ` (${u.name})` : ""}`,
    "",
    u.bio || "_No bio._",
    "",
    [
      u.company ? `Company: ${u.company}` : "",
      u.location ? `Location: ${u.location}` : "",
      u.blog ? `Blog: ${u.blog}` : "",
      `Followers: ${u.followers ?? 0}`,
      `Following: ${u.following ?? 0}`,
      `Public repos: ${u.public_repos ?? 0}`,
      u.created_at ? `Joined: ${u.created_at.slice(0, 10)}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  ].join("\n");
  const capped = cap(md, opts);
  return outcome(parsed, {
    title: `${u.login}${u.name ? ` (${u.name})` : ""}`,
    description: u.bio ?? "",
    published: u.created_at?.slice(0, 10) ?? "",
    markdown: capped.text,
    truncated: capped.truncated,
    text: capped.text,
    rawBody: JSON.stringify(u, null, 2),
    jsonBody: u,
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const EXT_LANG = {
  md: "", markdown: "", mdx: "", txt: "", text: "", license: "",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", tsx: "tsx", py: "python", rb: "ruby", go: "go",
  rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cc: "cpp", cs: "csharp", php: "php", swift: "swift", kt: "kotlin",
  scala: "scala", sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
  yaml: "yaml", yml: "yaml", toml: "toml", json: "json", jsonc: "jsonc",
  xml: "xml", html: "html", htm: "html", css: "css", scss: "scss",
  sql: "sql", r: "r", dart: "dart", lua: "lua", zig: "zig",
  elixir: "elixir", ex: "elixir", exs: "elixir", erl: "erlang",
  hs: "haskell", ml: "ocaml", fs: "fsharp", vue: "vue", svelte: "svelte",
  dockerfile: "dockerfile", makefile: "makefile", cmake: "cmake",
  diff: "diff", patch: "diff", ini: "ini", conf: "ini", env: "ini",
  csv: "csv", tsv: "tsv", graphql: "graphql", gql: "graphql",
  proto: "protobuf", gradle: "gradle", kts: "kotlin", tf: "hcl",
  hcl: "hcl", dockerignore: "", gitignore: "",
};

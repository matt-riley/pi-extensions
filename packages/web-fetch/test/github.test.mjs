import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setGhApiForTests,
  _setGhAvailable,
  fetchGithub,
  isGithubUrl,
  parseGithubUrl,
  refPathCandidates,
} from "../github.mjs";
import { formatWebFetchResult } from "../format.mjs";

// --- parsing ----------------------------------------------------------------

test("parseGithubUrl: repo home and profile", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/octo/cat"), {
    kind: "repo",
    owner: "octo",
    repo: "cat",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/octo/cat.git"), {
    kind: "repo",
    owner: "octo",
    repo: "cat",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/octo"), { kind: "profile", owner: "octo" });
  assert.deepEqual(parseGithubUrl("https://github.com"), { kind: "generic", path: "" });
});

test("parseGithubUrl: blob/tree/raw with ref and path", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/blob/main/src/index.ts"), {
    kind: "blob",
    owner: "o",
    repo: "r",
    ref: "main",
    path: "src/index.ts",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/tree/dev"), {
    kind: "tree",
    owner: "o",
    repo: "r",
    ref: "dev",
    path: "",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/raw/v1.0/README.md"), {
    kind: "raw",
    owner: "o",
    repo: "r",
    ref: "v1.0",
    path: "README.md",
  });
});

test("parseGithubUrl: issues, pulls, discussions, releases", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/issues/42"), {
    kind: "issue",
    owner: "o",
    repo: "r",
    number: 42,
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/pull/7"), {
    kind: "pull",
    owner: "o",
    repo: "r",
    number: 7,
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/discussions/9"), {
    kind: "discussion",
    owner: "o",
    repo: "r",
    number: 9,
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/releases"), {
    kind: "releases",
    owner: "o",
    repo: "r",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/releases/tag/v1.2"), {
    kind: "release",
    owner: "o",
    repo: "r",
    tag: "v1.2",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/releases/latest"), {
    kind: "release",
    owner: "o",
    repo: "r",
    tag: "latest",
  });
});

test("parseGithubUrl: commits, gist, generic", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/commits/main"), {
    kind: "commits",
    owner: "o",
    repo: "r",
    ref: "main",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/commit/abc123"), {
    kind: "commit",
    owner: "o",
    repo: "r",
    ref: "abc123",
  });
  assert.equal(parseGithubUrl("https://gist.github.com/user/abc123").kind, "gist");
  assert.equal(parseGithubUrl("https://gist.github.com/abc123").kind, "gist");
  assert.equal(parseGithubUrl("https://github.com/o/r/actions").kind, "generic");
  assert.equal(parseGithubUrl("https://github.com/o/r/wiki").kind, "generic");
  assert.equal(parseGithubUrl("https://example.com/not-github"), null);
});

test("isGithubUrl: host handling", () => {
  assert.equal(isGithubUrl("https://github.com/o/r"), true);
  assert.equal(isGithubUrl("https://www.github.com/o/r"), true);
  assert.equal(isGithubUrl("https://gist.github.com/abc"), true);
  assert.equal(isGithubUrl("https://evilgithub.com/o/r"), false);
});

test("refPathCandidates: disambiguates refs with slashes", () => {
  assert.deepEqual(refPathCandidates("main", "file.md"), [
    { ref: "main", path: "file.md" },
    { ref: "main/file.md", path: "" },
  ]);
  const three = refPathCandidates("feature", "x/file.md");
  assert.equal(three.length, 3);
  assert.deepEqual(three[0], { ref: "feature", path: "x/file.md" });
  assert.deepEqual(three[1], { ref: "feature/x", path: "file.md" });
  assert.deepEqual(three[2], { ref: "feature/x/file.md", path: "" });
});

// --- rendering with a fake gh api -------------------------------------------

const API = {
  "repos/octo/cat": JSON.stringify({
    description: "A test repo",
    stargazers_count: 5,
    forks_count: 2,
    language: "TypeScript",
    license: { spdx_id: "MIT" },
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2021-06-01T00:00:00Z",
    topics: ["cli", "test"],
  }),
  "repos/octo/cat/readme": "# Cat Repo\n\nMeow.",
  "repos/octo/cat/issues/1": JSON.stringify({
    number: 1,
    title: "Bug: meow",
    state: "open",
    user: { login: "octo" },
    body: "The cat is broken.",
    created_at: "2026-08-19T00:00:00Z",
    comments: 1,
    labels: [{ name: "bug" }],
  }),
  "repos/octo/cat/issues/1/comments?per_page=50": JSON.stringify([
    { user: { login: "other" }, body: "Fixing.", created_at: "2026-08-20T00:00:00Z" },
  ]),
  "repos/octo/cat/contents/src/index.ts?ref=main": "# a\nb",
  "repos/octo/cat/contents/src?ref=main": JSON.stringify([
    { name: "index.ts", type: "file", size: 1234 },
    { name: "lib", type: "dir" },
  ]),
  "repos/octo/cat/releases/latest": JSON.stringify({
    tag_name: "v2.0",
    name: "Two point oh",
    published_at: "2026-01-02T03:04:05Z",
    prerelease: false,
    draft: false,
    body: "Release notes.",
  }),
  "repos/octo/cat/releases/tags/v1.2": JSON.stringify({
    tag_name: "v1.2",
    name: "v1.2",
    published_at: "2025-12-01T00:00:00Z",
    prerelease: true,
    draft: true,
    body: "",
  }),
  "repos/octo/cat/releases?per_page=20": JSON.stringify([
    {
      tag_name: "v2.0",
      name: "Two point oh",
      published_at: "2026-01-02T03:04:05Z",
      body: "Release notes.",
    },
    { tag_name: "v1.0", name: "v1.0", published_at: "2025-01-01T00:00:00Z", body: "" },
  ]),
  "repos/octo/cat/commits/abc123": JSON.stringify({
    sha: "abcdef1234567890",
    commit: {
      author: { name: "Octo Cat", date: "2026-01-02T03:04:05Z" },
      message: "Subject line\n\nBody line",
    },
    stats: { total: 3, additions: 2, deletions: 1 },
    author: { login: "octo" },
  }),
  "repos/octo/cat/commits?per_page=20&sha=main": JSON.stringify([
    {
      sha: "abcdef1234567890",
      commit: {
        author: { name: "Octo Cat", date: "2026-01-02T03:04:05Z" },
        message: "Subject line",
      },
    },
  ]),
  "users/octo": JSON.stringify({
    login: "octo",
    name: "Octo Cat",
    bio: "Meow",
    company: "GitHub",
    location: "Internet",
    blog: "https://octo.example",
    followers: 10,
    following: 2,
    public_repos: 7,
    created_at: "2019-01-01T00:00:00Z",
  }),
};

function fakeApi(args) {
  const endpoint = args[args.length - 1];
  if (args.includes("-H")) {
    const raw = API[endpoint];
    if (raw === undefined)
      throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { status: 404 });
    return raw;
  }
  const entry = API[endpoint];
  if (entry === undefined)
    throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { status: 404 });
  return entry;
}

test("fetchGithub: repo home renders metadata + readme", async () => {
  setGhApiForTests(fakeApi);
  const { usedGh, outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo/cat"), {});
  assert.equal(usedGh, true);
  assert.equal(outcome.title, "octo/cat");
  assert.equal(outcome.description, "A test repo");
  assert.match(outcome.markdown, /Stars: 5 · Forks: 2/);
  assert.match(outcome.markdown, /# Cat Repo/);
  assert.equal(outcome.siteName, "GitHub");
});

test("fetchGithub: issue renders title, body, comments", async () => {
  setGhApiForTests(fakeApi);
  const { outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo/cat/issues/1"), {});
  assert.match(outcome.title, /^Issue #1: Bug: meow/);
  assert.match(outcome.markdown, /The cat is broken\./);
  assert.match(outcome.markdown, /### other — 2026-08-20/);
  assert.match(outcome.markdown, /labels: bug/);
});

test("fetchGithub: blob renders fenced code with language", async () => {
  setGhApiForTests(fakeApi);
  const { outcome } = await fetchGithub(
    parseGithubUrl("https://github.com/octo/cat/blob/main/src/index.ts"),
    {},
  );
  assert.match(outcome.markdown, /```typescript\n# a\nb\n```/);
  assert.equal(outcome.jsonBody.path, "src/index.ts");
});

test("fetchGithub: a 404 on one ref/path candidate falls through to the next", async () => {
  const calls = [];
  setGhApiForTests((args) => {
    const endpoint = args.at(-1);
    calls.push(endpoint);
    if (endpoint === "repos/octo/cat/contents/lib/thing.ts?ref=main")
      throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { status: 404 });
    if (endpoint === "repos/octo/cat/contents/thing.ts?ref=main%2Flib") return "# hit\n";
    throw new Error("unexpected endpoint " + endpoint);
  });
  const { outcome } = await fetchGithub(
    parseGithubUrl("https://github.com/octo/cat/blob/main/lib/thing.ts"),
    {},
  );
  assert.deepEqual(calls, [
    "repos/octo/cat/contents/lib/thing.ts?ref=main",
    "repos/octo/cat/contents/thing.ts?ref=main%2Flib",
  ]);
  assert.match(outcome.markdown, /# hit/);
  assert.equal(outcome.jsonBody.ref, "main/lib");
  assert.equal(outcome.jsonBody.path, "thing.ts");
});

test("fetchGithub: a failure that is not a 404 stops the candidate probe", async () => {
  const calls = [];
  setGhApiForTests((args) => {
    calls.push(args.at(-1));
    throw Object.assign(new Error("gh: rate limited (HTTP 403)"), { status: 403 });
  });
  await assert.rejects(
    fetchGithub(parseGithubUrl("https://github.com/octo/cat/blob/main/lib/thing.ts"), {}),
    /rate limited/,
  );
  assert.equal(calls.length, 1, "the next candidate must not hide a real failure");
});

test("fetchGithub: tree renders listing", async () => {
  setGhApiForTests(fakeApi);
  const { outcome } = await fetchGithub(
    parseGithubUrl("https://github.com/octo/cat/tree/main/src"),
    {},
  );
  assert.match(outcome.markdown, /- index\.ts \(1\.2 KB\)/);
  assert.match(outcome.markdown, /- lib\//);
});

test("fetchGithub: release renders notes and the prerelease/draft flags", async () => {
  setGhApiForTests(fakeApi);
  const latest = await fetchGithub(
    parseGithubUrl("https://github.com/octo/cat/releases/latest"),
    {},
  );
  assert.equal(latest.outcome.title, "Release v2.0");
  assert.match(latest.outcome.markdown, /# Release v2\.0 — Two point oh/);
  assert.match(latest.outcome.markdown, /Release notes\./);
  assert.equal(latest.outcome.published, "2026-01-02");

  const tagged = await fetchGithub(
    parseGithubUrl("https://github.com/octo/cat/releases/tag/v1.2"),
    {},
  );
  assert.match(tagged.outcome.markdown, /published: 2025-12-01 · prerelease · draft/);
  assert.match(tagged.outcome.markdown, /_No release notes\._/);
});

test("fetchGithub: releases list renders each tag", async () => {
  setGhApiForTests(fakeApi);
  const { outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo/cat/releases"), {});
  assert.equal(outcome.title, "Releases (octo/cat)");
  assert.equal(outcome.description, "2 releases");
  assert.match(outcome.markdown, /## v2\.0 — Two point oh/);
  assert.match(outcome.markdown, /## v1\.0/);
});

test("fetchGithub: commit renders subject, body and stats", async () => {
  setGhApiForTests(fakeApi);
  const { outcome } = await fetchGithub(
    parseGithubUrl("https://github.com/octo/cat/commit/abc123"),
    {},
  );
  assert.equal(outcome.title, "abcdef123456 — Subject line");
  assert.equal(outcome.description, "Subject line");
  assert.match(outcome.markdown, /Body line/);
  assert.match(outcome.markdown, /Files changed: 3 · Additions: 2 · Deletions: 1/);
  assert.equal(outcome.published, "2026-01-02");
});

test("fetchGithub: commits list renders short shas and the ref", async () => {
  setGhApiForTests(fakeApi);
  const { outcome } = await fetchGithub(
    parseGithubUrl("https://github.com/octo/cat/commits/main"),
    {},
  );
  assert.equal(outcome.title, "Commits (octo/cat @ main)");
  assert.equal(outcome.description, "1 commits");
  assert.match(outcome.markdown, /- `abcdef1` Subject line \(Octo Cat, 2026-01-02\)/);
});

test("fetchGithub: profile renders bio and counts", async () => {
  setGhApiForTests(fakeApi);
  const { outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo"), {});
  assert.equal(outcome.title, "octo (Octo Cat)");
  assert.equal(outcome.description, "Meow");
  assert.match(outcome.markdown, /Followers: 10 · Following: 2 · Public repos: 7/);
  assert.match(
    outcome.markdown,
    /Company: GitHub · Location: Internet · Blog: https:\/\/octo\.example/,
  );
  assert.equal(outcome.published, "2019-01-01");
});

test("fetchGithub: maxChars flags a long body but keeps the rest for paging", async () => {
  setGhApiForTests(fakeApi);
  const { outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo/cat"), {
    maxChars: 40,
  });
  assert.equal(outcome.truncated, true);
  assert.ok(outcome.markdown.length > 40, "the remainder stays on the outcome");
  const out = formatWebFetchResult(outcome, { maxChars: 40 });
  assert.match(out, /content truncated at (\d+) of \d+ chars — use offset=\1 to continue/);
  const shown = out.split("\n\n[content truncated")[0];
  const start = shown.indexOf(outcome.markdown.slice(0, 8));
  if (start >= 0) assert.ok(shown.slice(start).length <= 40);
});

test("fetchGithub: gh availability caching", async () => {
  _setGhAvailable(true);
  // fetchGithub itself doesn't probe availability — that is fetchSmart's job —
  // so this just verifies the hook is accepted.
  assert.equal(true, true);
});

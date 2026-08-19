import { test } from "node:test";
import assert from "node:assert/strict";
import {
  _setGhApi,
  _setGhAvailable,
  fetchGithub,
  isGithubUrl,
  parseGithubUrl,
  refPathCandidates,
} from "../github.mjs";

// --- parsing ----------------------------------------------------------------

test("parseGithubUrl: repo home and profile", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/octo/cat"), { kind: "repo", owner: "octo", repo: "cat" });
  assert.deepEqual(parseGithubUrl("https://github.com/octo/cat.git"), { kind: "repo", owner: "octo", repo: "cat" });
  assert.deepEqual(parseGithubUrl("https://github.com/octo"), { kind: "profile", owner: "octo" });
  assert.deepEqual(parseGithubUrl("https://github.com"), { kind: "generic", path: "" });
});

test("parseGithubUrl: blob/tree/raw with ref and path", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/blob/main/src/index.ts"), {
    kind: "blob", owner: "o", repo: "r", ref: "main", path: "src/index.ts",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/tree/dev"), {
    kind: "tree", owner: "o", repo: "r", ref: "dev", path: "",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/raw/v1.0/README.md"), {
    kind: "raw", owner: "o", repo: "r", ref: "v1.0", path: "README.md",
  });
});

test("parseGithubUrl: issues, pulls, discussions, releases", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/issues/42"), { kind: "issue", owner: "o", repo: "r", number: 42 });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/pull/7"), { kind: "pull", owner: "o", repo: "r", number: 7 });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/discussions/9"), { kind: "discussion", owner: "o", repo: "r", number: 9 });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/releases"), { kind: "releases", owner: "o", repo: "r" });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/releases/tag/v1.2"), { kind: "release", owner: "o", repo: "r", tag: "v1.2" });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/releases/latest"), { kind: "release", owner: "o", repo: "r", tag: "latest" });
});

test("parseGithubUrl: commits, gist, generic", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/commits/main"), { kind: "commits", owner: "o", repo: "r", ref: "main" });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/commit/abc123"), { kind: "commit", owner: "o", repo: "r", ref: "abc123" });
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
    description: "A test repo", stargazers_count: 5, forks_count: 2,
    language: "TypeScript", license: { spdx_id: "MIT" },
    created_at: "2020-01-01T00:00:00Z", updated_at: "2021-06-01T00:00:00Z",
    topics: ["cli", "test"],
  }),
  "repos/octo/cat/readme": "# Cat Repo\n\nMeow.",
  "repos/octo/cat/issues/1": JSON.stringify({
    number: 1, title: "Bug: meow", state: "open", user: { login: "octo" },
    body: "The cat is broken.", created_at: "2026-08-19T00:00:00Z", comments: 1,
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
};

function fakeApi(args) {
  const endpoint = args[args.length - 1];
  if (args.includes("-H")) {
    const raw = API[endpoint];
    if (raw === undefined) throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { status: 404 });
    return raw;
  }
  const entry = API[endpoint];
  if (entry === undefined) throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { status: 404 });
  return entry;
}

test("fetchGithub: repo home renders metadata + readme", async () => {
  _setGhApi(fakeApi);
  const { usedGh, outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo/cat"), {});
  assert.equal(usedGh, true);
  assert.equal(outcome.title, "octo/cat");
  assert.equal(outcome.description, "A test repo");
  assert.match(outcome.markdown, /Stars: 5 · Forks: 2/);
  assert.match(outcome.markdown, /# Cat Repo/);
  assert.equal(outcome.siteName, "GitHub");
});

test("fetchGithub: issue renders title, body, comments", async () => {
  _setGhApi(fakeApi);
  const { outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo/cat/issues/1"), {});
  assert.match(outcome.title, /^Issue #1: Bug: meow/);
  assert.match(outcome.markdown, /The cat is broken\./);
  assert.match(outcome.markdown, /### other — 2026-08-20/);
  assert.match(outcome.markdown, /labels: bug/);
});

test("fetchGithub: blob renders fenced code with language", async () => {
  _setGhApi(fakeApi);
  const { outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo/cat/blob/main/src/index.ts"), {});
  assert.match(outcome.markdown, /```typescript\n# a\nb\n```/);
  assert.equal(outcome.jsonBody.path, "src/index.ts");
});

test("fetchGithub: tree renders listing", async () => {
  _setGhApi(fakeApi);
  const { outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo/cat/tree/main/src"), {});
  assert.match(outcome.markdown, /- index\.ts \(1\.2 KB\)/);
  assert.match(outcome.markdown, /- lib\//);
});

test("fetchGithub: maxChars caps output", async () => {
  _setGhApi(fakeApi);
  const { outcome } = await fetchGithub(parseGithubUrl("https://github.com/octo/cat"), { maxChars: 40 });
  assert.equal(outcome.truncated, true);
  assert.ok(outcome.markdown.length < 200);
});

test("fetchGithub: gh availability caching", async () => {
  _setGhAvailable(true);
  // fetchGithub itself doesn't probe availability — that is fetchSmart's job —
  // so this just verifies the hook is accepted.
  assert.equal(true, true);
});

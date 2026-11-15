import { test } from "node:test";
import assert from "node:assert/strict";
import { searchRepo } from "../search.mjs";
import { formatSearchHits } from "../format.mjs";

const lines = (n, word = "greet") =>
  Array.from({ length: n }, (_, i) => `line ${i + 1} ${word}();`).join("\n");

function entry(size = 100, mtimeMs = 1, symbols = []) {
  return { size, mtimeMs, lang: "ts", symbols, imports: [], reexports: [] };
}

// Both execution paths over the same in-memory repo, so every paging test
// proves the scan path and the git-grep path agree.
function gitStdout(contents, query = "greet") {
  const out = [];
  for (const [rel, text] of Object.entries(contents)) {
    text.split("\n").forEach((line, i) => {
      const col = line.toLowerCase().indexOf(query);
      if (col >= 0) out.push(`${rel}:${i + 1}:${col + 1}:${line}`);
    });
  }
  return out.join("\n") + "\n";
}

function runners(contents, files, root = "/repo") {
  const scan = (opts = {}) =>
    searchRepo({
      cache: { files },
      query: "greet",
      opts,
      readFile: async (rel) => contents[rel] ?? null,
      root,
    });
  const git = (opts = {}) =>
    searchRepo({
      cache: { files },
      query: "greet",
      opts,
      readFile: async () => {
        throw new Error("git path must not scan");
      },
      exec: async () => ({ code: 0, stdout: gitStdout(contents), stderr: "" }),
      root,
      viaGit: true,
    });
  return { scan, git };
}

async function pageAll(run, opts = {}) {
  const pages = [];
  let cursor;
  do {
    const r = await run({ ...opts, cursor });
    pages.push(r);
    cursor = r.nextCursor;
  } while (cursor && pages.length < 50);
  return pages;
}

const key = (h) => `${h.rel}:${h.lineNo}`;

for (const mode of ["scan", "git"]) {
  test(`${mode}: a 12-match file pages through every match exactly once`, async () => {
    const contents = { "a.ts": lines(12) };
    const run = runners(contents, { "a.ts": entry() })[mode];
    const pages = await pageAll(run, { maxResults: 100 });
    assert.deepEqual(
      pages.map((p) => p.hits.map((h) => h.lineNo)),
      [
        [1, 2, 3, 4, 5],
        [6, 7, 8, 9, 10],
        [11, 12],
      ],
    );
    assert.ok(pages.every((p) => p.total === 12));
    assert.equal(pages[0].truncated, true);
    assert.equal(pages[2].truncated, false);
    assert.equal(pages[2].nextCursor, null);
    assert.deepEqual(
      pages.map((p) => p.start),
      [0, 5, 10],
    );
  });

  test(`${mode}: first page is the same with or without paging support`, async () => {
    const contents = { "a.ts": lines(12), "b.ts": lines(2) };
    const run = runners(contents, { "a.ts": entry(), "b.ts": entry() })[mode];
    const first = await run({ maxResults: 100 });
    assert.equal(first.hits.length, 7); // 5 from a.ts + 2 from b.ts
    assert.equal(first.total, 14);
    assert.equal(first.truncated, true);
    assert.equal(first.start, 0);
  });

  test(`${mode}: multi-file ranking stays stable across pages`, async () => {
    const contents = {
      "a.ts": ["function greet() {}", ...Array.from({ length: 7 }, () => "  greetings();")].join(
        "\n",
      ),
      "b.ts": lines(7),
      "c.ts": "// greet only in a comment",
    };
    const files = {
      "a.ts": entry(100, 1, [
        { name: "greet", kind: "function", startLine: 1, endLine: 8, signature: "" },
      ]),
      "b.ts": entry(),
      "c.ts": entry(),
    };
    const run = runners(contents, files)[mode];
    const pages = await pageAll(run, { maxResults: 3 });
    const all = pages.flatMap((p) => p.hits);
    // 8 + 7 + 1 matches, each exactly once.
    assert.equal(all.length, 16);
    assert.equal(new Set(all.map(key)).size, 16);
    assert.equal(pages[0].total, 16);
    // Page 1 leads with the definition, then ranks by score, file, line.
    assert.equal(all[0].rel, "a.ts");
    assert.equal(all[0].score, 100);
    for (const p of pages) {
      for (let i = 1; i < p.hits.length; i++) {
        const [x, y] = [p.hits[i - 1], p.hits[i]];
        assert.ok(
          x.score > y.score ||
            (x.score === y.score && (x.rel < y.rel || (x.rel === y.rel && x.lineNo < y.lineNo))),
        );
      }
    }
    // Paging twice gives the same sequence.
    const again = await pageAll(run, { maxResults: 3 });
    assert.deepEqual(
      again.flatMap((p) => p.hits.map(key)),
      all.map(key),
    );
  });

  test(`${mode}: a cursor from another search is rejected`, async () => {
    const contents = { "a.ts": lines(12), "b.ts": lines(12) };
    const run = runners(contents, { "a.ts": entry(), "b.ts": entry() })[mode];
    const { nextCursor } = await run({ maxResults: 100 });
    assert.ok(nextCursor);
    await assert.rejects(
      run({ maxResults: 100, cursor: nextCursor, wholeWord: true }),
      /different search/,
    );
    await assert.rejects(
      run({ maxResults: 100, cursor: nextCursor, path: "a.ts" }),
      /different search/,
    );
    await assert.rejects(
      run({ maxResults: 100, cursor: nextCursor, regex: true }),
      /different search/,
    );
  });

  test(`${mode}: a cursor is bound to the query and the workspace`, async () => {
    const contents = { "a.ts": lines(12) };
    const files = { "a.ts": entry() };
    const run = runners(contents, files)[mode];
    const { nextCursor } = await run({});
    const other = runners(contents, files, "/elsewhere")[mode];
    await assert.rejects(other({ cursor: nextCursor }), /different search/);
    await assert.rejects(
      searchRepo({
        cache: { files },
        query: "other",
        opts: { cursor: nextCursor },
        readFile: async () => contents["a.ts"],
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
        root: "/repo",
        viaGit: mode === "git",
      }),
      /different search/,
    );
  });

  test(`${mode}: a cursor goes stale when the matched content changes`, async () => {
    const contents = { "a.ts": lines(12) };
    const run = runners(contents, { "a.ts": entry() })[mode];
    const { nextCursor } = await run({});
    // A match moves: same file size and mtime, different match lines.
    const changed = { "a.ts": lines(12).replace("line 3 greet", "line 3 gre3t") };
    const rerun = runners(changed, { "a.ts": entry() })[mode];
    await assert.rejects(rerun({ cursor: nextCursor }), /stale/);
    // Size or mtime changes also invalidate it.
    const resized = runners(contents, { "a.ts": entry(101) })[mode];
    await assert.rejects(resized({ cursor: nextCursor }), /stale/);
    const touched = runners(contents, { "a.ts": entry(100, 2) })[mode];
    await assert.rejects(touched({ cursor: nextCursor }), /stale/);
    // A new matching file also invalidates it.
    const added = runners({ ...contents, "b.ts": lines(1) }, { "a.ts": entry(), "b.ts": entry() })[
      mode
    ];
    await assert.rejects(added({ cursor: nextCursor }), /stale/);
  });

  test(`${mode}: a cursor that no longer matches anything is stale, not an empty page`, async () => {
    const run = runners({ "a.ts": lines(12) }, { "a.ts": entry() })[mode];
    const { nextCursor } = await run({});
    const gone = runners({ "a.ts": "nothing here" }, { "a.ts": entry() })[mode];
    await assert.rejects(gone({ cursor: nextCursor }), /stale/);
  });
}

test("a cursor issued by the git path continues on the scan path", async () => {
  const contents = { "a.ts": lines(12) };
  const files = { "a.ts": entry() };
  const { scan, git } = runners(contents, files);
  const first = await git({});
  const second = await scan({ cursor: first.nextCursor });
  assert.deepEqual(
    second.hits.map((h) => h.lineNo),
    [6, 7, 8, 9, 10],
  );
});

test("malformed cursors are rejected with a clear error", async () => {
  const { scan } = runners({ "a.ts": lines(12) }, { "a.ts": entry() });
  for (const cursor of ["nope", "e30", Buffer.from('{"v":2}').toString("base64url"), "!!!"]) {
    await assert.rejects(scan({ cursor }), /invalid cursor/);
  }
});

test("paging keeps the scan work bound: one read per matching file per call", async () => {
  const contents = { "a.ts": lines(12), "b.ts": lines(3) };
  let reads = 0;
  const run = (opts) =>
    searchRepo({
      cache: { files: { "a.ts": entry(), "b.ts": entry() } },
      query: "greet",
      opts,
      readFile: async (rel) => {
        reads++;
        return contents[rel];
      },
      root: "/repo",
    });
  const first = await run({});
  assert.ok(first.nextCursor);
  assert.equal(reads, 2);
  await run({ cursor: first.nextCursor });
  assert.equal(reads, 4);
});

test("formatSearchHits offers the cursor and counts what is left", () => {
  const hit = (lineNo) => ({ rel: "a.ts", lineNo, col: 1, text: "greet", entry: { symbols: [] } });
  const first = formatSearchHits({
    query: "greet",
    hits: [hit(1), hit(2)],
    total: 12,
    truncated: true,
    remaining: 10,
    nextCursor: "abc",
    suggestion: [],
  });
  assert.match(first, /# code_search "greet" — 12 matches\n/);
  assert.match(first, /and 10 more matches/);
  assert.match(first, /cursor="abc"/);
  const later = formatSearchHits({
    query: "greet",
    hits: [hit(6), hit(7)],
    total: 12,
    start: 5,
    truncated: true,
    remaining: 5,
    nextCursor: "def",
    suggestion: [],
  });
  assert.match(later, /showing 6–7/);
  assert.match(later, /and 5 more matches/);
  const last = formatSearchHits({
    query: "greet",
    hits: [hit(11), hit(12)],
    total: 12,
    start: 10,
    truncated: false,
    remaining: 0,
    nextCursor: null,
    suggestion: [],
  });
  assert.match(last, /showing 11–12/);
  assert.doesNotMatch(last, /more matches|cursor/);
});

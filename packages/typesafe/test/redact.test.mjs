import { test } from "node:test";
import assert from "node:assert/strict";

import { redactSecrets } from "../../../shared/redact.mjs";

// One example per pattern, each long enough to be a real credential and each
// matched by exactly one rule, so a count of one means the rule that fired.
//
// Assembled from pieces rather than written out: a file holding a
// credential-shaped literal trips GitHub's push protection, and a false alarm
// on every future push is worse than an odd-looking table. None of these is a
// working credential — they are published dummies and obvious repeats.
const pieces = (...parts) => parts.join("");
const AWS_LIKE = pieces("AKIA", "IOSFODNN7EXAMPLE");
const SAMPLES = [
  [
    "pem",
    pieces(
      "-----BEGIN RSA PRIVATE ",
      "KEY-----\nMIIEowIBAAKCAQEAx7Vn\n-----END RSA ",
      "PRIVATE KEY-----",
    ),
  ],
  [
    "jwt",
    pieces(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      ".eyJzdWIiOiIxMjM0NTY3OD",
      "kwIn0.SflKxwRJSMeKKF2QT4fwpMeJf",
    ),
  ],
  ["aws", AWS_LIKE],
  ["github", pieces("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789")],
  ["openai", pieces("sk-proj-", "abcdefghijklmnopqrstuvwxyz0123")],
  ["slack", pieces("xoxb-", "123456789012-abcdefghijklmnop")],
  ["bearer", pieces("Bearer ", "abcdefghijklmnopqrstuvwxyz123456")],
];

test("every credential shape is replaced and counted once", () => {
  let checked = 0;
  for (const [kind, secret] of SAMPLES) {
    const { value, count } = redactSecrets(`prefix ${secret} suffix`);
    assert.equal(count, 1, `${kind} counted`);
    assert.ok(!value.includes(secret), `${kind} gone`);
    assert.match(value, /<REDACTED:[a-z]+>/);
    assert.ok(
      value.startsWith("prefix ") && value.endsWith(" suffix"),
      `${kind} keeps surroundings`,
    );
    checked += 1;
  }
  assert.equal(checked, SAMPLES.length, "every sample was scored");
});

test("URL userinfo is masked across schemes without losing the endpoint", () => {
  for (const input of [
    "https://alice:short@example.invalid/api",
    "postgresql://alice:p%40ss@example.invalid:5432/db",
    "redis://:short@example.invalid/0",
    "https://alice@example.invalid/api",
    "https://alice:p@ss@example.invalid/api",
  ]) {
    const { value, count } = redactSecrets(input);
    assert.equal(count, 1, input);
    assert.equal(value, input.replace(/\/\/.*@/, "//<REDACTED:url>@"));
    assert.equal(redactSecrets(value).count, 0, "masking is idempotent");
  }
  const clean = "https://example.invalid/api?contact=alice@example.invalid";
  assert.deepEqual(redactSecrets(clean), { value: clean, count: 0 });
});

test("home paths are masked without losing suffixes or changing neighbouring usernames", () => {
  const windowsHome = ["C:", "Users", "Alice"].join(String.fromCharCode(92));
  for (const homeDir of ["/Users/alice", "/home/a.b[work]", windowsHome]) {
    const input = {
      path: homeDir + "/project/app.ts",
      note: 'home="' + homeDir + '"; cwd=' + homeDir,
      prose: "The home is " + homeDir + ". Next sentence.",
      neighbours: [homeDir + "-other/file", homeDir + ".backup/file", homeDir + "é/file"],
    };
    const { value, count, privacyCount } = redactSecrets(input, { homeDir });
    assert.equal(count, 0);
    assert.equal(privacyCount, 4);
    assert.equal(value.path, "<REDACTED:home>/project/app.ts");
    assert.equal(value.note, 'home="<REDACTED:home>"; cwd=<REDACTED:home>');
    assert.equal(value.prose, "The home is <REDACTED:home>. Next sentence.");
    assert.deepEqual(value.neighbours, input.neighbours);
    assert.equal(input.path, homeDir + "/project/app.ts", "input is untouched");
    assert.deepEqual(redactSecrets(value, { homeDir }), { value, count: 0 });
  }
  for (const homeDir of ["", "/"]) {
    assert.deepEqual(redactSecrets("/project/app.ts", { homeDir }), {
      value: "/project/app.ts",
      count: 0,
    });
  }
});

test("email masking is opt-in and leaves URL credential masking and package names intact", () => {
  const input = {
    authors: ["alice+work@example.invalid", "Bob@Example.INVALID"],
    endpoint: "https://alice:short@example.invalid/api",
    package: "@scope/package",
  };
  assert.deepEqual(redactSecrets(input).value.authors, input.authors);
  const { value, count, privacyCount } = redactSecrets(input, { maskEmails: true });
  assert.equal(count, 1, "only URL credentials count as a secret");
  assert.equal(privacyCount, 2);
  assert.deepEqual(value.authors, ["<REDACTED:email>", "<REDACTED:email>"]);
  assert.equal(value.endpoint, "https://<REDACTED:url>@example.invalid/api");
  assert.equal(value.package, input.package);
  assert.deepEqual(redactSecrets(value, { maskEmails: true }), { value, count: 0 });
  assert.equal(input.authors[0], "alice+work@example.invalid");
});

test("assignment forms are redacted, short and named values are not", () => {
  const { value, count } = redactSecrets(
    [
      pieces("GITHUB_TOKEN=ghp-", "shortestcase0123456789"),
      "api_key = 'ZZZZZZZZZZZZZZZZZZZZ'",
      "password: hunter2",
      "token=abc",
      "timeoutSeconds=300",
    ].join("\n"),
  );
  assert.equal(count, 2, "the 16+ character assignments and nothing else");
  assert.ok(!value.includes(pieces("ghp-", "shortestcase0123456789")));
  assert.ok(!value.includes("ZZZZZZZZZZZZZZZZZZZZ"));
  assert.match(value, /password: hunter2/, "a short password is left alone");
  assert.match(value, /timeoutSeconds=300/, "a number is not a secret");
});

test("the caller's own API key is redacted wherever it appears", () => {
  const { value, count } = redactSecrets(
    { note: "key is ts-secret-key here", other: "ts-secret-key" },
    { literals: ["ts-secret-key"] },
  );
  assert.equal(count, 2);
  assert.equal(value.note, "key is <REDACTED:key> here");
  assert.equal(value.other, "<REDACTED:key>");
});

test("state is walked, structure is kept, and nothing else is touched", () => {
  const input = {
    action: "cat .env",
    nested: { list: [AWS_LIKE, 42, null, true] },
    count: 7,
    missing: undefined,
    when: new Date(0),
  };
  const { value, count } = redactSecrets(input);
  assert.equal(count, 1);
  assert.equal(value.action, "cat .env", "ordinary text survives");
  assert.equal(value.nested.list[0], "<REDACTED:aws>");
  assert.equal(value.nested.list[1], 42);
  assert.equal(value.nested.list[2], null);
  assert.equal(value.nested.list[3], true);
  assert.equal(value.count, 7);
  assert.equal(value.missing, undefined);
  assert.equal(value.when, input.when, "a non-plain value is passed through");
  assert.equal(input.nested.list[0], AWS_LIKE, "the caller's object is not mutated");
});

test("a clean state reports zero, and a second pass adds nothing", () => {
  const clean = { task: "add the loader", flags: ["--dry-run"] };
  assert.equal(redactSecrets(clean).count, 0);
  assert.deepEqual(redactSecrets(clean).value, clean);

  const once = redactSecrets({
    key: pieces("GITHUB_TOKEN=ghp-", "abcdefghijklmnopqrstuvwxyz012345"),
  });
  const twice = redactSecrets(once.value);
  assert.equal(once.count, 1);
  assert.equal(twice.count, 0, "a redacted marker is not a secret");
  assert.equal(twice.value.key, once.value.key);
});

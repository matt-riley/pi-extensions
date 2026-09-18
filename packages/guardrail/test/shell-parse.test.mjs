import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectSubstitutions,
  findHead,
  redirectTargets,
  splitSegments,
  stripHeredocs,
  tokenize,
} from "../../../shared/shell-parse.mjs";

// ---------------------------------------------------------------------------
// Heredocs: bodies are data, not shell

test("stripHeredocs: keeps command lines, returns bodies", () => {
  const script = [
    "cat > /tmp/app.mjs <<'EOF'",
    "const bigger = a > b;",
    "const x = document.width > 0 ? 1 : 2;",
    "EOF",
    "node /tmp/app.mjs",
  ].join("\n");
  const { text, bodies } = stripHeredocs(script);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].quoted, true);
  assert.match(text, /cat > \/tmp\/app\.mjs/);
  assert.match(text, /node \/tmp\/app\.mjs/);
  assert.doesNotMatch(text, /bigger/);
  assert.match(bodies[0].body, /bigger/);
});

test("stripHeredocs: unquoted bodies are reported as unquoted, tabs allowed", () => {
  const script = ["cat <<-END > /tmp/x", "\tvalue $(date)", "\tEND", "echo done"].join("\n");
  const { text, bodies } = stripHeredocs(script);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].quoted, false);
  assert.doesNotMatch(text, /date/);
  assert.match(text, /echo done/);
});

test("stripHeredocs: nothing to strip leaves the text alone", () => {
  const { text, bodies } = stripHeredocs("git status && ls");
  assert.equal(text, "git status && ls");
  assert.deepEqual(bodies, []);
});

// ---------------------------------------------------------------------------
// Command substitution

test("collectSubstitutions: $() and backticks, including inside double quotes", () => {
  assert.deepEqual(collectSubstitutions("echo $(date)"), ["date"]);
  assert.deepEqual(collectSubstitutions("echo `date`"), ["date"]);
  assert.deepEqual(collectSubstitutions('echo "$(git rev-parse --short HEAD)"'), [
    "git rev-parse --short HEAD",
  ]);
  assert.deepEqual(collectSubstitutions("echo $(a $(b))"), ["a $(b)"]);
  assert.deepEqual(collectSubstitutions('echo "literal $(not this)"'), ["not this"]);
});

test("collectSubstitutions: single quotes suppress both forms", () => {
  assert.deepEqual(collectSubstitutions("echo '$(date)'"), []);
  assert.deepEqual(collectSubstitutions("echo '`date`'"), []);
});

test("collectSubstitutions: an apostrophe inside double quotes does not open a string", () => {
  // Regression: the scanner used to fall through without entering quote mode
  // on ", so \"don't\" left it believing a single-quoted string had started —
  // and every substitution after the apostrophe went unseen.
  assert.deepEqual(collectSubstitutions('echo "don\'t $(date)"'), ["date"]);
  assert.deepEqual(collectSubstitutions('git commit -m "doesn\'t matter" && echo $(whoami)'), [
    "whoami",
  ]);
  assert.deepEqual(collectSubstitutions("echo \"it's\" '$(not this)'"), []);
});

// ---------------------------------------------------------------------------
// Redirects: the false positives that matter

test("redirectTargets: quotes are literal, fd duplication has no path", () => {
  assert.deepEqual(redirectTargets("npm test > /tmp/out.txt"), [
    { op: ">", target: "/tmp/out.txt" },
  ]);
  assert.deepEqual(redirectTargets("npm test >> /tmp/out.txt"), [
    { op: ">>", target: "/tmp/out.txt" },
  ]);
  assert.deepEqual(redirectTargets('grep "<div" index.html'), []);
  assert.deepEqual(redirectTargets("node -e 'a -> b'"), []);
  assert.deepEqual(redirectTargets("cmd 2>&1"), [{ op: ">", target: null }]);
  assert.deepEqual(redirectTargets("cmd >&2"), [{ op: ">", target: null }]);
});

test("redirectTargets: a redirect inside a substitution belongs to the substitution", () => {
  // The real-world shape: a redirect inside $() inside quotes used to leak a
  // blob of text as the \"target\" and classify the whole command as a write
  // into a system path.
  const segment =
    'echo "$b: tip=$(git rev-parse --short $b) contains=$([ "$(git merge-base origin/main $b 2>/dev/null)" = "" ] && echo yes)"';
  assert.deepEqual(redirectTargets(segment), []);
});

test("redirectTargets: trailing shell punctuation is not part of the path", () => {
  assert.deepEqual(redirectTargets('curl -s -o /tmp/x -w "%{http_code}" url 2>/dev/null)'), [
    { op: ">", target: "/dev/null" },
  ]);
  assert.deepEqual(redirectTargets("time (node x.mjs > /dev/null)"), [
    { op: ">", target: "/dev/null" },
  ]);
});

// ---------------------------------------------------------------------------
// Still-working basics (bash-policy depends on these)

test("splitSegments and tokenize stay quote-aware", () => {
  assert.deepEqual(splitSegments("git status && rm -rf ~"), ["git status ", " rm -rf ~"]);
  assert.deepEqual(splitSegments('grep -E "a|b" file'), ['grep -E "a|b" file']);
  assert.deepEqual(tokenize(`sed -i '' 's|a|b|' file.txt`), [
    "sed",
    "-i",
    "",
    "s|a|b|",
    "file.txt",
  ]);
});

test("findHead skips env assignments and leading flags", () => {
  assert.deepEqual(findHead(tokenize("FOO=1 ls -la")), { head: "ls", args: ["-la"] });
  assert.deepEqual(findHead(tokenize("rm -rf x")), { head: "rm", args: ["-rf", "x"] });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, formatAggregate } from "../aggregate.mjs";

const done = (slice, text, extra = {}) => ({ slice, status: "completed", text, ...extra });

test("zero results is not a pass", () => {
  const result = aggregate([]);
  assert.equal(result.overall, "INCOMPLETE");
  assert.match(formatAggregate(result), /an empty swarm is not a pass/);
});

test("one gap among passes is INCOMPLETE, and names why", () => {
  const result = aggregate([
    done("api", "PASS\nall green"),
    done("cli", "Looks fine to me."),
    done("docs", "PASS"),
  ]);
  assert.equal(result.overall, "INCOMPLETE");
  assert.deepEqual(
    result.gaps.map((r) => [r.slice, r.why]),
    [["cli", "does not open with PASS, ISSUES or BLOCKED"]],
  );
});

test("a child that did not finish is a gap whatever its text says", () => {
  const result = aggregate([
    done("api", "PASS"),
    { slice: "cli", status: "timed out", text: "PASS" },
  ]);
  assert.equal(result.overall, "INCOMPLETE");
  assert.equal(result.rows[1].why, "child timed out");
});

test("only the opening line counts: PASS later in the text is not a verdict", () => {
  const result = aggregate([done("api", "Summary first.\nPASS")]);
  assert.equal(result.rows[0].verdict, "GAP");
  assert.equal(aggregate([done("api", "**ISSUES**: two failures")]).rows[0].verdict, "ISSUES");
});

test("every required slice passing is PASS; issues or blocked without gaps is ISSUES", () => {
  assert.equal(aggregate([done("a", "PASS"), done("b", "PASS")]).overall, "PASS");
  assert.equal(aggregate([done("a", "PASS"), done("b", "ISSUES: x")]).overall, "ISSUES");
  assert.equal(aggregate([done("a", "BLOCKED: no db")]).overall, "ISSUES");
});

test("an optional slice cannot fail the swarm, but marking none required requires all", () => {
  const mixed = aggregate([
    done("core", "PASS", { required: true }),
    done("extra", "nothing", { required: false }),
  ]);
  assert.equal(mixed.overall, "PASS");
  assert.equal(mixed.gaps.length, 1, "the optional gap is still reported");
  assert.match(formatAggregate(mixed), /- extra: GAP \(optional\): does not open/);
  assert.equal(aggregate([done("a", "PASS"), done("b", "ISSUES")]).rows[1].required, true);
});

test("with expectSha a slice that did not record the checked commit is a gap", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const result = aggregate(
    [done("a", "PASS at 0123456789ab"), done("b", "PASS at 0123456"), done("c", "PASS")],
    { expectSha: sha },
  );
  assert.deepEqual(
    result.rows.map((r) => r.verdict),
    ["PASS", "PASS", "GAP"],
  );
  assert.equal(result.rows[2].why, "did not record 0123456789ab");
  assert.equal(aggregate([done("a", "PASS at 0123457")], { expectSha: sha }).overall, "INCOMPLETE");
});

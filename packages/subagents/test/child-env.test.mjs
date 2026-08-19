import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_ENV,
  acquireChildEnv,
  releaseChildEnv,
  childEnvDepthForTest,
} from "../child-env.mjs";

function withSavedEnv(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, CHILD_ENV);
  const prev = process.env[CHILD_ENV];
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (had) process.env[CHILD_ENV] = prev;
      else delete process.env[CHILD_ENV];
    });
}

test("overlapping async entries: first exit leaves env var set while second is active", () =>
  withSavedEnv(async () => {
    delete process.env[CHILD_ENV];
    assert.equal(childEnvDepthForTest(), 0);

    acquireChildEnv(); // spawn A enters
    assert.equal(process.env[CHILD_ENV], "1");
    acquireChildEnv(); // spawn B enters while A is still active
    assert.equal(process.env[CHILD_ENV], "1");
    assert.equal(childEnvDepthForTest(), 2);

    releaseChildEnv(); // spawn A exits first
    assert.equal(process.env[CHILD_ENV], "1", "env var must survive while B is still active");
    assert.equal(childEnvDepthForTest(), 1);

    releaseChildEnv(); // spawn B exits last
    assert.equal(process.env[CHILD_ENV], undefined);
    assert.equal(childEnvDepthForTest(), 0);
  }));

test("env var clears only after the last of several overlapping entries exits", () =>
  withSavedEnv(async () => {
    delete process.env[CHILD_ENV];
    acquireChildEnv();
    acquireChildEnv();
    acquireChildEnv();
    assert.equal(childEnvDepthForTest(), 3);
    assert.equal(process.env[CHILD_ENV], "1");

    releaseChildEnv();
    assert.equal(process.env[CHILD_ENV], "1");
    releaseChildEnv();
    assert.equal(process.env[CHILD_ENV], "1");
    releaseChildEnv();
    assert.equal(process.env[CHILD_ENV], undefined);
    assert.equal(childEnvDepthForTest(), 0);
  }));

test("restores a pre-existing value once the outermost entry exits", () =>
  withSavedEnv(async () => {
    process.env[CHILD_ENV] = "preexisting";
    acquireChildEnv();
    assert.equal(process.env[CHILD_ENV], "1");
    acquireChildEnv();
    releaseChildEnv();
    assert.equal(process.env[CHILD_ENV], "1", "still nested, must not restore yet");
    releaseChildEnv();
    assert.equal(process.env[CHILD_ENV], "preexisting");
  }));

test("extra release beyond depth 0 is a no-op", () =>
  withSavedEnv(async () => {
    delete process.env[CHILD_ENV];
    assert.equal(childEnvDepthForTest(), 0);
    releaseChildEnv();
    assert.equal(childEnvDepthForTest(), 0);
    assert.equal(process.env[CHILD_ENV], undefined);
  }));

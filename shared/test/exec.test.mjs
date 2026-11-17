import assert from "node:assert/strict";
import test from "node:test";

import { piExec } from "../exec.mjs";

test("the adapter defaults the timeout and passes an explicit one through", async () => {
  const calls = [];
  const exec = piExec({
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { code: 0, stdout: "out", stderr: "err" };
    },
  });
  assert.deepEqual(await exec("git", ["status"]), { code: 0, stdout: "out", stderr: "err" });
  await exec("git", ["log"], { timeout: 250 });
  assert.deepEqual(
    calls.map((call) => call.opts),
    [{ timeout: 10_000 }, { timeout: 250 }],
  );
  assert.equal(calls[0].cmd, "git");
  assert.deepEqual(calls[0].args, ["status"]);
});

test("a stream the host left undefined reads as empty, not 'undefined'", async () => {
  const exec = piExec({ exec: async () => ({ code: 1 }) });
  assert.deepEqual(await exec("git", ["diff"]), { code: 1, stdout: "", stderr: "" });
});

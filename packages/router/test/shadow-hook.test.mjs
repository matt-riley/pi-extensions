import { test } from "node:test";
import assert from "node:assert/strict";

import { shadowSessionKey } from "../shadow-hook.mjs";

test("shadowSessionKey uses sessionManager.getSessionId when present", () => {
  assert.equal(
    shadowSessionKey({
      sessionManager: { getSessionId: () => "  pi-session-42  " },
    }),
    "pi-session-42",
  );
});

test("shadowSessionKey falls back to legacy ctx session fields", () => {
  assert.equal(shadowSessionKey({ sessionId: "legacy-id" }), "legacy-id");
  assert.equal(shadowSessionKey({ session: { id: "nested-id" } }), "nested-id");
});

test("shadowSessionKey defaults to local when no id is available", () => {
  assert.equal(shadowSessionKey({}), "local");
  assert.equal(shadowSessionKey({ sessionManager: {} }), "local");
});

test("shadowSessionKey keeps legacy fields when getSessionId throws", () => {
  assert.equal(
    shadowSessionKey({
      sessionId: "fallback",
      sessionManager: {
        getSessionId: () => {
          throw new Error("unavailable");
        },
      },
    }),
    "fallback",
  );
});

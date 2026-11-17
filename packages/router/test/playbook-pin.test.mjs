// `/playbook` argument parsing and pin state, without the extension around it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlaybookPin, parsePlaybookArgs } from "../playbook-pin.mjs";
import { NO_PLAYBOOK, PLAYBOOK_TYPES } from "../playbook.mjs";

test("arguments parse to status, auto, off, a pin, or an unknown type", () => {
  assert.deepEqual(parsePlaybookArgs(""), { action: "status" });
  assert.deepEqual(parsePlaybookArgs(undefined), { action: "status" });
  assert.deepEqual(parsePlaybookArgs(" Status "), { action: "status" });
  assert.deepEqual(parsePlaybookArgs("auto"), { action: "auto" });
  assert.deepEqual(parsePlaybookArgs("OFF"), { action: "off" });
  assert.deepEqual(parsePlaybookArgs("bug"), { action: "pin", type: "bug" });
  assert.deepEqual(parsePlaybookArgs("perf pin"), { action: "pin", type: "perf" });
  assert.deepEqual(parsePlaybookArgs("pin  babysit"), { action: "pin", type: "babysit" });
  assert.deepEqual(parsePlaybookArgs("deploy"), { action: "unknown", type: "deploy" });
  assert.deepEqual(parsePlaybookArgs("none"), { action: "unknown", type: "none" });
  assert.deepEqual(parsePlaybookArgs("bug feature"), { action: "unknown", type: "bug feature" });
});

test("every playbook type can be pinned", () => {
  for (const type of PLAYBOOK_TYPES)
    assert.deepEqual(parsePlaybookArgs(type), { action: "pin", type });
});

test("pin, off and auto change the state; status and unknown types do not", () => {
  const pin = createPlaybookPin();
  assert.equal(pin.pinned, undefined);

  let reply = pin.command("", { type: "bug" });
  assert.equal(reply.changed, false);
  assert.match(reply.message, /^playbook: bug \(judged\)/);
  assert.match(pin.command("", undefined).message, /^playbook: not judged yet \(auto\)/);

  reply = pin.command("perf");
  assert.deepEqual([reply.changed, pin.pinned], [true, "perf"]);
  assert.match(reply.message, /^playbook: perf \(pinned\)/);

  reply = pin.command("nonsense");
  assert.deepEqual([reply.changed, reply.level, pin.pinned], [false, "warning", "perf"]);
  assert.match(reply.message, /Known: bug, feature/);

  reply = pin.command("off");
  assert.deepEqual([reply.changed, pin.pinned], [true, NO_PLAYBOOK]);
  assert.match(reply.message, /^playbook: off \(no playbook, no judgment\)/);

  reply = pin.command("auto");
  assert.deepEqual([reply.changed, pin.pinned], [true, undefined]);
  assert.equal(reply.message, "playbook: auto · the next prompt is judged");

  pin.command("design");
  pin.reset();
  assert.equal(pin.pinned, undefined);
});

test("each instance holds its own pin", () => {
  const parent = createPlaybookPin();
  parent.command("bug");
  assert.equal(createPlaybookPin().pinned, undefined);
});

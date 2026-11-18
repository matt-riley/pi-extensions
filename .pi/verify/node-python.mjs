// Node consumes a Python CLI's JSON record. Both versions satisfy the ASCII
// example; a multibyte payload distinguishes byte length from character count.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const python = spawnSync("python3", ["--version"], { timeout: 5000 });
if (python.error?.code === "ENOENT") {
  console.error("GAP: python3 unavailable; neither fixture was verified");
  process.exit(77);
}
assert.ifError(python.error);
assert.equal(python.status, 0, "python3 must start");

const dir = mkdtempSync(join(tmpdir(), "pi-node-python-"));
const cli = join(dir, "size.py");
function consume(value) {
  const r = spawnSync("python3", [cli], {
    input: JSON.stringify(value), encoding: "utf8", timeout: 5000
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(r.stdout);
  if (record.bytes !== Buffer.byteLength(value, "utf8")) {
    throw new Error("byte count mismatch: received "+record.bytes);
  }
}

try {
  for (const [version, expr] of [["good", 'len(text.encode("utf-8"))'], ["defective", "len(text)"]]) {
    writeFileSync(cli, 'import json, sys\ntext = json.load(sys.stdin)\nprint(json.dumps({"bytes": '+expr+'}))\n');
    consume("abc");
    if (version === "good") {
      consume("é");
      console.log("good: ASCII passed; Node accepted the UTF-8 byte count");
    } else {
      assert.throws(() => consume("é"), { message: "byte count mismatch: received 1" });
      console.log("defective: ASCII passed; Node rejected 1 byte for the 2-byte payload");
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

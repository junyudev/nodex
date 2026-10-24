// Safe, offline probes. Passing these is regression evidence, not proof that every CVE is fixed.
// Run this file with each executable being assessed, including Electron's RunAsNode mode.
import assert from "node:assert/strict";
import { Resolver } from "node:dns";
import { checkServerIdentity } from "node:tls";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

const checks = [];
function check(name, run) {
  try {
    run();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, error: String(error) });
  }
}

check("Brotli round trip", () => {
  const bytes = Buffer.from("Nodex runtime security smoke test");
  assert.deepEqual(brotliDecompressSync(brotliCompressSync(bytes)), bytes);
});
check("Brotli block-switch fix API marker", () => {
  assert.equal(typeof constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH, "number");
});

for (const method of ["resolve", "resolve4", "resolve6", "reverse"]) {
  check(`DNS ${method} rejects NUL before resolution`, () => {
    const resolver = new Resolver();
    // No DNS traffic even on a vulnerable runtime; all pending work is cancelled below.
    resolver.setServers([]);
    try {
      assert.throws(() => resolver[method]("127.0.0.1\0.example.invalid", () => {}));
    } finally {
      resolver.cancel();
    }
  });
}

for (const hostname of [
  "１２７.0.0.1",
  "0127.0.0.1",
  "0177.0.0.1",
  "0x7f.0.0.1",
  "2130706433",
  "127.1",
]) {
  check(`TLS rejects numeric DNS SAN for ${hostname}`, () => {
    assert.ok(
      checkServerIdentity(hostname, {
        subject: { CN: "127.0.0.1" },
        subjectaltname: "DNS:127.0.0.1, DNS:87.0.0.1",
      }),
    );
  });
}
check("TLS rejects ambiguous leading-zero IP even with a matching normalized IP SAN", () => {
  assert.ok(checkServerIdentity("0127.0.0.1", { subjectaltname: "IP Address:87.0.0.1" }));
});
check("TLS accepts canonical IP with matching IP SAN", () => {
  assert.equal(
    checkServerIdentity("127.0.0.1", { subjectaltname: "IP Address:127.0.0.1" }),
    undefined,
  );
});

console.log(
  JSON.stringify({ executable: process.execPath, versions: process.versions, checks }, null, 2),
);
if (checks.some((result) => !result.passed)) process.exitCode = 1;

import { generateKeyPairSync, sign as signPayload, createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  deriveChromeExtensionId,
  resolveChromeControlDisposableE2EGate,
  verifyCrx3,
} from "./run-chrome-control-disposable-e2e.mts";

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining === 0 ? byte : byte | 0x80);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function bytesField(fieldNumber: number, bytes: Uint8Array): Buffer {
  return Buffer.concat([varint(fieldNumber * 8 + 2), varint(bytes.byteLength), bytes]);
}

function makeSignedCrx3(): { readonly bytes: Buffer; readonly extensionId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const publicKeyBytes = publicKey.export({ format: "der", type: "spki" });
  const extensionId = deriveChromeExtensionId(publicKeyBytes);
  const signedCrxId = createHash("sha256").update(publicKeyBytes).digest().subarray(0, 16);
  const signedHeader = bytesField(1, signedCrxId);
  const zipBytes = Buffer.from("PK\u0003\u0004disposable-extension-fixture", "binary");
  const signedHeaderLength = Buffer.alloc(4);
  signedHeaderLength.writeUInt32LE(signedHeader.length);
  const signedBytes = Buffer.concat([
    Buffer.from("CRX3 SignedData\0", "binary"),
    signedHeaderLength,
    signedHeader,
    zipBytes,
  ]);
  const signature = signPayload("sha256", signedBytes, privateKey);
  const proof = Buffer.concat([bytesField(1, publicKeyBytes), bytesField(2, signature)]);
  const header = Buffer.concat([bytesField(2, proof), bytesField(10_000, signedHeader)]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return { bytes: Buffer.concat([prefix, header, zipBytes]), extensionId };
}

describe("disposable Chrome control evidence gate", () => {
  test("skips without opt-in and fails closed once opted in", () => {
    expect(resolveChromeControlDisposableE2EGate({})).toEqual({
      reason: "explicit-opt-in-required",
      status: "skipped",
    });
    expect(() =>
      resolveChromeControlDisposableE2EGate({ NODEX_CHROME_CONTROL_E2E: "true" }),
    ).toThrow("must be exactly 1");
    expect(() => resolveChromeControlDisposableE2EGate({ NODEX_CHROME_CONTROL_E2E: "1" })).toThrow(
      "is required for the opt-in gate",
    );

    expect(
      resolveChromeControlDisposableE2EGate({
        NODEX_CHROME_CONTROL_E2E: "1",
        NODEX_CHROME_CONTROL_E2E_BROWSER_EXECUTABLE: "/fixtures/cft",
        NODEX_CHROME_CONTROL_E2E_EVIDENCE_PATH: "runs.local/chrome-evidence.json",
        NODEX_CHROME_CONTROL_E2E_EXTENSION_CRX: "/fixtures/extension.crx",
        NODEX_CHROME_CONTROL_E2E_RUNTIME_ROOT: "/fixtures/runtime",
      }),
    ).toEqual({
      config: {
        browserExecutable: "/fixtures/cft",
        evidencePath: path.resolve("runs.local/chrome-evidence.json"),
        extensionCrx: "/fixtures/extension.crx",
        runtimeRoot: "/fixtures/runtime",
      },
      status: "ready",
    });
  });

  test("cryptographically binds CRX3 content to an attested extension ID", () => {
    const fixture = makeSignedCrx3();
    const verified = verifyCrx3(fixture.bytes, [fixture.extensionId]);

    expect(verified.extensionId).toBe(fixture.extensionId);
    expect(deriveChromeExtensionId(verified.publicKey)).toBe(fixture.extensionId);
    expect(verified.zipBytes.subarray(0, 2).toString("ascii")).toBe("PK");

    const tampered = Buffer.from(fixture.bytes);
    tampered[tampered.length - 1] ^= 1;
    expect(() => verifyCrx3(tampered, [fixture.extensionId])).toThrow(
      "signature verification failed",
    );
    expect(() => verifyCrx3(fixture.bytes, ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])).toThrow(
      "no valid proof",
    );
  });
});

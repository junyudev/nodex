import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { signFile, verifyFileSignature } from "./signing";
import { notarize, type NotaryClient, type NotaryResult } from "./notarization";

test.skipIf(process.platform === "win32")(
  "detached appcast signing preserves the final XML despite Sparkle's XML mutation behavior",
  () => {
    const root = mkdtempSync(join(tmpdir(), "nodex-sparkle-detached-"));
    try {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const seed = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
      const pinned = publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64");
      const tool = join(root, "sign_update");
      writeFileSync(
        tool,
        `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const file = process.argv.at(-1);
if (file.endsWith(".xml")) { fs.appendFileSync(file, "<!--embedded-signature-->"); process.exit(0); }
const key = crypto.createPrivateKey({ key: Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64"), format: "der", type: "pkcs8" });
process.stdout.write(crypto.sign(null, fs.readFileSync(file), key).toString("base64"));
`,
        { mode: 0o755 },
      );
      const xml = join(root, "appcast.xml");
      const bytes = '<?xml version="1.0"?><rss><!--already sealed--></rss>\n';
      writeFileSync(xml, bytes);
      const signature = signFile(tool, xml, seed);
      expect(readFileSync(xml, "utf8")).toBe(bytes);
      expect(() => verifyFileSignature(xml, signature, pinned)).not.toThrow();
      writeFileSync(xml, `${bytes}\n`);
      expect(() => verifyFileSignature(xml, signature, pinned)).toThrow(
        "Invalid Ed25519 signature",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

describe("notarization", () => {
  const ok = (value: Record<string, unknown>): NotaryResult => ({ ok: true, value });
  const failed = (detail: string): NotaryResult => ({ ok: false, detail });

  function client(script: {
    submit?: NotaryResult[];
    wait?: NotaryResult[];
    info?: NotaryResult[];
    log?: NotaryResult;
  }) {
    const calls: string[] = [];
    const next = (name: string, queue: NotaryResult[] | undefined) => {
      calls.push(name);
      const result = queue?.shift();
      if (!result) throw new Error(`Unexpected ${name} call`);
      return result;
    };
    const notary: NotaryClient = {
      submit: () => next("submit", script.submit),
      wait: (id) => next(`wait ${id}`, script.wait),
      info: (id) => next(`info ${id}`, script.info),
      log: (id) => next(`log ${id}`, script.log ? [script.log] : undefined),
    };
    return { notary, calls };
  }

  const quiet = { report: () => {} };

  test("submits again only when an upload never produced a submission", () => {
    const { notary, calls } = client({
      submit: [failed("exited with 1"), ok({ id: "second" })],
      wait: [ok({ status: "Accepted" })],
      info: [ok({ status: "Accepted" })],
    });
    expect(notarize(notary, "Nodex.dmg", quiet)).toBe("second");
    expect(calls).toEqual(["submit", "submit", "wait second", "info second"]);
  });

  test("keeps following the same submission when waiting drops", () => {
    const { notary, calls } = client({
      submit: [ok({ id: "one" })],
      wait: [failed("stopped by SIGPIPE"), ok({ status: "Accepted" })],
      info: [ok({ status: "In Progress" }), ok({ status: "Accepted" })],
    });
    expect(notarize(notary, "Nodex.dmg", quiet)).toBe("one");
    expect(calls).toEqual(["submit", "wait one", "info one", "wait one", "info one"]);
  });

  test("trusts Apple's record over the wait call's own exit", () => {
    const { notary } = client({
      submit: [ok({ id: "one" })],
      wait: [failed("exited with 1")],
      info: [ok({ status: "Accepted" })],
    });
    expect(notarize(notary, "Nodex.dmg", quiet)).toBe("one");
  });

  test("prints Apple's log and stops when Apple rejects the file", () => {
    const lines: string[] = [];
    const { notary, calls } = client({
      submit: [ok({ id: "one" })],
      wait: [ok({ status: "Invalid" })],
      info: [ok({ status: "Invalid" })],
      log: ok({ issues: [{ message: "The binary is not signed." }] }),
    });
    expect(() => notarize(notary, "Nodex.dmg", { report: (line) => lines.push(line) })).toThrow(
      "Apple invalid notarization submission one.",
    );
    expect(calls).toEqual(["submit", "wait one", "info one", "log one"]);
    expect(lines.join("\n")).toContain("The binary is not signed.");
  });

  test("gives up with the last failure once every attempt is spent", () => {
    const { notary } = client({
      submit: [failed("a"), failed("b"), failed("network connection was lost")],
    });
    expect(() => notarize(notary, "Nodex.dmg", quiet)).toThrow(
      "Notarization upload failed after 3 attempts: network connection was lost",
    );
    const waiting = client({
      submit: [ok({ id: "one" })],
      wait: [failed("x"), failed("y"), failed("timed out")],
      info: [failed("x"), failed("y"), ok({ status: "In Progress" })],
    });
    expect(() => notarize(waiting.notary, "Nodex.dmg", quiet)).toThrow(
      "Notarization submission one did not finish: timed out",
    );
  });
});

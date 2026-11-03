import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { signFile, verifyFileSignature } from "./signing";

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

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { expect, test } from "vite-plus/test";

// Resolve through real consumers so tests cover the lockfile's separate Undici majors.
const consumers = [
  ["@effect/platform-node"],
  ["jsdom"],
  ["electron-builder", "app-builder-lib", "@electron/rebuild", "node-gyp"],
];

test.each(consumers.map((chain) => ({ chain, name: chain.at(-1)! })))(
  "$name preserves compressed fetch and rejects invalid integrity/encoding",
  ({ chain }) => {
    let require = createRequire(import.meta.url);
    for (const name of chain) require = createRequire(require.resolve(name));
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
const require = createRequire(import.meta.url);
const { MockAgent, fetch } = require(process.argv[1]);
const dispatcher = new MockAgent();
dispatcher.disableNetConnect();
const origin = "https://nodex-test.invalid";
const mock = dispatcher.get(origin);
const digest = createHash("sha256").update("expected").digest("base64");
try {
  mock.intercept({ path: "/valid" }).reply(200, "expected");
  assert.equal(await (await fetch(origin + "/valid", {
    dispatcher, integrity: "SHA256-" + digest,
  })).text(), "expected");
  mock.intercept({ path: "/tampered" }).reply(200, "different");
  await assert.rejects(fetch(origin + "/tampered", {
    dispatcher, integrity: "ShA256-" + digest,
  }));
  mock.intercept({ path: "/compressed" }).reply(200, brotliCompressSync("compressed"), {
    headers: { "content-encoding": "br" },
  });
  assert.equal(await (await fetch(origin + "/compressed", { dispatcher })).text(), "compressed");
  mock.intercept({ path: "/encodings" }).reply(200, "", {
    headers: { "content-encoding": Array(6).fill("gzip").join(", ") },
  });
  await assert.rejects(fetch(origin + "/encodings", { dispatcher }));
  await new Promise((resolve) => setImmediate(resolve));
} finally {
  await dispatcher.close();
}
console.log("passed");
`,
        require.resolve("undici"),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(output.trim()).toBe("passed");
  },
);

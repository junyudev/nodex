import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { beginTestObservation, endTestObservation } from "../../testing/test-observation.mts";

const directory = realpathSync(process.argv[2]);
const root = process.cwd();
const here = import.meta.dirname;
const require = createRequire(import.meta.url);
mkdirSync(path.join(directory, "node_modules"));
const ambient = path.join(directory, "ambient-config");
writeFileSync(ambient, "ambient");

async function observe(name, run) {
  const file = path.join(here, name);
  beginTestObservation(file, "fixture", directory, globalThis);
  await run();
  endTestObservation(file);
}

function runSync(script, options) {
  const child = spawnSync(process.execPath, ["-e", script], {
    stdio: "ignore",
    ...options,
  });
  assert.equal(child.status, 0, String(child.error ?? child.signal));
}

await observe("missing-module", async () => {
  assert.throws(
    () => require.resolve("nodex-recorder-optional", { paths: [directory] }),
    { code: "MODULE_NOT_FOUND" },
  );
  await assert.rejects(import("./missing-entry.mjs"), { code: "ERR_MODULE_NOT_FOUND" });
  await assert.rejects(import("nodex-recorder-esm-optional"), { code: "ERR_MODULE_NOT_FOUND" });
});

await observe("external-module", async () => {
  await assert.rejects(import(pathToFileURL(path.join(directory, "missing.mjs")).href), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});

await observe("directory-module", () => {
  assert.throws(() => require.resolve("../../testing/fixtures"), { code: "MODULE_NOT_FOUND" });
});

await observe("node-child", async () => {
  const input = path.relative(root, path.join(here, "import-only.test.ts"));
  const script = `const fs = require("node:fs");
    fs.readFileSync(${JSON.stringify(input)});
    fs.existsSync(${JSON.stringify(path.join(here, "missing-child-input"))});`;
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  assert.equal((await once(child, "close"))[0], 0);
  runSync(`process.on("exit", () => require("node:fs").readFileSync(${JSON.stringify(
    path.join(here, "vitest.config.ts"),
  )}));`);
});

await observe("grandchild", () => {
  runSync('require("node:child_process").spawnSync(process.execPath, ["-e", ""]);');
});

await observe("abrupt-child", () => {
  runSync("process.reallyExit(0)");
});

await observe("custom-preload", () => {
  runSync("", { env: { ...process.env, NODE_OPTIONS: "--require=node:fs" } });
});

const request = `(get) => {
  const pending = get("http://127.0.0.1:1");
  pending.on("error", () => {});
  pending.destroy();
}`;
await observe("commonjs-child-network", () => {
  runSync(`(${request})(require("node:http").get)`);
});
await observe("esm-child-network", () => {
  runSync(`import("node:http").then(({ get }) => (${request})(get))`);
});

await observe("runtime-executable", () => {
  assert.ok(readFileSync(process.execPath).length);
});
await observe("ambient-runtime-neighbor", () => {
  assert.throws(() => readFileSync(process.execPath + ".nodex-recorder-missing"), { code: "ENOENT" });
});

await observe("external-input", () => {
  runSync(`require("node:fs").readFileSync(${JSON.stringify(ambient)})`);
});

process.stdout.write(JSON.stringify(
  readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8"))),
));

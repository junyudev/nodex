import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, expect, it } from "vite-plus/test";
import { materializeRestoredCodexConfiguration } from "./AgentRuntimeNativeConfiguration";

const homes: string[] = [];
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "nodex-native-config-"));
  homes.push(home);
  const configuredHome = join(home, "account");
  const historyHome = join(home, "history");
  await mkdir(configuredHome);
  await mkdir(historyHome);
  return { home, configuredHome, historyHome };
};
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it("retains current provider/network policy while execution and credentials have separate owners", async () => {
  const f = await fixture();
  await mkdir(join(f.configuredHome, "skills"));
  await writeFile(join(f.configuredHome, "auth.json"), "private-account-store");
  await writeFile(
    join(f.configuredHome, "config.toml"),
    `sqlite_home = "/old/history"\ncli_auth_credentials_store = "keyring"\nmodel_provider = "custom"\nchatgpt_base_url = "https://configured.example"\n[model_providers.custom]\nbase_url = "http://localhost:1234"\nenv_key = "CUSTOM_KEY"\nwire_api = "responses"\n`,
  );
  await materializeRestoredCodexConfiguration(f);
  const current = parse(await readFile(join(f.historyHome, "config.toml"), "utf8"));
  expect(current).toEqual({
    sqlite_home: await realpath(f.historyHome),
    cli_auth_credentials_store: "ephemeral",
    model_provider: "custom",
    chatgpt_base_url: "https://configured.example",
    model_providers: {
      custom: { base_url: "http://localhost:1234", env_key: "CUSTOM_KEY", wire_api: "responses" },
    },
  });
  assert.strictEqual(
    await readlink(join(f.historyHome, "skills")),
    await realpath(join(f.configuredHome, "skills")),
  );
  await assert.rejects(readFile(join(f.historyHome, "auth.json")), { code: "ENOENT" });
  await materializeRestoredCodexConfiguration(f);
  assert.strictEqual(
    await readFile(join(f.configuredHome, "auth.json"), "utf8"),
    "private-account-store",
  );
});

it("refreshes configured policy and removes stale derived settings when their source disappears", async () => {
  const f = await fixture();
  await writeFile(join(f.configuredHome, "config.toml"), 'model = "first"\n');
  await materializeRestoredCodexConfiguration(f);
  await writeFile(join(f.configuredHome, "config.toml"), 'model = "second"\n');
  await materializeRestoredCodexConfiguration(f);
  assert.strictEqual(
    parse(await readFile(join(f.historyHome, "config.toml"), "utf8")).model,
    "second",
  );
  await rm(join(f.configuredHome, "config.toml"));
  await materializeRestoredCodexConfiguration(f);
  await assert.rejects(readFile(join(f.historyHome, "config.toml")), { code: "ENOENT" });
});

it("refuses oversized source policy and a redirected destination before replacing files", async () => {
  const f = await fixture();
  await writeFile(join(f.configuredHome, "config.toml"), " ".repeat(1024 * 1024 + 1));
  await assert.rejects(materializeRestoredCodexConfiguration(f));
  await writeFile(join(f.configuredHome, "config.toml"), 'model = "current"\n');
  const outside = join(f.home, "outside.toml");
  await writeFile(outside, 'model = "outside"\n');
  await symlink(outside, join(f.historyHome, "config.toml"));
  await assert.rejects(materializeRestoredCodexConfiguration(f));
  assert.strictEqual(parse(await readFile(outside, "utf8")).model, "outside");
});

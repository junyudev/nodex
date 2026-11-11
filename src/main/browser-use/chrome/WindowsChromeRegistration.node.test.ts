import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { RegistryValue } from "../../platform/node/WindowsDesktopTools";
import {
  createWindowsChromeRegistration,
  windowsChromeStatePath,
} from "./WindowsChromeRegistration";
import { TEST_CHROME_HOST_NAME } from "./chrome-test-fixture";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-browser-registration-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const value = (manifest: string): RegistryValue => ({
  kind: 1,
  dataHex: Buffer.from(manifest + "\0", "utf16le").toString("hex"),
});

function setup() {
  const values = new Map<string, RegistryValue>();
  const profile = (name: string) =>
    createWindowsChromeRegistration({
      statePath: windowsChromeStatePath(path.join(root, name)),
      host: TEST_CHROME_HOST_NAME,
      browsers: ["chrome", "edge"],
      security: {
        verify: async () => {},
        ensureDirectory: async (directory) => {
          await fs.mkdir(directory, { recursive: true });
        },
      },
      registry: {
        readRegistration: async ({ browser }) => values.get(browser) ?? null,
        writeRegistration: async (key, expected, target) => {
          if (JSON.stringify(values.get(key.browser) ?? null) !== JSON.stringify(expected)) {
            throw new Error("Registry changed");
          }
          const installed = value(target);
          values.set(key.browser, installed);
          return { key, installed, previous: expected, createdKey: expected === null };
        },
        restoreRegistration: async ({ browser }, receipt) => {
          if (values.get(browser)?.dataHex !== receipt.installed.dataHex) return false;
          if (receipt.previous) values.set(browser, receipt.previous);
          else values.delete(browser);
          return true;
        },
      },
    });
  return { profile, values };
}

const prepare = async () => async () => {};

test("takes over only the displayed registration and restores its previous value across relaunch", async () => {
  const { profile, values } = setup();
  const first = "C:\\Other App\\original.json";
  const replacement = "C:\\Other App\\replacement.json";
  values.set("chrome", value(first));
  const nodex = profile("one");
  const observed = await nodex.reconcile(prepare);
  expect(observed).toMatchObject({
    status: "registration-in-use",
    owner: "app",
    manifestPaths: [first],
  });
  if (observed.status !== "registration-in-use" || !observed.takeoverToken)
    throw new Error("Missing takeover");
  expect(values.get("chrome")).toEqual(value(first));
  expect(values.has("edge")).toBe(false);

  values.set("chrome", value(replacement));
  const changed = await nodex.reconcile(prepare, {
    kind: "takeover",
    token: observed.takeoverToken,
  });
  expect(changed).toMatchObject({ status: "registration-in-use", manifestPaths: [replacement] });
  if (changed.status !== "registration-in-use" || !changed.takeoverToken)
    throw new Error("Missing takeover");
  expect(
    await nodex.reconcile(prepare, { kind: "takeover", token: changed.takeoverToken }),
  ).toEqual({
    status: "owned",
    canGiveBack: true,
  });
  expect(await profile("one").reconcile(prepare, { kind: "repair" })).toEqual({
    status: "owned",
    canGiveBack: true,
  });
  expect(await profile("one").reconcile(prepare, { kind: "disable" })).toEqual({
    status: "disabled",
  });
  expect(values.get("chrome")).toEqual(value(replacement));
  expect(values.has("edge")).toBe(false);
  expect(await profile("one").reconcile(prepare)).toEqual({ status: "disabled" });
});

test("keeps two Profiles from taking each other's registrations and skips stale receipts", async () => {
  const { profile, values } = setup();
  const owner = profile("owner");
  expect(await owner.reconcile(prepare)).toEqual({ status: "owned", canGiveBack: false });
  const second = profile("second");
  expect(await second.reconcile(prepare)).toMatchObject({
    status: "registration-in-use",
    owner: "profile",
    takeoverToken: null,
  });
  expect(await second.ownsRegistration()).toBe(false);

  const laterOwner = value("C:\\Other App\\later.json");
  values.set("chrome", laterOwner);
  await owner.reconcile(prepare, { kind: "disable" });
  expect(values.get("chrome")).toEqual(laterOwner);
  expect(values.has("edge")).toBe(false);
});

test("arbitrates simultaneous first claims through the Chrome transaction", async () => {
  const { profile, values } = setup();
  const first = profile("first");
  const second = profile("second");
  const results = await Promise.all([first.reconcile(prepare), second.reconcile(prepare)]);
  expect(results.map(({ status }) => status).sort()).toEqual(["owned", "registration-in-use"]);
  const owners = await Promise.all([first.ownsRegistration(), second.ownsRegistration()]);
  expect(owners.filter(Boolean)).toHaveLength(1);
  expect(values.get("chrome")).toEqual(values.get("edge"));
  const rejected = owners[0] ? second : first;
  expect(await rejected.reconcile(prepare)).toMatchObject({
    status: "registration-in-use",
    owner: "profile",
  });
});

test("gives back a temporary registration on exit and allows the next launch to register", async () => {
  const { profile, values } = setup();
  const previous = value("C:\\Other App\\original.json");
  values.set("chrome", previous);
  const owner = profile("dev");
  const conflict = await owner.reconcile(prepare);
  if (conflict.status !== "registration-in-use" || !conflict.takeoverToken)
    throw new Error("Missing takeover");
  await owner.reconcile(prepare, { kind: "takeover", token: conflict.takeoverToken });

  await owner.release();
  expect(values.get("chrome")).toEqual(previous);
  expect(values.has("edge")).toBe(false);
  expect(await profile("dev").reconcile(prepare)).toMatchObject({
    status: "registration-in-use",
    owner: "app",
  });
});

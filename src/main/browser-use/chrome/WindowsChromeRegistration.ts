import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  NativeMessagingKey,
  RegistrationReceipt,
  RegistryValue,
} from "../../platform/node/WindowsDesktopTools";
import type { ChromeControlSettingsAction } from "../../../shared/chrome-control-settings";
import { writeJsonAtomically } from "./ChromeNativeHostInstaller";
import type { WindowsChromeFileSecurity } from "./WindowsChromeNativeHost";

const stateDirectory = "chrome-control/windows";
const journalFile = "registration-v1.json";
const manifestDirectory = "native-messaging";
const registryValue = z.object({
  kind: z.number().int().min(0).max(0xffffffff),
  dataHex: z
    .string()
    .max(131072)
    .regex(/^(?:[0-9a-f]{2})*$/u),
});
const receipt = z.object({
  key: z.object({ browser: z.enum(["chrome", "edge"]), view: z.literal("x86"), host: z.string() }),
  installed: registryValue,
  previous: registryValue.nullable(),
  createdKey: z.boolean(),
});
const journal = z.object({
  installationDirectory: z.string().optional(),
  enabled: z.boolean(),
  receipts: z.array(receipt).max(2),
});

export interface WindowsChromeRegistryPort {
  readonly readRegistration: (key: NativeMessagingKey) => Promise<RegistryValue | null>;
  readonly writeRegistration: (
    key: NativeMessagingKey,
    expected: RegistryValue | null,
    manifest: string,
  ) => Promise<RegistrationReceipt>;
  readonly restoreRegistration: (
    key: NativeMessagingKey,
    receipt: RegistrationReceipt,
  ) => Promise<boolean>;
}

export type WindowsChromeRegistrationState =
  | { status: "owned"; canGiveBack: boolean }
  | { status: "disabled" }
  | {
      status: "registration-in-use";
      owner: "app" | "profile";
      manifestPaths: readonly string[];
      takeoverToken: string | null;
    };

export const windowsChromeStatePath = (runtimeStateHome: string) =>
  path.join(runtimeStateHome, stateDirectory);

const registryPathValue = (manifest: string): RegistryValue => ({
  kind: 1,
  dataHex: Buffer.from(`${manifest}\0`, "utf16le").toString("hex"),
});

const sameValue = (left: RegistryValue | null, right: RegistryValue) =>
  left?.kind === right.kind && left.dataHex === right.dataHex;

function manifestPath(value: RegistryValue): string | null {
  if ((value.kind !== 1 && value.kind !== 2) || value.dataHex.length % 4 !== 0) return null;
  const decoded = Buffer.from(value.dataHex, "hex").toString("utf16le").replace(/\0$/u, "");
  if (decoded.includes("\0") || !decoded || decoded.length > 1024) return null;
  return decoded;
}

const samePath = (left: string, right: string) =>
  path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();

/** One shared HKCU view. Claim Chrome first so two Profiles cannot split Chrome and Edge. */
export function createWindowsChromeRegistration(options: {
  readonly statePath: string;
  readonly host: string;
  readonly installationDirectory?: string;
  readonly browsers: readonly ("chrome" | "edge")[];
  readonly security: WindowsChromeFileSecurity;
  readonly registry: WindowsChromeRegistryPort;
  readonly releaseResources?: () => Promise<void>;
}) {
  const { host, registry, security, statePath } = options;
  const target = path.join(statePath, manifestDirectory, `${host}.json`);
  const profileSuffix = path.win32.join(
    "chrome-control",
    "windows",
    manifestDirectory,
    `${host}.json`,
  );
  const installed = registryPathValue(target);
  const keys = [...new Set(options.browsers)]
    .sort()
    .map((browser) => ({ browser, view: "x86", host }) as const);
  const journalPath = path.join(statePath, journalFile);
  const save = (state: z.infer<typeof journal>) =>
    writeJsonAtomically(
      journalPath,
      { ...state, installationDirectory: options.installationDirectory },
      0o600,
      true,
    );
  let approved: { token: string; values: readonly (RegistryValue | null)[] } | null = null;

  const readState = async (): Promise<z.infer<typeof journal>> => {
    await security.ensureDirectory(statePath);
    try {
      await fs.lstat(journalPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { enabled: true, receipts: [] };
      }
      throw error;
    }
    await security.verify(journalPath);
    const stats = await fs.stat(journalPath);
    if (!stats.isFile() || stats.size > 600_000)
      throw new Error("Invalid browser registration journal");
    const state = journal.parse(JSON.parse(await fs.readFile(journalPath, "utf8")));
    if (
      state.receipts.some(
        (entry) =>
          entry.key.host !== host ||
          !keys.some(({ browser }) => browser === entry.key.browser) ||
          !sameValue(entry.installed, installed),
      ) ||
      new Set(state.receipts.map(({ key }) => key.browser)).size !== state.receipts.length
    ) {
      throw new Error("Browser registration receipt belongs to a different Profile or host");
    }
    if (
      state.receipts.length > 0 &&
      state.installationDirectory !== undefined &&
      !samePath(state.installationDirectory, options.installationDirectory ?? "")
    ) {
      // Maintenance may have already given back every value. Only a still-live
      // receipt reserves this Profile for its original installation.
      const owned = await Promise.all(
        state.receipts.map(async (entry) =>
          sameValue(await registry.readRegistration(entry.key), entry.installed),
        ),
      );
      if (owned.some(Boolean))
        throw new Error("Browser registration receipts belong to a different installation");
      return { enabled: state.enabled, receipts: [] };
    }
    return state;
  };

  const readValues = () => Promise.all(keys.map(registry.readRegistration));
  const isOwned = (value: RegistryValue | null) => sameValue(value, installed);
  const matchesApproval = (values: readonly (RegistryValue | null)[]) =>
    approved !== null &&
    values.every((value, index) =>
      value === null
        ? approved?.values[index] === null
        : sameValue(approved?.values[index] ?? null, value),
    );

  const observeConflict = (
    values: readonly (RegistryValue | null)[],
    action?: ChromeControlSettingsAction,
  ): WindowsChromeRegistrationState | null => {
    const conflicts = values.filter(
      (value): value is RegistryValue => value !== null && !isOwned(value),
    );
    if (conflicts.length === 0) return null;
    const paths = conflicts.map(manifestPath);
    const otherProfile = paths.some(
      (candidate) =>
        candidate !== null &&
        path.win32
          .normalize(candidate)
          .toLowerCase()
          .endsWith(`\\${profileSuffix.toLowerCase()}`) &&
        !samePath(candidate, target),
    );
    const takeover =
      action?.kind === "takeover" &&
      !otherProfile &&
      approved?.token === action.token &&
      matchesApproval(values);
    if (!takeover) {
      if (otherProfile || paths.some((candidate) => candidate === null)) approved = null;
      else if (!matchesApproval(values)) approved = { token: randomUUID(), values };
      return {
        status: "registration-in-use",
        owner: otherProfile ? "profile" : "app",
        manifestPaths: [
          ...new Set(paths.filter((candidate): candidate is string => candidate !== null)),
        ],
        takeoverToken: approved?.token ?? null,
      };
    }
    return null;
  };

  const release = async (receipts: readonly RegistrationReceipt[], enabled: boolean) => {
    for (const entry of [...receipts].reverse()) {
      // The native compare-and-restore transaction skips a registration replaced elsewhere.
      await registry.restoreRegistration(entry.key, entry);
    }
    if (receipts.length > 0) {
      await options.releaseResources?.();
      await save({ enabled, receipts: [] });
    }
    approved = null;
  };

  const reconcile = async (
    prepare: (target: string, repair: boolean) => Promise<() => Promise<void>>,
    action?: ChromeControlSettingsAction,
  ): Promise<WindowsChromeRegistrationState> => {
    const state = await readState();
    if (action?.kind === "disable" || (!state.enabled && action?.kind !== "enable")) {
      if (state.enabled) await save({ ...state, enabled: false });
      await release(state.receipts, false);
      return { status: "disabled" };
    }
    if (!state.enabled) await save({ ...state, enabled: true });

    const values = await readValues();
    const blocked = observeConflict(values, action);
    if (blocked) return blocked;
    approved = null;

    const publish = await prepare(target, action?.kind === "repair");
    // A receipt for a value that was replaced must never restore a historical owner.
    let receipts = state.receipts.filter((entry) =>
      isOwned(values[keys.findIndex(({ browser }) => browser === entry.key.browser)] ?? null),
    );
    for (const [index, key] of keys.entries()) {
      const previous = values[index] ?? null;
      if (isOwned(previous)) {
        if (!receipts.some((entry) => entry.key.browser === key.browser)) {
          receipts.push({ key, installed, previous: null, createdKey: false });
          await save({ enabled: true, receipts });
        }
        continue;
      }

      // Write the undo data before entering the native transaction. If Main exits
      // before the native receipt returns, restoration can still undo the value.
      const pending = { key, installed, previous, createdKey: false };
      await save({ enabled: true, receipts: [...receipts, pending] });
      const committed = await registry
        .writeRegistration(key, previous, target)
        .catch(async (error) => {
          // A competing transaction may have committed since our read. Show the
          // resulting owner immediately and retain the pending receipt for recovery.
          const latest = await readValues();
          const current = latest[index] ?? null;
          if (current && !isOwned(current) && !sameValue(previous, current)) {
            const conflict = observeConflict(latest);
            if (conflict) return conflict;
          }
          throw error;
        });
      if ("status" in committed) return committed;
      receipts = [...receipts, { ...pending, createdKey: committed.createdKey }];
      await save({ enabled: true, receipts });
    }
    await publish();
    return { status: "owned", canGiveBack: receipts.some(({ previous }) => previous !== null) };
  };

  return {
    reconcile,
    release: async () => {
      const { receipts, enabled } = await readState();
      await release(receipts, enabled);
    },
    ownsRegistration: async () => (await readValues()).every(isOwned),
  };
}

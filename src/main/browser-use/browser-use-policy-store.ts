import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  DEFAULT_BROWSER_USE_POLICY,
  BrowserUsePolicyModesUpdateSchema,
  BrowserUseOriginRuleUpdateSchema,
  MAX_BROWSER_USE_POLICY_ORIGINS,
  normalizeBrowserUsePolicyOrigin,
  type BrowserUseOriginRuleUpdate,
  type BrowserUsePolicyModesUpdate,
  type BrowserUsePolicyResource,
  type BrowserUsePolicySnapshot,
} from "../../shared/browser-use-policy";

const MAX_POLICY_FILE_BYTES = 256 * 1024;

type UnknownRecord = Record<string, unknown>;

const TABLE_BY_RESOURCE: Record<BrowserUsePolicyResource, string> = {
  origin: "origins",
  download: "downloads",
  upload: "uploads",
  fullCdp: "full_cdp",
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    try {
      const origin = normalizeBrowserUsePolicyOrigin(entry);
      if (seen.has(origin)) continue;
      seen.add(origin);
      result.push(origin);
    } catch {
      // Invalid rules disappear on the next successful user mutation.
    }
    if (result.length >= MAX_BROWSER_USE_POLICY_ORIGINS) break;
  }
  return result;
};

const readApprovalMode = (value: unknown): "alwaysAsk" | "neverAsk" =>
  value === "never_ask" ? "neverAsk" : "alwaysAsk";

const writeApprovalMode = (value: "alwaysAsk" | "neverAsk"): string =>
  value === "neverAsk" ? "never_ask" : "always_ask";

const readRuleTable = (
  config: UnknownRecord,
  resource: BrowserUsePolicyResource,
): { allowed: string[]; denied: string[] } => {
  const table = config[TABLE_BY_RESOURCE[resource]];
  if (!isRecord(table)) return { allowed: [], denied: [] };
  return {
    allowed: readStringArray(table.allowed),
    denied: readStringArray(table.denied),
  };
};

const projectSnapshot = (config: UnknownRecord): BrowserUsePolicySnapshot => {
  const origins = readRuleTable(config, "origin");
  const downloads = readRuleTable(config, "download");
  const uploads = readRuleTable(config, "upload");
  const fullCdp = readRuleTable(config, "fullCdp");
  return {
    fullCdpAccessEnabled: config.full_cdp_access_enabled === true,
    approvalMode: readApprovalMode(config.approval_mode),
    historyApprovalMode: readApprovalMode(config.history_approval_mode),
    downloadApprovalMode: readApprovalMode(config.download_approval_mode),
    uploadApprovalMode: readApprovalMode(config.upload_approval_mode),
    allowedOrigins: origins.allowed,
    deniedOrigins: origins.denied,
    allowedDownloadOrigins: downloads.allowed,
    deniedDownloadOrigins: downloads.denied,
    allowedUploadOrigins: uploads.allowed,
    deniedUploadOrigins: uploads.denied,
    allowedFullCdpOrigins: fullCdp.allowed,
    deniedFullCdpOrigins: fullCdp.denied,
  };
};

const copySnapshot = (current: BrowserUsePolicySnapshot): BrowserUsePolicySnapshot => ({
  ...current,
  allowedOrigins: [...current.allowedOrigins],
  deniedOrigins: [...current.deniedOrigins],
  allowedDownloadOrigins: [...current.allowedDownloadOrigins],
  deniedDownloadOrigins: [...current.deniedDownloadOrigins],
  allowedUploadOrigins: [...current.allowedUploadOrigins],
  deniedUploadOrigins: [...current.deniedUploadOrigins],
  allowedFullCdpOrigins: [...current.allowedFullCdpOrigins],
  deniedFullCdpOrigins: [...current.deniedFullCdpOrigins],
});

export interface BrowserUsePolicyReader {
  readonly snapshot: () => BrowserUsePolicySnapshot;
  readonly isExplicitlyDenied: (resource: BrowserUsePolicyResource, urlOrOrigin: string) => boolean;
}

export class BrowserUsePolicyRuntimeError extends Schema.TaggedError<BrowserUsePolicyRuntimeError>()(
  "BrowserUsePolicyRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface BrowserUsePolicyRuntime extends BrowserUsePolicyReader {
  readonly updateModes: (
    update: BrowserUsePolicyModesUpdate,
  ) => Effect.Effect<BrowserUsePolicySnapshot, BrowserUsePolicyRuntimeError>;
  readonly updateOriginRule: (
    update: BrowserUseOriginRuleUpdate,
  ) => Effect.Effect<BrowserUsePolicySnapshot, BrowserUsePolicyRuntimeError>;
}

interface BrowserUsePolicyState {
  readonly config: UnknownRecord;
  readonly snapshot: BrowserUsePolicySnapshot;
}

const defaultState = (): BrowserUsePolicyState => ({
  config: {},
  snapshot: DEFAULT_BROWSER_USE_POLICY,
});

const runtimeError = (operation: string, cause: unknown): BrowserUsePolicyRuntimeError =>
  new BrowserUsePolicyRuntimeError({ operation, cause });

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  typeof cause.reason === "object" &&
  cause.reason !== null &&
  "_tag" in cause.reason &&
  cause.reason._tag === "NotFound";

export const makeBrowserUsePolicyRuntime = (
  filePath: string,
  now: () => number = Date.now,
): Effect.Effect<BrowserUsePolicyRuntime, BrowserUsePolicyRuntimeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const quarantine = fs.rename(filePath, `${filePath}.corrupt-${now()}`).pipe(
      Effect.catch((cause) => (isNotFound(cause) ? Effect.void : Effect.fail(cause))),
      Effect.mapError((cause) => runtimeError("quarantine", cause)),
    );

    const load = Effect.gen(function* () {
      const exists = yield* fs
        .exists(filePath)
        .pipe(Effect.mapError((cause) => runtimeError("check-exists", cause)));
      if (!exists) return defaultState();
      return yield* fs.readFileString(filePath).pipe(
        Effect.mapError((cause) => runtimeError("read", cause)),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => {
              if (Buffer.byteLength(raw, "utf8") > MAX_POLICY_FILE_BYTES) {
                throw new TypeError("Browser Use policy file exceeds its size limit");
              }
              const config = parseToml(raw);
              if (!isRecord(config)) throw new TypeError("Browser Use policy root is invalid");
              return { config, snapshot: projectSnapshot(config) } satisfies BrowserUsePolicyState;
            },
            catch: (cause) => runtimeError("parse", cause),
          }),
        ),
        Effect.catch(() => quarantine.pipe(Effect.as(defaultState()))),
      );
    });

    const persist = (config: UnknownRecord): Effect.Effect<void, BrowserUsePolicyRuntimeError> =>
      Effect.gen(function* () {
        const payload = yield* Effect.try({
          try: () => {
            const value = stringifyToml(config);
            const normalized = value.endsWith("\n") ? value : `${value}\n`;
            if (Buffer.byteLength(normalized, "utf8") > MAX_POLICY_FILE_BYTES) {
              throw new TypeError("Browser Use policy file exceeds its size limit");
            }
            return normalized;
          },
          catch: (cause) => runtimeError("serialize", cause),
        });
        const directoryPath = dirname(filePath);
        const temporaryPath = join(
          directoryPath,
          `.${basename(filePath)}.${now()}.${randomUUID()}.tmp`,
        );
        yield* fs
          .makeDirectory(directoryPath, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError((cause) => runtimeError("make-directory", cause)));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(temporaryPath, { flag: "wx", mode: 0o600 });
            yield* file.writeAll(new TextEncoder().encode(payload));
            yield* file.sync;
          }),
        ).pipe(
          Effect.andThen(fs.rename(temporaryPath, filePath)),
          Effect.andThen(
            Effect.scoped(
              Effect.gen(function* () {
                const directory = yield* fs.open(directoryPath, { flag: "r" });
                yield* directory.sync;
              }),
            ),
          ),
          Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
          Effect.mapError((cause) => runtimeError("persist", cause)),
        );
      });

    const state = yield* Ref.make(yield* load);
    const writes = yield* Semaphore.make(1);
    const snapshot = (): BrowserUsePolicySnapshot => copySnapshot(Ref.getUnsafe(state).snapshot);
    const isExplicitlyDenied = (
      resource: BrowserUsePolicyResource,
      urlOrOrigin: string,
    ): boolean => {
      let origin: string;
      try {
        origin = normalizeBrowserUsePolicyOrigin(urlOrOrigin);
      } catch {
        return true;
      }
      const current = Ref.getUnsafe(state).snapshot;
      const originDenied = current.deniedOrigins.includes(origin);
      if (resource === "origin") return originDenied;
      const denied = {
        download: current.deniedDownloadOrigins,
        upload: current.deniedUploadOrigins,
        fullCdp: current.deniedFullCdpOrigins,
      }[resource];
      return originDenied || denied.includes(origin);
    };

    return {
      snapshot,
      isExplicitlyDenied,
      updateModes: (rawUpdate) =>
        Effect.try({
          try: () => BrowserUsePolicyModesUpdateSchema.parse(rawUpdate),
          catch: (cause) => runtimeError("validate-modes", cause),
        }).pipe(
          Effect.flatMap((update) =>
            writes.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* Ref.get(state);
                const config = { ...current.config };
                if (update.approvalMode !== undefined) {
                  config.approval_mode = writeApprovalMode(update.approvalMode);
                }
                if (update.historyApprovalMode !== undefined) {
                  config.history_approval_mode = writeApprovalMode(update.historyApprovalMode);
                }
                if (update.downloadApprovalMode !== undefined) {
                  config.download_approval_mode = writeApprovalMode(update.downloadApprovalMode);
                }
                if (update.uploadApprovalMode !== undefined) {
                  config.upload_approval_mode = writeApprovalMode(update.uploadApprovalMode);
                }
                if (update.fullCdpAccessEnabled !== undefined) {
                  config.full_cdp_access_enabled = update.fullCdpAccessEnabled;
                }
                const next = { config, snapshot: projectSnapshot(config) };
                yield* persist(config);
                yield* Ref.set(state, next);
                return copySnapshot(next.snapshot);
              }),
            ),
          ),
        ),
      updateOriginRule: (rawUpdate) =>
        Effect.try({
          try: () => BrowserUseOriginRuleUpdateSchema.parse(rawUpdate),
          catch: (cause) => runtimeError("validate-origin-rule", cause),
        }).pipe(
          Effect.flatMap((update) =>
            writes.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* Ref.get(state);
                const origin = normalizeBrowserUsePolicyOrigin(update.origin);
                const tableName = TABLE_BY_RESOURCE[update.resource];
                const previousTable = isRecord(current.config[tableName])
                  ? current.config[tableName]
                  : {};
                const table = { ...previousTable };
                const selected = readStringArray(table[update.kind]);
                if (update.action === "remove") {
                  table[update.kind] = selected.filter((entry) => entry !== origin);
                } else {
                  const oppositeKind = update.kind === "allowed" ? "denied" : "allowed";
                  table[update.kind] = selected.includes(origin)
                    ? selected
                    : [...selected, origin].slice(0, MAX_BROWSER_USE_POLICY_ORIGINS);
                  table[oppositeKind] = readStringArray(table[oppositeKind]).filter(
                    (entry) => entry !== origin,
                  );
                }
                const config = { ...current.config, [tableName]: table };
                const next = { config, snapshot: projectSnapshot(config) };
                yield* persist(config);
                yield* Ref.set(state, next);
                return copySnapshot(next.snapshot);
              }),
            ),
          ),
        ),
    } satisfies BrowserUsePolicyRuntime;
  });

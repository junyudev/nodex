/**
 * What Claude Code keeps about its login in `.claude.json`: the organization it is signed in
 * to and the last usage reading it stored. Read-only; Nodex never writes this file and never
 * asks the account for anything itself.
 *
 * @module provider/claudeAccountConfig
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ClaudeStoredUsage } from "./claudeUsageLimits.ts";

const Config = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      organizationUuid: Schema.optional(Schema.String),
      accountUuid: Schema.optional(Schema.String),
    }),
  ),
  // Decoded on its own below, so a shape this build does not know never hides the organization.
  cachedUsageUtilization: Schema.optional(Schema.Unknown),
});
const StoredWindow = Schema.NullOr(
  Schema.Struct({
    utilization: Schema.optional(Schema.NullOr(Schema.Number)),
    resets_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const StoredUsage = Schema.Struct({
  fetchedAtMs: Schema.Number,
  accountUuid: Schema.optional(Schema.String),
  utilization: Schema.Struct({
    five_hour: Schema.optional(StoredWindow),
    seven_day: Schema.optional(StoredWindow),
  }),
});
const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(Config));
const decodeStoredUsage = Schema.decodeUnknownOption(StoredUsage);

export interface ClaudeAccountState {
  /** The organization the login is signed in to; one email can belong to several. */
  readonly organizationId: string | undefined;
  /** The usage reading Claude Code last stored for this login. */
  readonly storedUsage: ClaudeStoredUsage | undefined;
}

const window = (stored: typeof StoredWindow.Type | undefined) =>
  stored ? { utilization: stored.utilization ?? null, resets_at: stored.resets_at ?? null } : null;

/** Reads nothing when the file is missing or unreadable, rather than failing a provider check. */
export const readClaudeAccountState = (
  accountConfigPath: string,
): Effect.Effect<ClaudeAccountState, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* fs.readFileString(accountConfigPath).pipe(Effect.flatMap(decodeConfig));
    const account = config.oauthAccount;
    const stored = Option.getOrUndefined(decodeStoredUsage(config.cachedUsageUtilization));
    // A reading kept for another login does not describe this one.
    const sameLogin = stored !== undefined && stored.accountUuid === account?.accountUuid;
    return {
      organizationId: account?.organizationUuid?.trim() || undefined,
      storedUsage:
        stored && sameLogin
          ? {
              fetchedAtMs: stored.fetchedAtMs,
              windows: {
                five_hour: window(stored.utilization.five_hour),
                seven_day: window(stored.utilization.seven_day),
              },
            }
          : undefined,
    } satisfies ClaudeAccountState;
  }).pipe(Effect.orElseSucceed(() => ({ organizationId: undefined, storedUsage: undefined })));

/** The CLI keeps the account record beside its settings, or in the home directory by default. */
export const claudeAccountConfigPath = Effect.fn("claudeAccountConfigPath")(function* (
  configDir: string | undefined,
) {
  const path = yield* Path.Path;
  return configDir
    ? path.join(configDir, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
});

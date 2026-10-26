import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";

import { readClaudeAccountState } from "./claudeAccountConfig.ts";

const withConfig = (contents: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-claude-account-" });
    const file = NodePath.join(directory, ".claude.json");
    if (contents !== undefined)
      yield* fs.writeFileString(
        file,
        typeof contents === "string" ? contents : JSON.stringify(contents),
      );
    return yield* readClaudeAccountState(file);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const utilization = {
  five_hour: { utilization: 40, resets_at: "2026-10-26T12:00:00Z" },
  seven_day: { utilization: 18, resets_at: "2026-10-30T08:00:00Z" },
  // Fields this build does not read stay out of the way.
  extra_usage: { is_enabled: false },
};

it.effect("reads the organization and the usage Claude Code stored for this login", () =>
  Effect.gen(function* () {
    const state = yield* withConfig({
      oauthAccount: { organizationUuid: " org-1 ", accountUuid: "account-1" },
      cachedUsageUtilization: { fetchedAtMs: 1_000, accountUuid: "account-1", utilization },
    });
    assert.deepStrictEqual(state, {
      organizationId: "org-1",
      storedUsage: {
        fetchedAtMs: 1_000,
        windows: { five_hour: utilization.five_hour, seven_day: utilization.seven_day },
      },
    });
  }),
);

it.effect("ignores a reading stored for another login or in a shape it does not know", () =>
  Effect.gen(function* () {
    const other = yield* withConfig({
      oauthAccount: { organizationUuid: "org-1", accountUuid: "account-1" },
      cachedUsageUtilization: { fetchedAtMs: 1_000, accountUuid: "account-2", utilization },
    });
    assert.deepStrictEqual(other, { organizationId: "org-1", storedUsage: undefined });
    const unknown = yield* withConfig({
      oauthAccount: { organizationUuid: "org-1" },
      cachedUsageUtilization: { fetchedAt: "yesterday" },
    });
    assert.deepStrictEqual(unknown, { organizationId: "org-1", storedUsage: undefined });
  }),
);

it.effect("reads nothing from a missing or unreadable file", () =>
  Effect.gen(function* () {
    const empty = { organizationId: undefined, storedUsage: undefined };
    assert.deepStrictEqual(yield* withConfig(undefined), empty);
    assert.deepStrictEqual(yield* withConfig("{not json"), empty);
  }),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";

import { resolveUsageLimitsAfterProbe } from "@t3tools/provider-core/server/usageLimits";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const subscriptionProbe = {
  email: "ada@example.com",
  subscriptionType: "max",
  tokenSource: "claude.ai",
  apiKeySource: undefined,
  apiProvider: "firstParty",
  slashCommands: [],
  usage: {
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 40, resets_at: "2026-10-26T12:00:00Z" } },
  },
} as const;

const withFakeClaude = <A, E>(
  check: (input: {
    readonly settings: ClaudeSettings;
    readonly cwd: string;
  }) => Effect.Effect<A, E, NodeServices.NodeServices>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs
      .makeTempDirectoryScoped({ prefix: "nodex-claude-status-" })
      .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
    const binaryPath = NodePath.join(cwd, "claude");
    yield* fs.writeFileString(binaryPath, "#!/bin/sh\necho '2.1.310 (Claude Code)'\n");
    yield* fs.chmod(binaryPath, 0o755);
    const settings = Schema.decodeSync(ClaudeSettings)({
      binaryPath,
      homePath: NodePath.join(cwd, "config"),
    });
    return yield* check({ settings, cwd });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect.skipIf(windowsHost)(
  "a check that reuses a recent probe dates usage by when Claude reported it, not by the check",
  () =>
    withFakeClaude(({ settings, cwd }) =>
      Effect.gen(function* () {
        const usageReadAt = "2026-10-26T08:00:00.000Z";
        const provider = yield* checkClaudeProviderStatus(
          settings,
          () => Effect.succeed({ ...subscriptionProbe, usageReadAt }),
          { PATH: process.env.PATH },
          cwd,
        );
        assert.strictEqual(provider.auth.status, "authenticated");
        assert.deepStrictEqual(
          provider.usageLimits?.windows.map(({ id, usedPercent }) => [id, usedPercent]),
          [["five_hour", 40]],
        );
        assert.strictEqual(provider.usageLimits?.checkedAt, usageReadAt);
        assert.notStrictEqual(provider.checkedAt, usageReadAt);
      }),
    ),
);

it.effect.skipIf(windowsHost)(
  "a failed usage read keeps the last reading, dated by its own read and marked as not refreshed",
  () =>
    withFakeClaude(({ settings, cwd }) =>
      Effect.gen(function* () {
        const usageReadAt = "2026-10-26T08:00:00.000Z";
        const read = yield* checkClaudeProviderStatus(
          settings,
          () => Effect.succeed({ ...subscriptionProbe, usageReadAt }),
          { PATH: process.env.PATH },
          cwd,
        );
        const { usage: _usage, ...withoutUsage } = subscriptionProbe;
        const failed = yield* checkClaudeProviderStatus(
          settings,
          () => Effect.succeed(withoutUsage),
          { PATH: process.env.PATH },
          cwd,
        );
        assert.strictEqual(failed.usageLimits?.unavailable?.reason, "probeFailed");
        assert.deepStrictEqual(failed.usageLimits?.windows, []);

        const kept = resolveUsageLimitsAfterProbe({
          published: read.usageLimits,
          probed: failed.usageLimits,
        });
        assert.deepStrictEqual(kept?.windows, read.usageLimits?.windows);
        assert.strictEqual(kept?.checkedAt, usageReadAt);
        assert.strictEqual(kept?.unavailable?.reason, "probeFailed");
      }),
    ),
);

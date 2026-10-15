import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { make } from "./ClaudeNativeCatalog";
import { ClaudeSdk, type ClaudeSdkDiscoveryInput } from "../../platform/node/ClaudeSdk";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";

vi.mock("../../platform/node/ClaudeDiscovery", async (original) => ({
  ...(await original<typeof import("../../platform/node/ClaudeDiscovery")>()),
  discoverClaudeSkills: () => Effect.succeed([]),
  probeClaudeVersion: () => Effect.succeed("native-version"),
}));

it.effect(
  "discovery releases its metadata Query, caches by physical configuration and refreshes explicitly",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let token = "first";
        const acquired: ClaudeSdkDiscoveryInput[] = [];
        let released = 0;
        const instance = defaultClaudeInstance();
        const catalog = yield* make.pipe(
          Effect.provide(mainConfigLayer()),
          Effect.provideService(ApplicationSettings, {
            claudeLaunchConfiguration: () =>
              Effect.succeed({ instance, environment: { ANTHROPIC_AUTH_TOKEN: token } }),
          } as never),
          Effect.provideService(ClaudeSdk, {
            discover: (input: ClaudeSdkDiscoveryInput) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  acquired.push(input);
                  return {
                    models: [
                      {
                        value: `native-${acquired.length}`,
                        displayName: "Native",
                        description: "",
                      },
                    ],
                    commands: [],
                    intelligence: {
                      model: `native-${acquired.length}`,
                      effort: null,
                      fast: null,
                      thinking: null,
                    },
                    diagnostics: { health: { executable: "/native", error: null } },
                    send: () => Effect.die("Metadata discovery cannot submit a prompt"),
                  };
                }),
                () =>
                  Effect.sync(() => {
                    released += 1;
                  }),
              ),
            configuration: () => Effect.succeed({ skillOverrides: {} }),
          } as never),
        );
        const first = yield* catalog.discover(instance.id, { workspaceRoot: "/first" });
        assert.equal(first.intelligence.model, "native-1");
        assert.deepEqual(yield* catalog.discover(instance.id, { workspaceRoot: "/first" }), first);
        assert.equal(acquired.length, 1);
        assert.equal(released, 1);
        const refreshed = yield* catalog.discover(instance.id, { workspaceRoot: "/first" }, true);
        assert.equal(refreshed.intelligence.model, "native-2");
        token = "changed";
        assert.equal(
          (yield* catalog.discover(instance.id, { workspaceRoot: "/first" })).intelligence.model,
          "native-3",
        );
        assert.equal(
          (yield* catalog.discover(instance.id, { workspaceRoot: "/second" })).intelligence.model,
          "native-4",
        );
        assert.equal(released, 4);
      }),
    ),
);

it.effect("native catalog cursors cannot cross account or configured instance identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let home = "/original";
      const offsets: number[] = [];
      const catalog = yield* make.pipe(
        Effect.provide(mainConfigLayer()),
        Effect.provideService(ApplicationSettings, {
          claudeLaunchConfiguration: () =>
            Effect.succeed({ instance: defaultClaudeInstance(), environment: {} }),
        } as never),
        Effect.provideService(ClaudeSdk, {
          nativeHome: () => Effect.sync(() => home),
          listSessions: (_input: unknown, offset: number) =>
            Effect.sync(() => {
              offsets.push(offset);
              return Array.from({ length: 51 }, (_, index) => ({
                sessionId: String(index),
                lastModified: index,
                summary: "Saved",
                cwd: null,
              }));
            }),
        } as never),
      );
      const first = yield* catalog.nativeCatalog({ instanceConfigId: "first" });
      assert.equal(first.entries.length, 0);
      assert.isString(first.nextCursor);
      assert.equal(
        (yield* catalog.nativeCatalog({ instanceConfigId: "first", cursor: first.nextCursor! }))
          .nativeHome,
        "/original",
      );
      assert.deepEqual(offsets, [0, 50]);
      assert.equal(
        (yield* Effect.result(
          catalog.nativeCatalog({ instanceConfigId: "other", cursor: first.nextCursor! }),
        ))._tag,
        "Failure",
      );
      home = "/replacement";
      assert.equal(
        (yield* Effect.result(
          catalog.nativeCatalog({ instanceConfigId: "first", cursor: first.nextCursor! }),
        ))._tag,
        "Failure",
      );
      assert.deepEqual(offsets, [0, 50]);
    }),
  ),
);

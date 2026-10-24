import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import { ProviderInstanceId, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { makeAcpRegistryConnectionState } from "../../vendor/provider-acp-registry/src/server/connectionState.ts";

const settings = Schema.decodeSync(AcpRegistrySettings)({ agentId: "devin" });

describe("ACP connection state", () => {
  it.effect("restores explicit sign-in across driver recreation and server restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const input = {
        cacheDir,
        instanceId: ProviderInstanceId.make("acp_devin"),
        settings,
        environment: [],
        processEnvironment: { HOME: "/home/test" },
      };
      const first = yield* makeAcpRegistryConnectionState(input);
      assert.isFalse(yield* first.get);
      yield* first.set(true);
      const recreated = yield* makeAcpRegistryConnectionState({
        ...input,
        settings: { ...settings, customModels: ["new-model"] },
      });
      assert.isTrue(yield* recreated.get);
      // Both logout and an explicit authentication failure revoke confirmation.
      yield* recreated.set(false);
      const restarted = yield* makeAcpRegistryConnectionState(input);
      assert.isFalse(yield* restarted.get);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not carry confirmation to a different agent, method, executable, or credential environment",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheDir = yield* fs.makeTempDirectoryScoped();
        const input = {
          cacheDir,
          instanceId: ProviderInstanceId.make("acp_devin"),
          settings,
          environment: [{ name: "DEVIN_TOKEN", value: "test-only-token", sensitive: true }],
          processEnvironment: { HOME: "/home/test" },
        };
        for (const change of [
          { settings: { ...settings, agentId: "other-agent" } },
          { settings: { ...settings, authMethodId: "enterprise" } },
          { settings: { ...settings, commandPath: "/other/devin" } },
          { environment: [{ name: "DEVIN_TOKEN", value: "different-token", sensitive: true }] },
          { processEnvironment: { HOME: "/home/other" } },
        ]) {
          const signedIn = yield* makeAcpRegistryConnectionState(input);
          yield* signedIn.set(true);
          const changed = yield* makeAcpRegistryConnectionState({ ...input, ...change });
          assert.isFalse(yield* changed.get);
          const restoredConfig = yield* makeAcpRegistryConnectionState(input);
          assert.isFalse(yield* restoredConfig.get);
        }
        for (const name of yield* fs.readDirectory(cacheDir)) {
          const contents = yield* fs.readFileString(`${cacheDir}/${name}`);
          assert.isFalse(contents.includes("test-only-token"));
          assert.isFalse(contents.includes("different-token"));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores damaged confirmation and keeps another instance independent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const input = {
        cacheDir,
        instanceId: ProviderInstanceId.make("acp_devin"),
        settings,
        environment: [],
        processEnvironment: {},
      };
      const first = yield* makeAcpRegistryConnectionState(input);
      yield* first.set(true);
      const other = yield* makeAcpRegistryConnectionState({
        ...input,
        instanceId: ProviderInstanceId.make("acp_other"),
      });
      assert.isFalse(yield* other.get);
      for (const name of yield* fs.readDirectory(cacheDir)) {
        yield* fs.writeFileString(`${cacheDir}/${name}`, "invalid");
      }
      const restored = yield* makeAcpRegistryConnectionState(input);
      assert.isFalse(yield* restored.get);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "masks metadata without corrupting system timestamps or retaining authorization URLs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheDir = yield* fs.makeTempDirectoryScoped();
        const input = {
          cacheDir,
          instanceId: ProviderInstanceId.make("acp-2026"),
          settings,
          environment: [{ name: "TOKEN", value: "2026", sensitive: true }],
          processEnvironment: { TOKEN: "2026" },
        };
        const state = yield* makeAcpRegistryConnectionState(input);
        const snapshot: ServerProvider = {
          instanceId: input.instanceId,
          driver: ProviderDriverKind.make("acpRegistry"),
          installed: true,
          enabled: true,
          version: null,
          status: "ready",
          auth: {
            status: "unknown",
            action: {
              elicitationId: "login",
              url: "https://example.test/authorize?token=2026",
              message: "Sign in",
            },
          },
          checkedAt: "2026-10-24T00:00:00.000Z",
          discovery: {
            status: "ready",
            checkedAt: "2026-10-24T00:00:00.000Z",
            supportsModelSelection: true,
          },
          models: [{ slug: "model", name: "Model 2026", isCustom: false, capabilities: null }],
          slashCommands: [],
          skills: [],
        };
        yield* state.setDiscovery(snapshot);
        const saved = yield* state.getDiscovery;
        assert.equal(saved?.instanceId, input.instanceId);
        assert.equal(saved?.discovery?.checkedAt, snapshot.discovery?.checkedAt);
        assert.equal(saved?.models[0]?.name, "Model [redacted]");
        assert.isUndefined(saved?.auth.action);
        assert.equal(state.redactSnapshot(snapshot).auth.action?.url, snapshot.auth.action?.url);
        for (const name of yield* fs.readDirectory(cacheDir)) {
          assert.isFalse(
            (yield* fs.readFileString(`${cacheDir}/${name}`)).includes("authorize?token"),
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

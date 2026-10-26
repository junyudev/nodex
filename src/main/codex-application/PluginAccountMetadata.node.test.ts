import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makePluginAccountMetadata } from "./PluginAccountMetadata";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { PluginServiceAccount } from "./PluginService";
import type { ChatGptDesktopRequestInput } from "../codex/chatgpt-desktop-request";
const make = (body: unknown, status = 200) => {
  const calls: ChatGptDesktopRequestInput[] = [];
  const desktop = {
    request: (input: ChatGptDesktopRequestInput) => {
      calls.push(input);
      return Effect.succeed(Response.json(body, { status }));
    },
  } as unknown as ChatGptDesktop["Service"];
  return {
    calls,
    owner: makePluginAccountMetadata.pipe(Effect.provideService(ChatGptDesktop, desktop)),
  };
};
it.effect(
  "keeps disclosed provider categories and availability distinct from native plugin state",
  () =>
    Effect.gen(function* () {
      const h = make({
        dependencies: [
          {
            plugin_id: "provider",
            display_name: "Provider",
            categories: [{ id: "storage", label: "Storage" }],
            is_enabled: false,
            is_installed: true,
            icon_url: "https://example.test/logo.png",
            icon_url_dark: "file:///private/icon",
            availability_status: { reason: "workspace_setup_required" },
            navigation: { kind: "plugin_detail", plugin_id: "provider" },
          },
        ],
      });
      const metadata = yield* h.owner;
      const dependencies = yield* metadata.dependencies("plugin/id");
      assert.deepEqual(dependencies, [
        {
          pluginId: "provider",
          displayName: "Provider",
          categories: [{ id: "storage", label: "Storage" }],
          enabled: false,
          installed: true,
          logoUrl: "https://example.test/logo.png",
          logoDarkUrl: null,
          unavailableReason: "workspace_setup_required",
          navigationPluginId: "provider",
        },
      ]);
      assert.strictEqual(h.calls[0]?.path, "ps/plugins/plugin%2Fid");
      assert.deepEqual(h.calls[0]?.expectedAccount, { accountId: "a", userId: "u" });
    }).pipe(Effect.provideService(PluginServiceAccount, { accountId: "a", userId: "u" })),
);
it.effect(
  "resolves the canonical creator plugin and preserves missing or denied capabilities",
  () =>
    Effect.gen(function* () {
      const canonical = make({ plugin_id: "canonical-creator", status: "AVAILABLE" });
      assert.strictEqual(yield* (yield* canonical.owner).creatorPluginId, "canonical-creator");
      const absent = make({});
      assert.strictEqual(yield* (yield* absent.owner).dependencies("plugin"), null);
      const denied = make({}, 403);
      assert.strictEqual(
        (yield* (yield* denied.owner).creatorPluginId.pipe(Effect.flip)).code,
        "policy_denied",
      );
      const signedOut = make({});
      assert.strictEqual(
        (yield* (yield* signedOut.owner).creatorPluginId.pipe(
          Effect.provideService(PluginServiceAccount, null),
          Effect.flip,
        )).code,
        "auth_required",
      );
      assert.strictEqual(signedOut.calls.length, 0);
    }).pipe(Effect.provideService(PluginServiceAccount, { accountId: "a", userId: "u" })),
);

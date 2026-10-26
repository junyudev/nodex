import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makePluginApps } from "./PluginApps";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { PluginServiceAccount } from "./PluginService";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import type { ChatGptDesktopRequestInput } from "../codex/chatgpt-desktop-request";

const context = {
  hostId: "local",
  projectId: null,
  hostGeneration: 7,
  accountEpoch: 2,
  bindingRevision: null,
  cwds: [],
} as const;
const metadata = (id: string) => ({
  id,
  name: `App ${id}`,
  description: null,
  iconUrl: null,
  iconUrlDark: null,
  distributionChannel: null,
  installUrl: null,
  pluginDisplayNames: [],
  toolSummaries: null,
});
const make = (
  options: {
    ids?: string[];
    unsupported?: boolean;
    fail?: boolean;
    links?: unknown[];
    connectors?: unknown[];
  } = {},
) => {
  const calls: { method: string; params: Record<string, unknown>; scheduling: unknown }[] = [];
  const http: ChatGptDesktopRequestInput[] = [];
  const ids = options.ids ?? ["connector_sample"];
  const gateway = {
    requestOnHost: (
      _host: string,
      method: string,
      params: Record<string, unknown>,
      scheduling: unknown,
    ) => {
      calls.push({ method, params, scheduling });
      if (options.fail || (options.unsupported && method === "app/installed"))
        return Effect.fail(
          codexRuntimeError({
            operation: "apps",
            reason: "request",
            retryable: false,
            cause: options.fail
              ? null
              : new CodexAppServerRequestError({
                  method,
                  operation: "receive-response",
                  code: -32601,
                  errorMessage: "Method not found",
                }),
          }),
        );
      if (method === "app/installed")
        return Effect.succeed({
          apps: ids.map((id) => ({ id, runtimeName: null, enabled: true, callable: false })),
        });
      if (method === "app/read")
        return Effect.succeed({
          apps: (params.appIds as string[]).filter((id) => id !== "missing").map(metadata),
          missingAppIds: (params.appIds as string[]).filter((id) => id === "missing"),
        });
      if (method === "app/list")
        return Effect.succeed({
          data: [
            {
              id: "legacy",
              name: "Legacy",
              description: null,
              logoUrl: null,
              logoUrlDark: null,
              distributionChannel: null,
              installUrl: null,
              pluginDisplayNames: [],
              isAccessible: true,
              isEnabled: false,
            },
          ],
          nextCursor: null,
        });
      return Effect.die(`Unexpected ${method}`);
    },
  } as unknown as CodexGateway["Service"];
  const desktop = {
    request: (input: ChatGptDesktopRequestInput) => {
      http.push(input);
      return Effect.succeed(
        new Response(
          JSON.stringify(
            input.path.includes("list_accessible")
              ? { links: options.links ?? [] }
              : input.path.includes("/batch")
                ? {
                    connectors:
                      options.connectors ??
                      ids.map((id) => ({ id, name: `HTTP ${id}`, status: "AVAILABLE" })),
                  }
                : {},
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    },
  } as unknown as ChatGptDesktop["Service"];
  return {
    calls,
    http,
    owner: makePluginApps.pipe(
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(ChatGptDesktop, desktop),
    ),
  };
};
it.effect("batches metadata by 100 while preserving runtime state and explicit missing IDs", () =>
  Effect.gen(function* () {
    const h = make({ ids: Array.from({ length: 203 }, (_, i) => `app_${i}`) });
    const apps = yield* h.owner;
    const view = yield* apps.list(context, { ...context, appIds: ["missing"], forceRefresh: true });
    assert.deepEqual(
      h.calls
        .filter((call) => call.method === "app/read")
        .map((call) => (call.params.appIds as string[]).length),
      [100, 100, 4],
    );
    assert.deepEqual(view.missingAppIds, ["missing"]);
    assert.strictEqual(view.apps[0]?.enabled, true);
    assert.strictEqual(view.apps[0]?.callable, false);
    assert.strictEqual(view.apps[0]?.connectionState, "unknown");
    assert.deepEqual(h.calls[0]?.scheduling, { expectedHostId: "local", expectedGeneration: 7 });
    assert.strictEqual(h.http.length, 0);
  }),
);
it.effect("uses the legacy lifecycle only for an unsupported method", () =>
  Effect.gen(function* () {
    const h = make({ unsupported: true });
    const view = yield* (yield* h.owner).list(context, context);
    assert.strictEqual(view.apps[0]?.id, "legacy");
    assert.strictEqual(view.apps[0]?.callable, false);
    assert.strictEqual(view.apps[0]?.enabled, false);
    assert.strictEqual(view.apps[0]?.accessible, true);
    const failure = make({ fail: true });
    const error = yield* (yield* failure.owner).list(context, context).pipe(Effect.flip);
    assert.strictEqual(error.code, "service_unavailable");
    assert.strictEqual(
      failure.calls.some((call) => call.method === "app/list"),
      false,
    );
  }),
);
it.effect(
  "prefers a usable connection over a disabled account and scopes disconnection to a verified app",
  () =>
    Effect.gen(function* () {
      const h = make({
        links: [
          {
            id: "blocked",
            connector_id: "connector_sample",
            auth_status: "ACTIVE",
            connector_status: "DISABLED_BY_ADMIN",
          },
          {
            id: "good",
            connector_id: "connector_sample",
            name: "Work",
            auth_status: "ACTIVE",
            connector_status: "AVAILABLE",
          },
        ],
      });
      const apps = yield* h.owner;
      const view = yield* apps.list(context, context);
      assert.strictEqual(view.apps[0]?.connectionState, "connected");
      assert.deepEqual(view.apps[0]?.connections, [{ id: "good", name: "Work" }]);
      const invalid = yield* apps
        .disconnect(context, { appId: "connector_sample", linkId: "someone-else" })
        .pipe(Effect.flip);
      assert.strictEqual(invalid.code, "not_found");
      assert.strictEqual(
        h.http.some((call) => call.method === "DELETE"),
        false,
      );
      yield* apps.disconnect(context, { appId: "connector_sample", linkId: "good" });
      const deletion = h.http.find((call) => call.method === "DELETE");
      assert.strictEqual(deletion?.path, "aip/connectors/links/good");
      assert.deepEqual(deletion?.expectedAccount, { accountId: "account", userId: "user" });
      assert.strictEqual(deletion?.refreshOn401, false);
    }).pipe(Effect.provideService(PluginServiceAccount, { accountId: "account", userId: "user" })),
);
it.effect(
  "does not treat implicit or hidden links as connected and preserves administrator blocking",
  () =>
    Effect.gen(function* () {
      const h = make({
        ids: ["connector_sample", "blocked"],
        links: [
          { id: "implicit_link::x", connector_id: "connector_sample", auth_status: "ACTIVE" },
          {
            id: "hidden",
            connector_id: "connector_sample",
            auth_status: "ACTIVE",
            visibility: "HIDDEN",
          },
          {
            id: "disabled",
            connector_id: "blocked",
            auth_status: "ACTIVE",
            connector_status: "DISABLED_BY_ADMIN",
          },
        ],
      });
      const view = yield* (yield* h.owner).list(context, context);
      assert.strictEqual(view.apps[0]?.connectionState, "authentication_required");
      assert.strictEqual(view.apps[1]?.connectionState, "admin_disabled");
      assert.strictEqual(view.connect.supported, false);
    }).pipe(Effect.provideService(PluginServiceAccount, { accountId: "account", userId: "user" })),
);

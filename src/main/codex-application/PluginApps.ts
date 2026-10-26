import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AppInfo } from "@nodex/codex-app-server-protocol/v2/AppInfo";
import type { ConnectorMetadata } from "@nodex/codex-app-server-protocol/v2/ConnectorMetadata";
import type { InstalledApp } from "@nodex/codex-app-server-protocol/v2/InstalledApp";
import type { PluginAppRow, PluginAppsView } from "../../shared/codex-plugin-settings";
import type { PluginQueries, ResolvedPluginContext } from "../../shared/codex-plugin-management";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { PluginServiceAccount } from "./PluginService";
import { pluginError, pluginFailure } from "./PluginManagementError";
import { pluginNativeFailure } from "./PluginNativeErrors";
import { normalizeConnectorId } from "./PluginSettingsModel";

const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const Link = Schema.Struct({
  id: Schema.String,
  connector_id: Schema.String,
  name: optionalText,
  auth_status: optionalText,
  connector_status: optionalText,
  unavailable_reason: optionalText,
  visibility: optionalText,
});
const Links = Schema.Struct({ links: Schema.Array(Link) });
const Connector = Schema.Struct({
  id: Schema.String,
  name: optionalText,
  status: optionalText,
  logo_url: optionalText,
  logo_url_dark: optionalText,
  icon_url: optionalText,
  icon_url_dark: optionalText,
  icon_dark_url: optionalText,
});
const Connectors = Schema.Struct({ connectors: Schema.Array(Connector) });
export const pluginConnectUnavailableReason =
  "Connector OAuth requires a backend-approved Nodex callback URL and a correlated native callback receiver. Only the Codex callback contract is verified.";
const active = (link: typeof Link.Type) =>
  link.auth_status === "ACTIVE" &&
  link.visibility !== "HIDDEN" &&
  !link.id.startsWith("implicit_link::") &&
  link.connector_status !== "DISABLED_BY_ADMIN" &&
  link.unavailable_reason == null;

export const makePluginApps = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const desktop = yield* ChatGptDesktop;
  const http = Effect.fn("PluginApps.http")(function* (
    path: string,
    method: "POST" | "DELETE",
    body: Record<string, unknown>,
  ) {
    const expected = yield* PluginServiceAccount;
    if (!expected)
      return yield* pluginError("auth_required", "Sign in to ChatGPT to manage app connections.");
    const response = yield* desktop
      .request({
        baseUrl: "https://chatgpt.com/backend-api",
        path,
        method,
        action: "manage app connections",
        expectedAccount: expected,
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        refreshOn401: method === "POST",
      })
      .pipe(
        Effect.mapError(() =>
          pluginError("service_unavailable", "App connections are unavailable.", true),
        ),
      );
    if (response.status === 401)
      return yield* pluginError("auth_required", "Sign in to ChatGPT to manage app connections.");
    if (response.status === 403)
      return yield* pluginError("policy_denied", "App connections are disabled for this account.");
    if (response.status === 404)
      return yield* pluginError("unsupported", "App connections are unavailable for this account.");
    if (!response.ok)
      return yield* pluginError(
        "service_unavailable",
        "App connections are unavailable.",
        response.status === 429 || response.status >= 500,
      );
    return response;
  });
  const decode = <A>(path: string, body: Record<string, unknown>, schema: Schema.Decoder<A>) =>
    http(path, "POST", body).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () => pluginError("service_unavailable", "Invalid app connection response."),
        }),
      ),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(() =>
            pluginError("service_unavailable", "Invalid app connection response."),
          ),
        ),
      ),
    );
  const legacy = Effect.fn("PluginApps.legacy")(function* (
    context: ResolvedPluginContext,
    forceRefresh: boolean,
  ) {
    const apps: AppInfo[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: import("@nodex/codex-app-server-protocol/v2/AppsListResponse").AppsListResponse =
        (yield* gateway
          .requestOnHost(
            context.hostId,
            "app/list",
            { cursor, limit: 1000, forceRefetch: forceRefresh },
            { expectedHostId: context.hostId, expectedGeneration: context.hostGeneration },
          )
          .pipe(
            Effect.mapError(pluginNativeFailure),
          )) as unknown as import("@nodex/codex-app-server-protocol/v2/AppsListResponse").AppsListResponse;
      apps.push(...page.data);
      cursor = page.nextCursor;
      if (cursor !== null && seen.has(cursor))
        return yield* pluginError(
          "inventory_unavailable",
          "App inventory pagination did not advance.",
        );
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    return apps;
  });
  const native = Effect.fn("PluginApps.native")(function* (
    context: ResolvedPluginContext,
    input: PluginQueries["apps"]["input"],
  ) {
    const options = { expectedHostId: context.hostId, expectedGeneration: context.hostGeneration };
    const runtime = yield* gateway
      .requestOnHost(
        context.hostId,
        "app/installed",
        { forceRefresh: input.forceRefresh ?? false },
        options,
      )
      .pipe(Effect.mapError(pluginNativeFailure));
    const ids = [...new Set([...runtime.apps.map((app) => app.id), ...(input.appIds ?? [])])];
    const metadata: ConnectorMetadata[] = [];
    const missing: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const response = yield* gateway
        .requestOnHost(
          context.hostId,
          "app/read",
          { appIds: ids.slice(offset, offset + 100), includeTools: true },
          options,
        )
        .pipe(Effect.mapError(pluginNativeFailure));
      metadata.push(...(response.apps as unknown as ConnectorMetadata[]));
      missing.push(...response.missingAppIds);
    }
    return { runtime: runtime.apps as unknown as InstalledApp[], metadata, missing };
  });
  const list = Effect.fn("PluginApps.list")(function* (
    context: ResolvedPluginContext,
    input: PluginQueries["apps"]["input"],
  ): Effect.fn.Return<PluginAppsView, import("./PluginManagementError").PluginManagementError> {
    const result = yield* native(context, input).pipe(
      Effect.catchIf(
        (error) => error.code === "unsupported",
        () =>
          legacy(context, input.forceRefresh ?? false).pipe(
            Effect.map((apps) => ({
              runtime: apps.map((app): InstalledApp => ({
                id: app.id,
                runtimeName: app.name,
                enabled: app.isEnabled,
                callable: app.isEnabled && app.isAccessible,
              })),
              metadata: apps.map((app): ConnectorMetadata => ({
                id: app.id,
                name: app.name,
                description: app.description,
                iconUrl: app.logoUrl,
                iconUrlDark: app.logoUrlDark,
                distributionChannel: app.distributionChannel,
                installUrl: app.installUrl,
                pluginDisplayNames: app.pluginDisplayNames,
                toolSummaries: null,
              })),
              missing: (input.appIds ?? []).filter((id) => !apps.some((app) => app.id === id)),
            })),
          ),
      ),
    );
    const ids = [
      ...new Set([
        ...result.runtime.map((app) => app.id),
        ...result.metadata.map((app) => app.id),
        ...(input.appIds ?? []),
      ]),
    ];
    const expected = yield* PluginServiceAccount;
    const connection =
      expected && ids.length
        ? yield* Effect.gen(function* () {
            const links = (yield* decode(
              "aip/connectors/links/list_accessible",
              { principals: [], link_refresh_strategy: input.forceRefresh ? "BLOCKING" : "NONE" },
              Links,
            )).links;
            const connectors: (typeof Connector.Type)[] = [];
            for (let offset = 0; offset < ids.length; offset += 100)
              connectors.push(
                ...(yield* decode(
                  "aip/connectors/batch?apply_eligibility_filter=true",
                  { connector_ids: ids.slice(offset, offset + 100), include_actions: false },
                  Connectors,
                )).connectors,
              );
            return { links, connectors, error: null };
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed({ links: [], connectors: [], error: pluginFailure(error) }),
            ),
          )
        : { links: [], connectors: [], error: null };
    const apps = ids.map((id): PluginAppRow => {
      const metadata =
        result.metadata.find((app) => normalizeConnectorId(app.id) === normalizeConnectorId(id)) ??
        null;
      const runtime =
        result.runtime.find((app) => normalizeConnectorId(app.id) === normalizeConnectorId(id)) ??
        null;
      const links = connection.links.filter(
        (link) => normalizeConnectorId(link.connector_id) === normalizeConnectorId(id),
      );
      const connector = connection.connectors.find(
        (app) => normalizeConnectorId(app.id) === normalizeConnectorId(id),
      );
      const availableLink = links.find(active);
      const adminDisabled =
        !availableLink &&
        (links.length
          ? links.every((link) => link.connector_status === "DISABLED_BY_ADMIN")
          : connector?.status === "DISABLED_BY_ADMIN");
      const unavailable =
        !availableLink &&
        ((links.length > 0 && links.every((link) => link.unavailable_reason != null)) ||
          (!links.length && expected !== null && connection.error === null && connector == null));
      const connectionState = adminDisabled
        ? "admin_disabled"
        : unavailable
          ? "unavailable"
          : availableLink || runtime?.callable
            ? "connected"
            : expected !== null && connection.error === null
              ? "authentication_required"
              : "unknown";
      return {
        id,
        name: metadata?.name ?? connector?.name ?? runtime?.runtimeName ?? id,
        metadata,
        runtime,
        enabled: runtime?.enabled ?? false,
        callable: runtime?.callable ?? false,
        logoUrl: metadata?.iconUrl ?? connector?.logo_url ?? connector?.icon_url ?? null,
        logoDarkUrl:
          metadata?.iconUrlDark ??
          connector?.logo_url_dark ??
          connector?.icon_dark_url ??
          connector?.icon_url_dark ??
          null,
        connectionState,
        connections: links.filter(active).map((link) => ({ id: link.id, name: link.name ?? null })),
        canDisconnect: expected !== null && links.some(active),
      };
    });
    return {
      apps,
      missingAppIds: result.missing,
      connectionError: connection.error,
      connect: { supported: false, reason: pluginConnectUnavailableReason },
    };
  });
  const disconnect = Effect.fn("PluginApps.disconnect")(function* (
    context: ResolvedPluginContext,
    input: { readonly appId: string; readonly linkId?: string },
    beforeWrite: Effect.Effect<
      void,
      import("./PluginManagementError").PluginManagementError
    > = Effect.void,
  ) {
    const view = yield* list(context, { ...context, appIds: [input.appId], forceRefresh: true });
    if (view.connectionError)
      return yield* pluginError(
        view.connectionError.code,
        view.connectionError.message,
        view.connectionError.retryable,
      );
    const app = view.apps.find(
      (app) => normalizeConnectorId(app.id) === normalizeConnectorId(input.appId),
    );
    if (!app?.canDisconnect)
      return yield* pluginError("not_found", "No connected account was found for this app.");
    if (input.linkId && !app.connections.some((link) => link.id === input.linkId))
      return yield* pluginError("not_found", "This account does not belong to the selected app.");
    yield* beforeWrite;
    yield* http(
      input.linkId
        ? `aip/connectors/links/${encodeURIComponent(input.linkId)}`
        : "aip/connectors/links",
      "DELETE",
      input.linkId ? {} : { connector_id: input.appId },
    );
  });
  return { list, disconnect };
});

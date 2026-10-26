import { safePluginCatalogIcon } from "./PluginSettingsModel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { PluginServiceAccount, pluginAccountProductHeaders } from "./PluginService";
import { pluginError, type PluginManagementError } from "./PluginManagementError";
import { ChatGptBackendAuthError } from "../codex/chatgpt-backend-auth";

const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const Dependency = Schema.Struct({
  plugin_id: Schema.String,
  display_name: Schema.String,
  categories: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  icon_url: optionalText,
  icon_url_dark: optionalText,
  is_enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  is_installed: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  availability_status: Schema.optionalKey(Schema.NullOr(Schema.Struct({ reason: Schema.String }))),
  navigation: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ kind: Schema.String, plugin_id: Schema.String })),
  ),
});
const Detail = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.NullOr(Schema.Array(Dependency))),
});
const CanonicalApp = Schema.Struct({ plugin_id: optionalText, status: optionalText });

export const makePluginAccountMetadata = Effect.gen(function* () {
  const desktop = yield* ChatGptDesktop;
  const read = <A>(
    path: string,
    schema: Schema.Decoder<A>,
  ): Effect.Effect<A, PluginManagementError> =>
    Effect.gen(function* () {
      const expected = yield* PluginServiceAccount;
      if (!expected)
        return yield* pluginError(
          "auth_required",
          "Sign in to ChatGPT to load this plugin information.",
        );
      const response = yield* desktop
        .request({
          baseUrl: "https://chatgpt.com/backend-api",
          path,
          method: "GET",
          action: "load plugin information",
          headers: pluginAccountProductHeaders,
          expectedAccount: expected,
        })
        .pipe(
          Effect.mapError((error) =>
            Schema.is(ChatGptBackendAuthError)(error)
              ? pluginError("account_changed", "The authenticated account changed.")
              : pluginError("service_unavailable", "Plugin information is unavailable.", true),
          ),
        );
      if (response.status === 401)
        return yield* pluginError(
          "auth_required",
          "Sign in to ChatGPT to load this plugin information.",
        );
      if (response.status === 403)
        return yield* pluginError(
          "policy_denied",
          "This plugin information is unavailable for your account.",
        );
      if (response.status === 404)
        return yield* pluginError("unsupported", "This plugin information is unavailable.");
      if (!response.ok)
        return yield* pluginError(
          "service_unavailable",
          "Plugin information could not be loaded.",
          response.status === 429 || response.status >= 500,
        );
      const json = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () => pluginError("service_unavailable", "Invalid plugin information response."),
      });
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() =>
          pluginError("service_unavailable", "Invalid plugin information response."),
        ),
      );
    });
  return {
    creatorPluginId: read(
      "aip/connectors/connector_openai_plugin_creator?include_actions=false",
      CanonicalApp,
    ).pipe(
      Effect.flatMap((app) =>
        app.status === "DISABLED_BY_ADMIN"
          ? Effect.fail(
              pluginError("policy_denied", "Plugin Creator is disabled by your administrator."),
            )
          : app.plugin_id
            ? Effect.succeed(app.plugin_id)
            : Effect.fail(
                pluginError("not_found", "Plugin Creator is unavailable in this catalog."),
              ),
      ),
    ),
    dependencies: (id: string) =>
      read(`ps/plugins/${encodeURIComponent(id)}`, Detail).pipe(
        Effect.map(
          (detail) =>
            detail.dependencies?.map((dependency) => ({
              pluginId: dependency.plugin_id,
              displayName: dependency.display_name,
              categories: dependency.categories,
              logoUrl: safePluginCatalogIcon(dependency.icon_url),
              logoDarkUrl: safePluginCatalogIcon(dependency.icon_url_dark),
              enabled: dependency.is_enabled ?? null,
              installed: dependency.is_installed ?? null,
              unavailableReason: dependency.availability_status?.reason ?? null,
              navigationPluginId:
                dependency.navigation?.kind === "plugin_detail" &&
                dependency.navigation.plugin_id === dependency.plugin_id
                  ? dependency.plugin_id
                  : null,
            })) ?? null,
        ),
      ),
  };
});

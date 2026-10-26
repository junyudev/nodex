import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ChatGptBackendAuthError } from "../codex/chatgpt-backend-auth";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { decodeChatGptBackendIdentity } from "../codex/chatgpt-backend-auth";
import { pluginError, PluginManagementError } from "./PluginManagementError";

const text = Schema.optionalKey(Schema.NullOr(Schema.String));
const policy = Schema.optionalKey(
  Schema.NullOr(Schema.Literals(["AVAILABLE", "NOT_AVAILABLE", "INSTALLED_BY_DEFAULT"])),
);
const ListingInterface = Schema.Struct({
  short_description: text,
  long_description: text,
  category: text,
  developer_name: text,
  logo_url: text,
  logo_url_dark: text,
  composer_icon_url: text,
  brand_color: text,
  website_url: text,
  privacy_policy_url: text,
  terms_of_service_url: text,
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
  default_prompts: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  default_prompt: text,
});
export const PluginServiceListing = Schema.Struct({
  id: Schema.NonEmptyString,
  name: text,
  display_name: text,
  short_description: text,
  icon_url: text,
  icon_url_dark: text,
  status: Schema.optionalKey(Schema.String),
  installation_policy: policy,
  installation_policy_source: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["WORKSPACE_SETTING", "IMPLICIT_CANONICAL_APP"])),
  ),
  must_show_installation_interstitial: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  authentication_policy: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["ON_INSTALL", "ON_USE"])),
  ),
  eligible_plan_types: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  disabled_reason: Schema.optionalKey(
    Schema.NullOr(
      Schema.Literals([
        "disabled_by_admin",
        "plan_not_eligible",
        "required_app_unavailable",
        "unknown",
      ]),
    ),
  ),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  release: Schema.optionalKey(
    Schema.Struct({
      display_name: Schema.String,
      version: text,
      description: text,
      interface: ListingInterface,
    }),
  ),
});
export type ServiceListing = typeof PluginServiceListing.Type;
const Page = Schema.Struct({
  plugins: Schema.Array(PluginServiceListing),
  pagination: Schema.Struct({ next_page_token: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
});
const CategoryPage = Schema.Struct({
  ...Page.fields,
  category: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      title: Schema.optionalKey(Schema.String),
      description: text,
    }),
  ),
});
const Home = Schema.Struct({
  sections: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      url_slug: Schema.optionalKey(Schema.NullOr(Schema.String)),
      plugins: Schema.Array(PluginServiceListing),
    }),
  ),
});
export interface PluginServiceAccess {
  readonly publicHome: boolean;
  readonly category: boolean;
  readonly personal: boolean;
  readonly shared: boolean;
  readonly remoteToggle: boolean;
  readonly workspace: boolean;
  readonly workspaceCreated: boolean;
}
export class PluginService extends Context.Service<
  PluginService,
  {
    readonly access: Effect.Effect<PluginServiceAccess, PluginManagementError>;
    readonly home: Effect.Effect<typeof Home.Type, PluginManagementError>;
    readonly category: (input: {
      slug: string;
      search?: string;
      cursor?: string | null;
    }) => Effect.Effect<typeof CategoryPage.Type, PluginManagementError>;
    readonly page: (input: {
      feed: "user" | "workspace-created" | "shared";
      limit: 9 | 50;
      cursor?: string | null;
    }) => Effect.Effect<typeof Page.Type, PluginManagementError>;
    readonly setEnabled: (
      id: string,
      enabled: boolean,
    ) => Effect.Effect<void, PluginManagementError>;
  }
>()("nodex/main/codex-application/PluginService") {}

/** Native Customize requests use the Codex product's catalog and connector policies. */
export const pluginAccountProductHeaders = { "OAI-Product-Sku": "CODEX" } as const;
/** Frozen by the semantic owner so an account switch cannot retarget a remote operation. */
export const PluginServiceAccount = Context.Reference<{
  readonly accountId: string;
  readonly userId: string;
} | null>("nodex/main/codex-application/PluginServiceAccount", { defaultValue: () => null });
export const live = Layer.effect(
  PluginService,
  Effect.gen(function* () {
    const desktop = yield* ChatGptDesktop;
    const gateway = yield* CodexGateway;
    const cachedAccess = yield* Ref.make<{
      key: string;
      at: number;
      value: PluginServiceAccess;
    } | null>(null);
    const request = Effect.fn("PluginService.request")(function* (path: string, method = "GET") {
      const status = yield* desktop
        .authStatus(true, false)
        .pipe(
          Effect.mapError(() =>
            pluginError("auth_required", "Sign in to ChatGPT to browse plugins."),
          ),
        );
      if (status.authMethod !== "chatgpt")
        return yield* pluginError("auth_required", "Sign in to ChatGPT to browse plugins.");
      const identity = status.authToken ? decodeChatGptBackendIdentity(status.authToken) : null;
      if (!identity)
        return yield* pluginError("auth_required", "ChatGPT authentication is unavailable.");
      const expected = yield* PluginServiceAccount;
      if (
        expected &&
        (expected.accountId !== identity.accountId || expected.userId !== identity.userId)
      )
        return yield* pluginError("account_changed", "The authenticated account changed.");
      const response = yield* desktop
        .request({
          baseUrl: "https://chatgpt.com/backend-api",
          path,
          method,
          action: "manage plugins",
          headers: pluginAccountProductHeaders,
          expectedAccount: identity,
        })
        .pipe(
          Effect.mapError((error) =>
            Schema.is(ChatGptBackendAuthError)(error)
              ? pluginError("account_changed", "The authenticated account changed.")
              : pluginError("service_unavailable", "The plugin service is unavailable.", true),
          ),
        );
      if (response.ok) return { response, identity };
      if (response.status === 401)
        return yield* pluginError("auth_required", "Sign in to ChatGPT to continue.");
      if (response.status === 403) {
        const capability: keyof PluginServiceAccess =
          method === "POST"
            ? "remoteToggle"
            : path.startsWith("ps/plugin-categories/")
              ? "category"
              : path.startsWith("ps/plugins/home")
                ? "publicHome"
                : path.startsWith("ps/plugins/workspace/shared")
                  ? "shared"
                  : path.startsWith("ps/plugins/workspace/created")
                    ? "workspaceCreated"
                    : "personal";
        yield* Ref.update(cachedAccess, (current) =>
          current?.key === `${identity.accountId}:${identity.userId}`
            ? { ...current, value: { ...current.value, [capability]: false } }
            : current,
        );
        return yield* pluginError("policy_denied", "Plugin access is denied for this account.");
      }
      if (response.status === 404)
        return yield* pluginError("unsupported", "This plugin service is unavailable.");
      return yield* pluginError(
        "service_unavailable",
        "Unable to load plugins.",
        response.status === 429 || response.status >= 500,
      );
    });
    const ensureIdentity = Effect.fn("PluginService.ensureIdentity")(function* (expected: {
      accountId: string;
      userId: string;
    }) {
      const status = yield* desktop
        .authStatus(true, false)
        .pipe(
          Effect.mapError(() =>
            pluginError("account_changed", "The authenticated account changed."),
          ),
        );
      const current = status.authToken ? decodeChatGptBackendIdentity(status.authToken) : null;
      if (
        status.authMethod !== "chatgpt" ||
        current?.accountId !== expected.accountId ||
        current.userId !== expected.userId
      )
        return yield* pluginError("account_changed", "The authenticated account changed.");
    });
    const decode = <A>(
      path: string,
      schema: Schema.Decoder<A>,
    ): Effect.Effect<A, PluginManagementError> =>
      Effect.gen(function* () {
        const { response, identity } = yield* request(path);
        const json = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () => pluginError("service_unavailable", "Invalid plugin service response."),
        });
        const value = yield* Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError(() =>
            pluginError("service_unavailable", "Invalid plugin service response."),
          ),
        );
        yield* ensureIdentity(identity);
        return value;
      });
    const home = decode("ps/plugins/home", Home);
    const probe = (path: string) =>
      request(path).pipe(
        Effect.flatMap(({ response, identity }) =>
          Effect.tryPromise({
            try: () => response.body?.cancel() ?? Promise.resolve(),
            catch: () => pluginError("service_unavailable", "Unable to check plugin access."),
          }).pipe(Effect.andThen(ensureIdentity(identity))),
        ),
        Effect.as(true),
        Effect.catchIf(
          (error) => error.code === "policy_denied" || error.code === "unsupported",
          () => Effect.succeed(false),
        ),
      );
    return PluginService.of({
      access: Effect.gen(function* () {
        const auth = yield* desktop
          .authStatus(true, false)
          .pipe(
            Effect.mapError(() => pluginError("auth_required", "Authentication is unavailable.")),
          );
        if (auth.authMethod !== "chatgpt") {
          yield* Ref.set(cachedAccess, null);
          return {
            publicHome: false,
            category: false,
            personal: false,
            shared: false,
            remoteToggle: false,
            workspace: false,
            workspaceCreated: false,
          };
        }
        const identity = auth.authToken ? decodeChatGptBackendIdentity(auth.authToken) : null;
        if (!identity)
          return yield* pluginError("auth_required", "ChatGPT authentication is unavailable.");
        const expected = yield* PluginServiceAccount;
        if (
          expected &&
          (expected.accountId !== identity.accountId || expected.userId !== identity.userId)
        )
          return yield* pluginError("account_changed", "The authenticated account changed.");
        const key = `${identity.accountId}:${identity.userId}`;
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const cached = yield* Ref.get(cachedAccess);
        if (cached?.key === key && now - cached.at < 60_000) return cached.value;
        const account = yield* gateway
          .requestLocal("account/read", { refreshToken: false })
          .pipe(
            Effect.mapError(() => pluginError("auth_required", "Authentication is unavailable.")),
          );
        const plan = account.account?.type === "chatgpt" ? account.account.planType : null;
        const workspace =
          plan !== null &&
          /^(?:team|business|self_serve_business|ent26|enterprise|edu)/u.test(plan);
        const [publicHome, personal, shared, workspaceCreated] = yield* Effect.all([
          probe("ps/plugins/home"),
          probe("ps/plugins/list?scope=USER&limit=9"),
          workspace ? probe("ps/plugins/workspace/shared?limit=9") : Effect.succeed(false),
          workspace ? probe("ps/plugins/workspace/created?limit=9") : Effect.succeed(false),
        ]);
        const value = {
          publicHome,
          category: publicHome,
          personal,
          shared,
          remoteToggle: publicHome || personal,
          workspace,
          workspaceCreated,
        };
        yield* ensureIdentity(identity);
        yield* Ref.set(cachedAccess, { key, at: now, value });
        return value;
      }),
      home,
      category: (input) => {
        const query = new URLSearchParams({ scope: "GLOBAL", limit: "50" });
        if (input.search?.trim()) query.set("q", input.search.trim());
        if (input.cursor != null) query.set("pageToken", input.cursor);
        return decode(
          `ps/plugin-categories/${encodeURIComponent(input.slug)}/plugins?${query}`,
          CategoryPage,
        );
      },
      page: (input) => {
        const query = new URLSearchParams({ limit: String(input.limit) });
        if (input.feed === "user") query.set("scope", "USER");
        if (input.cursor != null) query.set("pageToken", input.cursor);
        const path =
          input.feed === "user"
            ? "ps/plugins/list"
            : input.feed === "shared"
              ? "ps/plugins/workspace/shared"
              : "ps/plugins/workspace/created";
        return decode(`${path}?${query}`, Page);
      },
      setEnabled: (id, enabled) =>
        request(
          `ps/plugins/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
          "POST",
        ).pipe(Effect.flatMap(({ identity }) => ensureIdentity(identity))),
    });
  }),
);

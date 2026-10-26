import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import { matchPluginDetailSkill, projectPluginMcpServers } from "./PluginDetailModel";
import { authorizedPluginAsset } from "./PluginInventoryPolicy";
import { isAbsoluteAppFilesystemPath } from "../../shared/app-protocol";
import { pluginAppPolicy } from "./PluginAppPolicy";
import { makePluginAccountMetadata } from "./PluginAccountMetadata";
import * as Result from "effect/Result";
import { StandaloneSkills } from "./StandaloneSkills";
import { pluginNativeFailure as nativeFailure } from "./PluginNativeErrors";
import { makePluginApps } from "./PluginApps";
import {
  mapPluginProjection,
  normalizeConnectorId,
  configuredTable,
  safePluginCatalogIcon,
  projectMarketplaces,
  projectMcpServers,
  writablePluginConfigLayer,
} from "./PluginSettingsModel";
import type { McpServerStatus } from "@nodex/codex-app-server-protocol/v2/McpServerStatus";
import type { ConfigEdit } from "@nodex/codex-app-server-protocol/v2/ConfigEdit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import type {
  ClientRequestMethod,
  ClientRequestParamsByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { PluginInstalledResponse } from "@nodex/codex-app-server-protocol/v2/PluginInstalledResponse";
import type { PluginListResponse } from "@nodex/codex-app-server-protocol/v2/PluginListResponse";
import type { PluginDetail } from "@nodex/codex-app-server-protocol/v2/PluginDetail";
import type { PluginSummary } from "@nodex/codex-app-server-protocol/v2/PluginSummary";
import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import type { PluginInstallResponse } from "@nodex/codex-app-server-protocol/v2/PluginInstallResponse";
import type { MarketplaceUpgradeResponse } from "@nodex/codex-app-server-protocol/v2/MarketplaceUpgradeResponse";
import type {
  PluginContext,
  ResolvedPluginContext,
  PluginQueries,
  PluginCommands,
  PluginManagementChanged,
  PluginRow,
  PluginSelector,
  PluginMutationResult,
  PluginRefreshResource,
  PluginPage,
  PersonalPluginPage,
  MarketplaceRemovalProgress,
} from "../../shared/codex-plugin-management";
import {
  buildLocalPluginSections,
  dedupePluginRows,
  groupPersonalPlugins,
  mergeInstalledRows,
  mergePluginSections,
  pluginMatchesSearch,
} from "../../shared/codex-plugin-management-model";
import { isCodexAppServerVersionAtLeast } from "../../shared/codex-app-server-version";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AppProtocolRuntime } from "../host-runtime/AppProtocolRuntime";
import { PluginNativeOperations } from "./PluginNativeOperations";
import { PluginService, PluginServiceAccount, type ServiceListing } from "./PluginService";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { decodeChatGptBackendIdentity } from "../codex/chatgpt-backend-auth";
import { createPluginInventoryPolicy } from "./PluginInventoryPolicy";
import { pluginError, pluginFailure, PluginManagementError } from "./PluginManagementError";

export class PluginManager extends Context.Service<
  PluginManager,
  {
    readonly query: <K extends keyof PluginQueries>(
      name: K,
      input: PluginQueries[K]["input"],
    ) => Effect.Effect<PluginQueries[K]["output"], PluginManagementError>;
    readonly command: <K extends keyof PluginCommands>(
      name: K,
      input: PluginCommands[K]["input"],
    ) => Effect.Effect<PluginCommands[K]["output"]>;
    readonly changes: Stream.Stream<PluginManagementChanged>;
  }
>()("nodex/main/codex-application/PluginManager") {}
const failed = (error: PluginManagementError): PluginMutationResult<never> => ({
  status:
    error.code === "protected"
      ? "protected"
      : error.code === "policy_denied"
        ? "policy_denied"
        : "failed",
  error: pluginFailure(error),
});
const sameScope = (left: ResolvedPluginContext, right: ResolvedPluginContext): boolean =>
  left.hostId === right.hostId &&
  left.projectId === right.projectId &&
  left.accountEpoch === right.accountEpoch &&
  left.hostGeneration === right.hostGeneration &&
  left.bindingRevision === right.bindingRevision &&
  left.cwds.length === right.cwds.length &&
  left.cwds.every((cwd, index) => cwd === right.cwds[index]);
const PluginOperationLease = Context.Reference<AbortSignal | null>(
  "nodex/main/codex-application/PluginOperationLease",
  { defaultValue: () => null },
);
export const live = (options: {
  readonly runtimeStateHome: string;
  readonly codexHome: string;
  readonly homeDirectory?: string;
}) =>
  Layer.effect(
    PluginManager,
    Effect.gen(function* () {
      const gateway = yield* CodexGateway;
      const versions = yield* CodexAppServerCapabilities;
      const auth = yield* CodexExecutionHostAuthState;
      const workspace = yield* ProjectWorkspace;
      const protocol = yield* AppProtocolRuntime;
      const native = yield* PluginNativeOperations;
      const service = yield* PluginService;
      const desktop = yield* ChatGptDesktop;
      const apps = yield* makePluginApps;
      const accountMetadata = yield* makePluginAccountMetadata;
      const standaloneSkills = yield* StandaloneSkills;
      const policy = createPluginInventoryPolicy(options.runtimeStateHome);
      const epoch = yield* Ref.make(0);
      // Backpressure retains progress and OAuth completion; IPC fan-out does not await renderer work.
      const events = yield* PubSub.bounded<PluginManagementChanged>(
        MAIN_OBSERVATION_EVENT_CAPACITY,
      );
      yield* Effect.addFinalizer(() => PubSub.shutdown(events));
      const lane = yield* Semaphore.make(1);
      const removals = new Map<
        string,
        { context: ResolvedPluginContext; progress: MarketplaceRemovalProgress }
      >();
      // Only completed, fenced detail reads grant exact manifest paths to previews.
      const detailSkillGrants = new Map<
        string,
        Map<
          string,
          {
            readonly selector: PluginSelector;
            readonly nativeId: string;
            readonly paths: ReadonlySet<string>;
          }
        >
      >();
      const skillGrantScope = (
        context: ResolvedPluginContext,
        account: { readonly accountId: string; readonly userId: string } | null,
      ) => JSON.stringify([context, account?.accountId ?? null, account?.userId ?? null]);
      const skillManifestPath = (path: string) =>
        isAbsoluteAppFilesystemPath(path) && /[/\\]SKILL\.md$/u.test(path);
      let nextOperation = 0;
      const emit = Effect.fn("PluginManager.emit")(function* (
        kind: PluginManagementChanged["kind"],
        progress?: MarketplaceRemovalProgress,
      ) {
        yield* PubSub.publish(events, {
          hostId: "local",
          accountEpoch: yield* Ref.get(epoch),
          kind,
          ...(progress ? { progress } : {}),
        });
      });
      yield* gateway.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.kind === "connection") {
              if (event.value.hostId !== "local") return;
              detailSkillGrants.clear();
              yield* Ref.update(epoch, (n) => n + 1);
              yield* emit("connection");
              return;
            }
            if (event.hostId !== "local") return;
            if (event.value.method === "account/updated") {
              detailSkillGrants.clear();
              yield* Ref.update(epoch, (n) => n + 1);
              yield* emit("account");
              return;
            }
            const method: string = event.value.method;
            if (method === "skills/changed" || method === "codex/event/skills_update_available")
              yield* emit("skills");
            else if (method === "app/list/updated") yield* emit("apps");
            else if (event.value.method === "mcpServer/oauthLogin/completed")
              yield* PubSub.publish(events, {
                hostId: event.hostId,
                accountEpoch: yield* Ref.get(epoch),
                kind: "mcp",
                hostGeneration: event.generation,
                mcpOauthCompletion: event.value
                  .params as unknown as import("@nodex/codex-app-server-protocol/v2/McpServerOauthLoginCompletedNotification").McpServerOauthLoginCompletedNotification,
              });
            else if (method === "mcpServer/startupStatus/updated") yield* emit("mcp");
            else if (method.startsWith("plugin/") || method.startsWith("marketplace/"))
              yield* emit("plugins");
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* native.changes.pipe(
        Stream.runForEach(() => emit("plugins")),
        Effect.forkScoped({ startImmediately: true }),
      );
      const resolve = Effect.fn("PluginManager.resolve")(function* (input: PluginContext) {
        if (input.hostId !== "local")
          return yield* pluginError(
            "host_unavailable",
            "Plugin management is available on the local host.",
          );
        yield* gateway
          .awaitReady("local")
          .pipe(
            Effect.mapError(() =>
              pluginError("host_unavailable", "The local agent is unavailable."),
            ),
          );
        const version = yield* versions
          .forHost("local")
          .pipe(
            Effect.mapError(() =>
              pluginError("host_unavailable", "The local agent is unavailable."),
            ),
          );
        const project =
          input.projectId === null
            ? null
            : yield* workspace
                .getProject(input.projectId)
                .pipe(
                  Effect.mapError(() =>
                    pluginError("project_unavailable", "The Project is unavailable."),
                  ),
                );
        if (input.projectId !== null && (!project || project.lifecycle !== "active"))
          return yield* pluginError("project_unavailable", "The Project is unavailable.");
        const context = {
          hostId: input.hostId,
          projectId: input.projectId,
          hostGeneration: version.generation,
          accountEpoch: yield* Ref.get(epoch),
          bindingRevision: project?.bindingRevision ?? null,
          cwds: [
            ...new Set(
              (project?.sources ?? [])
                .toSorted((a, b) => a.order - b.order)
                .map((source) => source.root.trim())
                .filter(Boolean),
            ),
          ],
        } satisfies ResolvedPluginContext;
        yield* native.observeSkillScope(context);
        return context;
      });
      const assertCurrent = Effect.fn("PluginManager.assertCurrent")(function* (
        context: ResolvedPluginContext,
      ) {
        const lease = yield* PluginOperationLease;
        if (lease?.aborted)
          return yield* pluginError("account_changed", "The authenticated account changed.");
        const current = yield* resolve(context);
        if (current.accountEpoch !== context.accountEpoch)
          return yield* pluginError("account_changed", "The authenticated account changed.");
        if (current.hostGeneration !== context.hostGeneration)
          return yield* pluginError("host_unavailable", "The local agent restarted.");
        if (
          current.bindingRevision !== context.bindingRevision ||
          current.cwds.length !== context.cwds.length ||
          current.cwds.some((cwd, index) => cwd !== context.cwds[index])
        )
          return yield* pluginError("project_unavailable", "The Project workspace changed.");
      });
      const withOperationLease = <A, E>(operation: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const lease = yield* PluginOperationLease;
          if (!lease) return yield* operation;
          if (lease.aborted)
            return yield* pluginError("account_changed", "The authenticated account changed.");
          const revoked = Effect.callback<never, PluginManagementError>((resume) => {
            const abort = () =>
              resume(
                Effect.fail(pluginError("account_changed", "The authenticated account changed.")),
              );
            if (lease.aborted) {
              abort();
              return;
            }
            lease.addEventListener("abort", abort, { once: true });
            return Effect.sync(() => lease.removeEventListener("abort", abort));
          });
          return yield* Effect.raceFirst(revoked, operation);
        });
      const request = <M extends ClientRequestMethod>(
        context: ResolvedPluginContext,
        method: M,
        params: ClientRequestParamsByMethod[M],
      ) =>
        withOperationLease(
          gateway
            .requestOnHost("local", method, params, {
              expectedHostId: "local",
              expectedGeneration: context.hostGeneration,
            })
            .pipe(Effect.mapError(nativeFailure)),
        );
      const captureAccount = Effect.gen(function* () {
        const status = yield* desktop
          .authStatus(true, false)
          .pipe(
            Effect.mapError(() => pluginError("auth_required", "Authentication is unavailable.")),
          );
        if (status.authMethod !== "chatgpt") return null;
        const identity = status.authToken ? decodeChatGptBackendIdentity(status.authToken) : null;
        if (!identity)
          return yield* pluginError("auth_required", "ChatGPT authentication is unavailable.");
        return identity;
      });
      const icon = policy.iconResolver("local", protocol.authorizeHostFile);
      const rows = (response: PluginInstalledResponse) =>
        policy.rows(
          response,
          "local",
          icon,
          `${options.homeDirectory ?? options.codexHome}/.agents/plugins/marketplace.json`,
        );
      const installedRaw = (context: ResolvedPluginContext) =>
        request(context, "plugin/installed", {
          cwds: context.cwds.length ? [...context.cwds] : null,
        }).pipe(Effect.map((response) => response as unknown as PluginInstalledResponse));
      const installed = (context: ResolvedPluginContext) =>
        installedRaw(context).pipe(Effect.map((response) => policy.project(response, "local")));
      const directoryRaw = (context: ResolvedPluginContext, forceRefetch = false) =>
        request(context, "plugin/list", {
          cwds: context.cwds.length ? [...context.cwds] : null,
          forceRefetch,
        }).pipe(Effect.map((response) => response as unknown as PluginListResponse));
      const directory = (context: ResolvedPluginContext, forceRefetch = false) =>
        directoryRaw(context, forceRefetch).pipe(
          Effect.map((response) => policy.project(response, "local")),
        );
      const protectedMarketplace = (response: PluginInstalledResponse, name?: string | null) =>
        name === policy.marketplaceName ||
        response.marketplaces.some(
          (marketplace) =>
            (name == null || marketplace.name === name) &&
            (marketplace.name === policy.marketplaceName ||
              marketplace.plugins.some(
                (plugin) =>
                  policy.managed(plugin.id, "local") || !policy.visible(plugin.id, "local"),
              )),
        );
      const requireInventory = Effect.fn("PluginManager.requireInventory")(function* (
        context: ResolvedPluginContext,
      ) {
        const response = yield* installed(context);
        if (response.marketplaceLoadErrors.length)
          return yield* pluginError(
            "inventory_unavailable",
            "Plugin inventory is incomplete. Refresh before changing plugins.",
          );
        return rows(response);
      });
      const findPlugin = Effect.fn("PluginManager.findPlugin")(function* (
        context: ResolvedPluginContext,
        id: string,
        mutable = false,
      ) {
        if (!policy.visible(id, "local"))
          return yield* pluginError("protected", "This desktop tool is managed by Nodex.");
        const inventory = yield* requireInventory(context);
        const row = inventory.find((item) => item.nativeId === id || item.stableIdentity === id);
        if (!row) return yield* pluginError("not_found", "The installed plugin was not found.");
        if (mutable && row.managed)
          return yield* pluginError("protected", "This desktop tool is managed by Nodex.");
        return row;
      });
      const reload = Effect.fn("PluginManager.reload")(function* (
        context: ResolvedPluginContext,
        resources: readonly PluginRefreshResource[] = ["plugins", "skills", "apps", "hooks", "mcp"],
      ) {
        const failures: PluginRefreshResource[] = [];
        const settle = <A>(
          resource: PluginRefreshResource,
          effect: Effect.Effect<A, PluginManagementError>,
        ) =>
          !resources.includes(resource)
            ? Effect.void
            : effect.pipe(
                Effect.catch(() =>
                  Effect.sync(() => {
                    if (!failures.includes(resource)) failures.push(resource);
                  }),
                ),
              );
        const observed = yield* native.skillScopes(context.hostId);
        const scopes = observed.length ? observed : [context.cwds];
        for (const cwds of scopes)
          yield* settle(
            "skills",
            request(context, "skills/list", { cwds: [...cwds], forceReload: true }),
          );
        yield* settle(
          "plugins",
          directory(context, true).pipe(
            Effect.flatMap((response) =>
              response.marketplaceLoadErrors.length
                ? Effect.fail(
                    pluginError("inventory_unavailable", "Plugin inventory is incomplete."),
                  )
                : Effect.succeed(response),
            ),
          ),
        );
        yield* settle(
          "apps",
          withOperationLease(apps.list(context, { ...context, forceRefresh: true })).pipe(
            Effect.flatMap((view) =>
              view.connectionError
                ? Effect.fail(
                    pluginError(
                      view.connectionError.code,
                      view.connectionError.message,
                      view.connectionError.retryable,
                    ),
                  )
                : Effect.void,
            ),
          ),
        );
        yield* settle("hooks", request(context, "hooks/list", { cwds: [...context.cwds] }));
        yield* settle("mcp", request(context, "mcpServerStatus/list", {}));
        return failures;
      });
      const applied = Effect.fn("PluginManager.applied")(function* <A>(
        context: ResolvedPluginContext,
        value: A,
        notify: boolean | PluginManagementChanged["kind"] = true,
      ) {
        if (notify) yield* emit(notify === true ? "plugins" : notify);
        const resources: readonly PluginRefreshResource[] | undefined =
          notify === "skills"
            ? ["skills"]
            : notify === "hooks"
              ? ["hooks"]
              : notify === "mcp" || notify === "apps"
                ? ["apps", "mcp"]
                : undefined;
        const refreshFailures = yield* reload(context, resources);
        return {
          status: refreshFailures.length ? "success-with-refresh-warning" : "success",
          value,
          refreshFailures,
        } as const;
      });
      const serviceRows = (
        listings: readonly ServiceListing[],
        inventory: readonly PluginRow[],
        marketplaceName = "openai-curated-remote",
      ) => {
        const projected = listings.map((listing): PluginSummary => {
          const ui = listing.release?.interface;
          return {
            id: `${listing.name ?? listing.id}@${marketplaceName}`,
            remotePluginId: listing.id,
            name: listing.name ?? listing.id,
            version: listing.release?.version ?? null,
            localVersion: null,
            shareContext: null,
            source: { type: "remote" },
            installed: false,
            installedAt: null,
            enabled: false,
            installPolicy: listing.installation_policy ?? "AVAILABLE",
            installPolicySource: listing.installation_policy_source ?? null,
            mustShowInstallationInterstitial: listing.must_show_installation_interstitial ?? null,
            authPolicy: listing.authentication_policy ?? "ON_USE",
            availability:
              listing.status === "DISABLED_BY_ADMIN" ? "DISABLED_BY_ADMIN" : "AVAILABLE",
            disabledReason: listing.disabled_reason ?? null,
            eligiblePlanTypes: listing.eligible_plan_types
              ? [...listing.eligible_plan_types]
              : null,
            keywords: [...(listing.keywords ?? ui?.capabilities ?? [])],
            interface: {
              displayName:
                listing.display_name ?? listing.release?.display_name ?? listing.name ?? listing.id,
              shortDescription: listing.short_description ?? ui?.short_description ?? null,
              longDescription: ui?.long_description ?? null,
              developerName: ui?.developer_name ?? null,
              category: ui?.category ?? null,
              capabilities: [...(ui?.capabilities ?? [])],
              websiteUrl: ui?.website_url ?? null,
              privacyPolicyUrl: ui?.privacy_policy_url ?? null,
              termsOfServiceUrl: ui?.terms_of_service_url ?? null,
              defaultPrompt: ui?.default_prompts
                ? [...ui.default_prompts]
                : ui?.default_prompt
                  ? [ui.default_prompt]
                  : null,
              brandColor: ui?.brand_color ?? null,
              composerIcon: null,
              composerIconUrl: ui?.composer_icon_url ?? null,
              logo: null,
              logoDark: null,
              logoUrl: listing.icon_url ?? ui?.logo_url ?? null,
              logoUrlDark: listing.icon_url_dark ?? ui?.logo_url_dark ?? null,
              screenshots: [],
              screenshotUrls: [],
            },
          };
        });
        return mergeInstalledRows(
          rows({
            marketplaces: [
              { name: marketplaceName, path: null, interface: null, plugins: projected },
            ],
            marketplaceLoadErrors: [],
          }),
          inventory,
        );
      };
      const access = (context: ResolvedPluginContext) =>
        service.access.pipe(Effect.tap(() => assertCurrent(context)));
      const personalPage = Effect.fn("PluginManager.personalPage")(function* (
        context: ResolvedPluginContext,
        input: PluginQueries["personal-page"]["input"],
        limit: 9 | 50 = 50,
      ): Effect.fn.Return<PersonalPluginPage, PluginManagementError> {
        const capabilities = yield* access(context);
        if (
          (input.feed === "shared" && !capabilities.shared) ||
          (input.feed === "created" && !capabilities.personal)
        )
          return { rows: [], nextCursor: null };
        const inventory = yield* requireInventory(context);
        if (input.feed === "shared") {
          const page = yield* service.page({
            feed: "shared",
            limit,
            cursor: input.cursor?.workspaceCreatedPageToken,
          });
          const token = page.pagination.next_page_token ?? null;
          return {
            rows: serviceRows(page.plugins, inventory, "shared-with-me"),
            nextCursor:
              token === null ? null : { workspaceCreatedPageToken: token, userPageToken: null },
          };
        }
        const fetchWorkspace =
          capabilities.workspaceCreated &&
          (input.cursor == null || input.cursor.workspaceCreatedPageToken !== null);
        const fetchUser = input.cursor == null || input.cursor.userPageToken !== null;
        const [workspacePage, userPage] = yield* Effect.all([
          fetchWorkspace
            ? service.page({
                feed: "workspace-created",
                limit,
                cursor: input.cursor?.workspaceCreatedPageToken,
              })
            : Effect.succeed(null),
          fetchUser
            ? service.page({ feed: "user", limit, cursor: input.cursor?.userPageToken })
            : Effect.succeed(null),
        ]);
        const cursor = {
          workspaceCreatedPageToken: workspacePage?.pagination.next_page_token ?? null,
          userPageToken: userPage?.pagination.next_page_token ?? null,
        };
        return {
          rows: serviceRows(
            [...(workspacePage?.plugins ?? []), ...(userPage?.plugins ?? [])],
            inventory,
            "created-by-me-remote",
          ),
          nextCursor:
            cursor.workspaceCreatedPageToken === null && cursor.userPageToken === null
              ? null
              : cursor,
        };
      });
      const configRead = (context: ResolvedPluginContext) =>
        request(context, "config/read", { includeLayers: true, cwd: context.cwds[0] ?? null }).pipe(
          Effect.map((response) => response as unknown as ConfigReadResponse),
        );
      const writeConfig = Effect.fn("PluginManager.writeConfig")(function* (
        context: ResolvedPluginContext,
        config: ConfigReadResponse,
        edits: ConfigEdit[],
      ) {
        const user = writablePluginConfigLayer(config);
        if (!user || user.name.type !== "user")
          return yield* pluginError(
            "inventory_unavailable",
            "Versioned user configuration is unavailable.",
          );
        yield* assertCurrent(context);
        const written = yield* request(context, "config/batchWrite", {
          edits: edits as unknown as ClientRequestParamsByMethod["config/batchWrite"]["edits"],
          filePath: user.name.file,
          expectedVersion: user.version,
          reloadUserConfig: true,
        }).pipe(
          Effect.mapError((error) =>
            error.code === "mutation_outcome_unknown"
              ? error
              : pluginError("config_conflict", "Settings changed. Refresh before trying again."),
          ),
        );
        if (written.status === "okOverridden")
          return yield* pluginError("policy_denied", "These settings are controlled by policy.");
      });
      const mcpStatuses = Effect.fn("PluginManager.mcpStatuses")(function* (
        context: ResolvedPluginContext,
      ) {
        const statuses: McpServerStatus[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        do {
          const page: import("@nodex/codex-app-server-protocol/v2/ListMcpServerStatusResponse").ListMcpServerStatusResponse =
            (yield* request(context, "mcpServerStatus/list", {
              cursor,
              limit: 100,
              detail: "full",
            })) as unknown as import("@nodex/codex-app-server-protocol/v2/ListMcpServerStatusResponse").ListMcpServerStatusResponse;
          statuses.push(...(page.data as unknown as McpServerStatus[]));
          cursor = page.nextCursor;
          if (cursor !== null && seen.has(cursor))
            return yield* pluginError(
              "inventory_unavailable",
              "MCP inventory pagination did not advance.",
            );
          if (cursor !== null) seen.add(cursor);
        } while (cursor !== null);
        return statuses;
      });
      const marketplaces = Effect.fn("PluginManager.marketplaces")(function* (
        context: ResolvedPluginContext,
      ) {
        const [catalog, config] = yield* Effect.all([directoryRaw(context), configRead(context)]);
        return projectMarketplaces(catalog, config, policy.marketplaceName);
      });
      const pluginHooks = Effect.fn("PluginManager.pluginHookInventory")(function* (
        context: ResolvedPluginContext,
        pluginId: string,
      ) {
        if (!context.cwds.length) return { available: false, hooks: [], needsReviewCount: 0 };
        const response = (yield* request(context, "hooks/list", {
          cwds: [...context.cwds],
        })) as unknown as import("@nodex/codex-app-server-protocol/v2/HooksListResponse").HooksListResponse;
        if (response.data.some((entry) => entry.errors.length))
          return yield* pluginError("inventory_unavailable", "Hook inventory could not be loaded.");
        const hooks = [
          ...new Map(
            response.data
              .flatMap((entry) => entry.hooks)
              .filter((hook) => hook.pluginId === pluginId)
              .map((hook) => [hook.key, hook]),
          ).values(),
        ];
        return {
          available: true,
          hooks,
          needsReviewCount: hooks.filter(
            (hook) =>
              !hook.isManaged &&
              (hook.trustStatus === "untrusted" || hook.trustStatus === "modified"),
          ).length,
        };
      });
      const updateMcp = Effect.fn("PluginManager.updateMcp")(function* (
        context: ResolvedPluginContext,
        input: PluginCommands["mcp-save" | "mcp-remove" | "mcp-enabled"]["input"],
        action: "save" | "remove" | "enabled",
      ) {
        const [config, statuses] = yield* Effect.all([configRead(context), mcpStatuses(context)]);
        const servers = projectMcpServers(config, statuses).servers;
        const previousName =
          "previousName" in input ? (input.previousName ?? input.name) : input.name;
        const previous = servers.find((server) => server.name === previousName);
        const target = servers.find((server) => server.name === input.name);
        if (previous?.readOnly || target?.readOnly)
          return yield* pluginError(
            "protected",
            "This MCP server is managed by a plugin or another configuration layer.",
          );
        if (action !== "save" && !previous)
          return yield* pluginError("not_found", "The MCP server was not found.");
        if (previousName !== input.name && target)
          return yield* pluginError("invalid_input", "An MCP server already uses this name.");
        if (
          !input.name.trim() ||
          input.name !== input.name.trim() ||
          ["__proto__", "constructor", "prototype"].includes(input.name)
        )
          return yield* pluginError("invalid_input", "Enter a valid MCP server name.");
        const entries = {
          ...configuredTable(
            configuredTable(writablePluginConfigLayer(config)?.config).mcp_servers,
          ),
        } as Record<string, ConfigEdit["value"]>;
        if (action === "remove") delete entries[input.name];
        if (action === "enabled" && "enabled" in input)
          entries[input.name] = { ...previous?.declaration, enabled: input.enabled };
        if (action === "save" && "declaration" in input) {
          const declaration = input.declaration;
          const stdio = typeof declaration.command === "string" && !!declaration.command.trim();
          const http = typeof declaration.url === "string" && /^https?:\/\//u.test(declaration.url);
          if (stdio === http)
            return yield* pluginError(
              "invalid_input",
              "Configure either a command or an HTTP URL.",
            );
          delete entries[previousName];
          entries[input.name] = { ...declaration };
        }
        yield* writeConfig(context, config, [
          { keyPath: "mcp_servers", value: entries, mergeStrategy: "replace" },
        ]);
        return yield* applied(context, undefined, "mcp");
      });
      const hydrateAppConnections = Effect.fn("PluginManager.hydrateAppConnections")(function* <A>(
        context: ResolvedPluginContext,
        value: A,
      ) {
        const candidates = new Map<string, PluginRow>();
        mapPluginProjection(value, (row) => {
          if (!row.managed && (row.marketplace.path !== null || row.summary.installed))
            candidates.set(row.nativeId, row);
          return row;
        });
        if (!candidates.size) return value;
        const details = yield* Effect.forEach(
          [...candidates.values()],
          (row) =>
            request(context, "plugin/read", {
              marketplacePath: row.selector.marketplacePath ?? null,
              remoteMarketplaceName: row.selector.remoteMarketplaceName ?? null,
              pluginName: row.selector.pluginName,
            }).pipe(
              Effect.map((response) => ({
                row,
                apps: (response.plugin as unknown as PluginDetail).apps,
                error: null as import("../../shared/codex-plugin-management").PluginFailure | null,
              })),
              Effect.orElseSucceed((error) => ({
                row,
                apps: [] as PluginDetail["apps"],
                error: pluginFailure(error),
              })),
            ),
          { concurrency: 4 },
        );
        const appIds = [...new Set(details.flatMap((detail) => detail.apps.map((app) => app.id)))];
        const appView = appIds.length
          ? yield* withOperationLease(apps.list(context, { ...context, appIds })).pipe(
              Effect.orElseSucceed((error) => ({
                apps: [],
                connectionError: pluginFailure(error),
              })),
            )
          : null;
        const projected = new Map(
          details.map((detail) => [
            detail.row.nativeId,
            {
              ...detail.row,
              appConnectionError: detail.error ?? appView?.connectionError ?? null,
              ...(detail.error
                ? {}
                : {
                    appConnectionStates: Object.fromEntries(
                      detail.apps.map((app) => [
                        app.id,
                        appView?.apps.find(
                          (row) => normalizeConnectorId(row.id) === normalizeConnectorId(app.id),
                        )?.connectionState ?? "unknown",
                      ]),
                    ),
                  }),
            },
          ]),
        );
        return mapPluginProjection(value, (row) => projected.get(row.nativeId) ?? row) as A;
      });
      const queryHandlers: {
        [K in keyof PluginQueries]: (
          context: ResolvedPluginContext,
          input: PluginQueries[K]["input"],
        ) => Effect.Effect<PluginQueries[K]["output"], PluginManagementError>;
      } = {
        marketplaces,
        apps: (context, input) => withOperationLease(apps.list(context, input)),
        "mcp-servers": Effect.fn("PluginManager.mcpServers")(function* (context) {
          const [config, statuses] = yield* Effect.all([configRead(context), mcpStatuses(context)]);
          return projectMcpServers(config, statuses);
        }),
        "recommended-skills": (_context, input) => standaloneSkills.list(input.refresh ?? false),
        "creation-capabilities": Effect.fn("PluginManager.creationCapabilities")(
          function* (context) {
            const inventory = yield* queryHandlers.list(context, context);
            const eligible = (
              row: PluginRow | undefined,
            ): import("../../shared/codex-plugin-settings").PluginHelperCapability => {
              if (!row)
                return {
                  available: false,
                  plugin: null,
                  reason: pluginFailure(
                    pluginError("not_found", "This helper is unavailable in the catalog."),
                  ),
                };
              const denied =
                row.summary.availability === "DISABLED_BY_ADMIN" ||
                row.summary.installPolicy === "NOT_AVAILABLE";
              return {
                available: !denied,
                plugin: row,
                reason: denied
                  ? pluginFailure(
                      pluginError("policy_denied", "This helper is disabled by policy."),
                    )
                  : null,
              };
            };
            let creator = inventory.rows.find(
              (row) =>
                row.isOfficial && ["plugin_creator", "plugin-creator"].includes(row.summary.name),
            );
            let creatorError: PluginManagementError | null = null;
            if (!creator && (yield* PluginServiceAccount) !== null) {
              const result = yield* accountMetadata.creatorPluginId.pipe(
                Effect.flatMap((id) =>
                  queryHandlers.read(context, {
                    ...context,
                    remoteMarketplaceName: "chatgpt-workspace",
                    pluginName: id,
                  }),
                ),
                Effect.result,
              );
              if (Result.isSuccess(result)) creator = result.success.row;
              else creatorError = result.failure;
            }
            const createPlugin = eligible(creator);
            return {
              createPlugin:
                !creator && creatorError
                  ? { ...createPlugin, reason: pluginFailure(creatorError) }
                  : createPlugin,
              recordSkill: eligible(
                inventory.rows.find(
                  (row) => row.isOfficial && row.summary.name === "record-and-replay",
                ),
              ),
            };
          },
        ),
        "plugin-hooks": Effect.fn("PluginManager.pluginHooks")(function* (context, input) {
          const detail = yield* queryHandlers.read(context, input);
          return yield* pluginHooks(context, detail.summary.id);
        }),
        context: (context) => Effect.succeed(context),
        capabilities: Effect.fn("PluginManager.capabilities")(function* (context) {
          const status = yield* desktop
            .authStatus(false, false)
            .pipe(
              Effect.mapError(() => pluginError("auth_required", "Authentication is unavailable.")),
            );
          const version = yield* versions.forHost("local").pipe(Effect.mapError(nativeFailure));
          return {
            context,
            ...(yield* access(context)),
            nativeSearch:
              (status.authMethod === "chatgpt" || status.authMethod === "apikey") &&
              (version.version === "0.0.0" ||
                isCodexAppServerVersionAtLeast(version.version, "0.147.0-alpha.6")),
          };
        }),
        list: Effect.fn("PluginManager.list")(function* (context, input) {
          const [response, active] = yield* Effect.all([
            directory(context, input.forceRefetch),
            installed(context),
          ]);
          return {
            context,
            response: {
              ...response,
              marketplaceLoadErrors: [
                ...response.marketplaceLoadErrors,
                ...active.marketplaceLoadErrors,
              ],
            },
            rows: mergeInstalledRows(rows(response), rows(active)),
          };
        }),
        installed: Effect.fn("PluginManager.installed")(function* (context) {
          const response = yield* installed(context);
          return { context, response, rows: rows(response) };
        }),
        read: Effect.fn("PluginManager.read")(function* (context, input) {
          const response = yield* request(context, "plugin/read", {
            marketplacePath: input.marketplacePath ?? null,
            remoteMarketplaceName: input.remoteMarketplaceName ?? null,
            pluginName: input.pluginName,
          });
          const detail = response.plugin as unknown as PluginDetail;
          if (!policy.visible(detail.summary.id, "local"))
            return yield* pluginError("not_found", "The plugin was not found.");
          const row = rows({
            marketplaces: [
              {
                name: detail.marketplaceName,
                path: detail.marketplacePath,
                interface: null,
                plugins: [detail.summary],
              },
            ],
            marketplaceLoadErrors: [],
          })[0]!;
          const ui = row.summary.interface;
          const appView = detail.apps.length
            ? yield* withOperationLease(
                apps.list(context, {
                  ...context,
                  appIds: detail.apps.map((app) => app.id),
                  forceRefresh: "forceRefreshApps" in input && input.forceRefreshApps === true,
                }),
              ).pipe(
                Effect.orElseSucceed((error) => ({
                  apps: [],
                  connectionError: pluginFailure(error),
                })),
              )
            : null;
          const appConnectionStates = Object.fromEntries(
            detail.apps.map((app) => [
              app.id,
              appView?.apps.find(
                (row) => normalizeConnectorId(row.id) === normalizeConnectorId(app.id),
              )?.connectionState ?? "unknown",
            ]),
          );
          const remoteId =
            detail.summary.remotePluginId ?? detail.summary.shareContext?.remotePluginId;
          const worksWith =
            remoteId && (yield* PluginServiceAccount) !== null
              ? yield* accountMetadata.dependencies(remoteId).pipe(
                  Effect.map((dependencies) => ({
                    dependencies: dependencies ?? [],
                    available: dependencies !== null,
                    error: null,
                  })),
                  Effect.orElseSucceed((error) => ({
                    dependencies: [],
                    available: false,
                    error: pluginFailure(error),
                  })),
                )
              : { dependencies: [], available: false, error: null };
          const providerInventory =
            worksWith.available && worksWith.dependencies.length
              ? yield* installed(context).pipe(Effect.orElseSucceed(() => null))
              : null;
          const dependencies = worksWith.dependencies.map((provider) => ({
            ...provider,
            installed:
              providerInventory && !providerInventory.marketplaceLoadErrors.length
                ? rows(providerInventory).some(
                    (row) =>
                      row.summary.installed &&
                      (row.stableIdentity === provider.pluginId ||
                        row.nativeId === provider.pluginId),
                  )
                : null,
          }));
          const skillInventory =
            row.summary.installed && detail.skills.length
              ? yield* request(context, "skills/list", {
                  cwds: [...context.cwds],
                  forceReload: false,
                }).pipe(
                  Effect.map((value) => {
                    const entries = (value as unknown as SkillsListResponse).data;
                    return {
                      skills: entries.flatMap((entry) => entry.skills),
                      error: entries.some((entry) => entry.errors.length)
                        ? pluginFailure(
                            pluginError(
                              "inventory_unavailable",
                              "Some local skills could not be loaded.",
                            ),
                          )
                        : null,
                    };
                  }),
                  Effect.orElseSucceed((error) => ({ skills: [], error: pluginFailure(error) })),
                )
              : { skills: [], error: null };
          const hookInventory = row.summary.installed
            ? yield* pluginHooks(context, row.nativeId).pipe(
                Effect.map((value) => ({ ...value, error: null })),
                Effect.orElseSucceed((error) => ({
                  available: false,
                  hooks: [],
                  needsReviewCount: 0,
                  error: pluginFailure(error),
                })),
              )
            : { available: false, hooks: [], needsReviewCount: 0, error: null };
          const mcpInventory =
            row.summary.installed && detail.mcpServers.length
              ? yield* Effect.all([configRead(context), mcpStatuses(context)]).pipe(
                  Effect.map(([config, statuses]) => ({ config, statuses, error: null })),
                  Effect.orElseSucceed((error) => ({
                    config: null,
                    statuses: [],
                    error: pluginFailure(error),
                  })),
                )
              : { config: null, statuses: [], error: null };
          return {
            appConnectionStates,
            appConnectionError: appView?.connectionError ?? null,
            worksWith: { ...worksWith, dependencies },
            appTemplates: detail.appTemplates,
            onboardingSkill: detail.onboardingSkill,
            scheduledTasks: detail.scheduledTasks,

            detail: { ...detail, summary: row.summary },
            row: { ...row, appConnectionStates },
            summary: row.summary,
            description: detail.description,
            skills: detail.skills.map((skill) => {
              const local = matchPluginDetailSkill(row.summary.name, skill, skillInventory.skills);
              return {
                ...skill,
                iconUrl: authorizedPluginAsset(
                  skill.interface?.iconSmall,
                  skill.interface?.iconSmallUrl,
                  icon,
                ),
                installedSkill: local
                  ? { path: local.path, name: local.name, enabled: local.enabled }
                  : null,
              };
            }),
            skillsError: skillInventory.error,
            apps: detail.apps.map((app) => {
              const state = appView?.apps.find(
                (entry) => normalizeConnectorId(entry.id) === normalizeConnectorId(app.id),
              );
              return {
                ...app,
                installUrl: state?.installUrl ?? safePluginCatalogIcon(app.installUrl),
                logoUrl: state?.logoUrl ?? null,
                logoDarkUrl: state?.logoDarkUrl ?? null,
                accessible: state?.accessible ?? null,
                enabled: state?.runtime ? state.enabled : null,
                callable: state?.runtime ? state.callable : null,
                editable: state?.editable ?? false,
                editRestriction: state
                  ? state.editRestriction
                  : pluginFailure(
                      pluginError("inventory_unavailable", "App settings are unavailable."),
                    ),
                connectionState: state?.connectionState ?? "unknown",
                canDisconnect: state?.canDisconnect ?? false,
              };
            }),
            mcpServers: detail.mcpServers,
            mcpServerStates: projectPluginMcpServers(
              detail.mcpServers,
              row.nativeId,
              row.summary.installed,
              row.canSetEnabled,
              mcpInventory.config,
              mcpInventory.statuses,
            ),
            mcpServerError: mcpInventory.error,
            hooks: detail.hooks,
            hooksNeedingReviewCount: hookInventory.needsReviewCount,
            hooksAvailable: hookInventory.available,
            hooksError: hookInventory.error,
            info: {
              capabilities: ui?.capabilities ?? [],
              developer: ui?.developerName ?? null,
              category: ui?.category ?? null,
              version: row.summary.localVersion ?? row.summary.version,
              websiteUrl: ui?.websiteUrl ?? null,
              privacyPolicyUrl: ui?.privacyPolicyUrl ?? null,
              termsOfServiceUrl: ui?.termsOfServiceUrl ?? null,
              defaultPrompts: ui?.defaultPrompt ?? [],
              brandColor: ui?.brandColor ?? null,
              logoUrl: row.logoUrl,
              logoDarkUrl: row.logoDarkUrl,
            },
          };
        }),
        search: Effect.fn("PluginManager.search")(function* (context, input) {
          const capabilities = yield* queryHandlers.capabilities(context, context);
          const inventory = yield* requireInventory(context);
          if (!capabilities.nativeSearch) {
            if (input.scope === "workspace")
              return yield* pluginError("unsupported", "Workspace plugin search is unavailable.");
            if (input.cursor != null) return { rows: [], nextCursor: null };
            return {
              rows: dedupePluginRows([
                ...mergeInstalledRows(rows(yield* directory(context)), inventory),
                ...inventory,
              ]).filter(
                (row) =>
                  pluginMatchesSearch(row, input.term) &&
                  (input.scope !== "personal" || row.isPersonal || !row.isOfficial),
              ),
              nextCursor: null,
            };
          }
          const response = yield* request(context, "plugin/search", {
            searchTerm: input.term.trim(),
            scope: input.scope ?? "global",
            cwds: [...context.cwds],
            cursor: input.cursor ?? null,
            limit: 50,
          });
          const result = response.data.flatMap((entry) =>
            rows({
              marketplaces: [
                {
                  name: entry.marketplaceName,
                  path: entry.marketplacePath ?? null,
                  interface: null,
                  plugins: [entry.plugin as unknown as PluginSummary],
                },
              ],
              marketplaceLoadErrors: [],
            }),
          );
          return {
            rows: mergeInstalledRows(result, inventory),
            nextCursor: response.nextCursor ?? null,
          };
        }),
        skills: (context, input) =>
          request(context, "skills/list", {
            cwds: [...context.cwds],
            forceReload: input.forceReload ?? false,
          }).pipe(Effect.map((response) => response as unknown as SkillsListResponse)),
        "skill-contents": Effect.fn("PluginManager.skillContents")(
          function* (context, input) {
            if ("remotePluginId" in input)
              return yield* request(context, "plugin/skill/read", {
                remoteMarketplaceName: input.remoteMarketplaceName,
                remotePluginId: input.remotePluginId,
                skillName: input.skillName,
              }).pipe(
                Effect.map((response) => ({
                  status: "success" as const,
                  contents: response.contents ?? null,
                  files: ["SKILL.md"],
                })),
              );
            if (!skillManifestPath(input.path))
              return yield* pluginError(
                "not_found",
                "The skill was not found in the current inventory.",
              );
            const contents = (path: string) =>
              assertCurrent(context).pipe(
                Effect.andThen(standaloneSkills.contents(path)),
                Effect.map((value) => ({ ...value, status: "success" as const })),
              );
            const scope = skillGrantScope(context, yield* PluginServiceAccount);
            const grants = detailSkillGrants.get(scope);
            for (const grant of grants?.values() ?? []) {
              if (!grant.paths.has(input.path)) continue;
              const response = yield* request(context, "plugin/read", {
                marketplacePath: grant.selector.marketplacePath ?? null,
                remoteMarketplaceName: grant.selector.remoteMarketplaceName ?? null,
                pluginName: grant.selector.pluginName,
              });
              const detail = response.plugin as unknown as PluginDetail;
              const current =
                detail.summary.id === grant.nativeId &&
                policy.visible(detail.summary.id, context.hostId) &&
                detail.skills.some((skill) => skill.path === input.path);
              if (current) return yield* contents(input.path);
              grants?.delete(JSON.stringify(grant.selector));
            }
            const response = yield* queryHandlers.skills(context, context);
            const skill = response.data
              .flatMap((entry) => entry.skills)
              .find((item) => item.path === input.path);
            if (skill) return yield* contents(skill.path);
            return yield* pluginError(
              "not_found",
              "The skill was not found in the current inventory.",
            );
          },
          Effect.catch((error) =>
            Effect.succeed({
              status: "failed" as const,
              error: pluginFailure(error),
              contents: null,
              files: [],
            }),
          ),
        ),
        hooks: (context) =>
          request(context, "hooks/list", { cwds: [...context.cwds] }).pipe(
            Effect.map((response) => response as unknown as PluginQueries["hooks"]["output"]),
          ),
        "public-home": Effect.fn("PluginManager.publicHome")(function* (context) {
          const capabilities = yield* access(context);
          const inventory = yield* requireInventory(context);
          if (capabilities.publicHome) {
            const home = yield* service.home;
            return {
              source: "service",
              sections: mergePluginSections(
                home.sections.map((section) => ({
                  id: section.id,
                  title: section.title,
                  urlSlug: section.url_slug ?? null,
                  plugins: serviceRows(section.plugins, inventory),
                })),
              ),
            };
          }
          const response = yield* directory(context);
          return {
            source: "local",
            sections: buildLocalPluginSections(
              mergeInstalledRows(rows(response), inventory),
              response.featuredPluginIds,
            ),
          };
        }),
        category: Effect.fn("PluginManager.category")(function* (context, input): Effect.fn.Return<
          PluginPage,
          PluginManagementError
        > {
          const capabilities = yield* access(context);
          const inventory = yield* requireInventory(context);
          const response = yield* directory(context);
          const local = buildLocalPluginSections(
            mergeInstalledRows(rows(response), inventory),
            [],
          ).find((section) => section.id === `plugins-${input.slug}`);
          const supplement = (local?.plugins ?? []).filter((row) =>
            pluginMatchesSearch(row, input.search ?? ""),
          );
          if (!capabilities.category)
            return {
              rows: input.cursor == null ? supplement : [],
              nextCursor: null,
              category: { title: local?.title ?? input.slug },
            };
          const page = yield* service.category(input);
          const remote = serviceRows(page.plugins, inventory);
          return {
            rows:
              input.cursor == null
                ? dedupePluginRows([...remote.slice(0, 14), ...supplement, ...remote.slice(14)])
                : remote,
            nextCursor: page.pagination.next_page_token ?? null,
            category: {
              title: page.category?.title ?? page.category?.name ?? input.slug,
              ...(page.category?.description ? { description: page.category?.description } : {}),
            },
          };
        }),
        personal: Effect.fn("PluginManager.personal")(function* (context) {
          const response = yield* directory(context);
          const [created, shared] = yield* Effect.all([
            personalPage(context, { ...context, feed: "created" }, 9),
            personalPage(context, { ...context, feed: "shared" }, 9),
          ]);
          return groupPersonalPlugins(
            rows(response),
            created.rows.slice(0, 9),
            shared.rows.slice(0, 9),
          );
        }),
        "personal-page": personalPage,
        "marketplace-removal-preview": Effect.fn("PluginManager.removalPreview")(
          function* (context, input) {
            const raw = yield* installedRaw(context);
            if (
              raw.marketplaceLoadErrors.some(
                (error) =>
                  input.marketplacePath == null || error.marketplacePath === input.marketplacePath,
              )
            )
              return yield* pluginError(
                "inventory_unavailable",
                "Plugin inventory is incomplete. Refresh before changing plugins.",
              );
            if (protectedMarketplace(raw, input.marketplaceName))
              return yield* pluginError("protected", "This marketplace is managed by Nodex.");
            const catalog = yield* marketplaces(context);
            const marketplace = catalog.marketplaces.find(
              (item) =>
                item.name === input.marketplaceName &&
                (input.marketplacePath === undefined || item.path === input.marketplacePath),
            );
            if (!marketplace)
              return yield* pluginError("not_found", "The marketplace was not found.");
            const inventory = rows(raw);
            const selected = inventory.filter(
              (row) => row.marketplace.name === input.marketplaceName && row.summary.installed,
            );
            return {
              marketplaceName: input.marketplaceName,
              marketplacePath: marketplace.path,
              plugins: selected,
              pluginIds: selected.map((row) => row.nativeId),
              protected:
                !marketplace.canRemove ||
                protectedMarketplace(raw, input.marketplaceName) ||
                selected.some((row) => !row.canUninstall),
            };
          },
        ),
      };
      const removeMarketplace = Effect.fn("PluginManager.removeMarketplace")(function* (
        context: ResolvedPluginContext,
        input: PluginCommands["marketplace-remove"]["input"],
      ) {
        const previous = input.operationId ? removals.get(input.operationId) : undefined;
        if (input.operationId && !previous)
          return yield* pluginError("not_found", "The marketplace removal was not found.");
        if (previous) {
          if (
            !sameScope(previous.context, context) ||
            previous.progress.marketplaceName !== input.marketplaceName
          )
            return yield* pluginError(
              "account_changed",
              "The marketplace removal belongs to a different context.",
            );
          if (previous.progress.removed) return previous.progress;
        }
        const previewResult = yield* queryHandlers["marketplace-removal-preview"](
          context,
          input,
        ).pipe(Effect.result);
        if (Result.isFailure(previewResult)) {
          if (!previous) return yield* previewResult.failure;
          const progress = {
            ...previous.progress,
            outcome: failed(previewResult.failure),
            protected: previous.progress.protected || previewResult.failure.code === "protected",
          };
          removals.set(previous.progress.operationId, { context, progress });
          yield* emit("plugins", progress);
          return progress;
        }
        const preview = previewResult.success;
        const operationId =
          previous?.progress.operationId ??
          `marketplace:${context.hostGeneration}:${context.accountEpoch}:${++nextOperation}`;
        const completedPluginIds = [...(previous?.progress.completedPluginIds ?? [])];
        const save = (
          outcome: PluginMutationResult,
          removed = false,
        ): MarketplaceRemovalProgress => {
          const progress = {
            ...preview,
            context,
            phase: removed
              ? ("complete" as const)
              : outcome.status === "failed" ||
                  outcome.status === "protected" ||
                  outcome.status === "policy_denied"
                ? ("failed" as const)
                : ("uninstalling" as const),
            plugins: [
              ...new Map(
                [...(previous?.progress.plugins ?? []), ...(preview.plugins ?? [])].map((row) => [
                  row.nativeId,
                  row,
                ]),
              ).values(),
            ],
            operationId,
            pluginIds: [...new Set([...completedPluginIds, ...preview.pluginIds])],
            completedPluginIds: [...completedPluginIds],
            remainingPluginIds: preview.pluginIds.filter((id) => !completedPluginIds.includes(id)),
            removed,
            outcome,
          };
          removals.set(operationId, { context, progress });
          return progress;
        };
        return yield* Effect.gen(function* () {
          if (preview.pluginIds.some((id) => completedPluginIds.includes(id)))
            return save(
              failed(
                pluginError(
                  "inventory_unavailable",
                  "A removed plugin was reinstalled. Review the marketplace before continuing.",
                ),
              ),
            );
          if (preview.protected)
            return save(
              failed(pluginError("protected", "This marketplace contains required plugins.")),
            );
          yield* emit(
            "plugins",
            save({ status: "success", value: undefined, refreshFailures: [] }),
          );
          for (const pluginId of preview.pluginIds) {
            // Inventory, protection and context are checked again for every step and every resume.
            const row = yield* findPlugin(context, pluginId, true);
            if (!row.canUninstall)
              return save(
                failed(pluginError("policy_denied", "This plugin is required by policy.")),
              );
            const result = yield* uninstall(context, { ...context, pluginId }).pipe(
              Effect.catch((error) => Effect.succeed(failed(error))),
            );
            if (result.status !== "success" && result.status !== "success-with-refresh-warning") {
              const progress = save(result);
              yield* emit("plugins", progress);
              return progress;
            }
            if (!completedPluginIds.includes(pluginId)) completedPluginIds.push(pluginId);
            yield* emit("plugins", save(result));
          }
          const verified = yield* queryHandlers["marketplace-removal-preview"](context, input);
          if (verified.protected || verified.pluginIds.length)
            return save(
              failed(
                pluginError(
                  "inventory_unavailable",
                  "The marketplace changed during removal. Review it before continuing.",
                ),
              ),
            );
          yield* emit("plugins", {
            ...save({ status: "success", value: undefined, refreshFailures: [] }),
            phase: "removing",
          });
          yield* assertCurrent(context);
          yield* request(context, "marketplace/remove", { marketplaceName: input.marketplaceName });
          const progress = save(yield* applied(context, undefined), true);
          yield* emit("plugins", progress);
          return progress;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const progress = save(failed(error));
              yield* emit("plugins", progress);
              return progress;
            }),
          ),
        );
      });
      const uninstall = Effect.fn("PluginManager.uninstall")(function* (
        context: ResolvedPluginContext,
        input: PluginCommands["uninstall"]["input"],
      ): Effect.fn.Return<PluginMutationResult, PluginManagementError> {
        const row = yield* findPlugin(context, input.pluginId, true);
        if (!row.canUninstall)
          return failed(pluginError("policy_denied", "This plugin is required by policy."));
        yield* assertCurrent(context);
        const result = yield* withOperationLease(
          native
            .uninstall({
              plugin: row.nativeId,
              expectedGeneration: context.hostGeneration,
              cwds: context.cwds,
              isCurrent: assertCurrent(context).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              ),
            })
            .pipe(Effect.mapError(nativeFailure)),
        );
        if (result.status === "uninstalled") return yield* applied(context, undefined, false);
        if (result.status === "protected")
          return failed(pluginError("protected", "This desktop tool is managed by Nodex."));
        if (result.status === "outcome_unavailable") {
          const result = yield* applied(context, undefined, false);
          return {
            ...result,
            status: "success-with-refresh-warning" as const,
            refreshFailures: [
              ...new Set<PluginRefreshResource>(["plugins", ...result.refreshFailures]),
            ],
          };
        }
        return failed(
          pluginError("inventory_unavailable", "Plugin removal could not be confirmed."),
        );
      });
      const commandHandlers: {
        [K in keyof PluginCommands]: (
          context: ResolvedPluginContext,
          input: PluginCommands[K]["input"],
        ) => Effect.Effect<PluginCommands[K]["output"], PluginManagementError>;
      } = {
        "app-enabled": Effect.fn("PluginManager.setAppEnabled")(function* (context, input) {
          const view = yield* withOperationLease(
            apps.list(context, { ...context, appIds: [input.appId], forceRefresh: true }),
          );
          const app = view.apps.find(
            (app) => normalizeConnectorId(app.id) === normalizeConnectorId(input.appId),
          );
          if (!app || (!app.metadata && !app.runtime))
            return yield* pluginError("not_found", "The app was not found.");
          const config = yield* configRead(context);
          const policy = pluginAppPolicy(config, app.id, app.connectionState === "admin_disabled");
          if (policy.editRestriction)
            return yield* pluginError(policy.editRestriction.code, policy.editRestriction.message);
          yield* writeConfig(context, config, [
            {
              keyPath: `apps.${JSON.stringify(policy.configKey)}.enabled`,
              value: input.enabled,
              mergeStrategy: "upsert",
            },
          ]);
          return yield* applied(context, undefined, "apps");
        }),
        "plugin-hooks-trust": Effect.fn("PluginManager.trustAllPluginHooks")(
          function* (context, input) {
            const detail = yield* queryHandlers.read(context, input);
            if (!detail.summary.installed)
              return yield* pluginError(
                "not_found",
                "Install this plugin before trusting its hooks.",
              );
            if (detail.row.managed)
              return yield* pluginError("protected", "Nodex manages this plugin.");
            const inventory = yield* pluginHooks(context, detail.row.nativeId);
            if (!inventory.available)
              return yield* pluginError("unsupported", "Select a project to review plugin hooks.");
            const edits = inventory.hooks
              .filter(
                (hook) =>
                  !hook.isManaged &&
                  (hook.trustStatus === "untrusted" || hook.trustStatus === "modified"),
              )
              .map((hook): ConfigEdit => ({
                keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`,
                value: hook.currentHash,
                mergeStrategy: "upsert",
              }));
            if (edits.length) yield* writeConfig(context, yield* configRead(context), edits);
            return yield* applied(context, undefined, "hooks");
          },
        ),
        "plugin-mcp-enabled": Effect.fn("PluginManager.setPluginMcpEnabled")(
          function* (context, input) {
            const detail = yield* queryHandlers.read(context, input);
            const config = yield* configRead(context);
            const states = projectPluginMcpServers(
              detail.mcpServers,
              detail.row.nativeId,
              detail.summary.installed,
              detail.row.canSetEnabled,
              config,
              yield* mcpStatuses(context),
            );
            const server = states.find((entry) => entry.name === input.name);
            if (!server?.installed || server.configKey === null)
              return yield* pluginError(
                "not_found",
                "The installed MCP server configuration was not found.",
              );
            if (!server.canSetEnabled)
              return yield* pluginError("protected", "This MCP server cannot be changed.");
            const user = writablePluginConfigLayer(config);
            if (!user || user.name.type !== "user")
              return yield* pluginError(
                "inventory_unavailable",
                "Versioned user configuration is unavailable.",
              );
            yield* assertCurrent(context);
            const written = yield* request(context, "config/value/write", {
              keyPath: `mcp_servers.${JSON.stringify(server.configKey)}.enabled`,
              value: input.enabled,
              mergeStrategy: "upsert",
              filePath: user.name.file,
              expectedVersion: user.version,
            }).pipe(
              Effect.mapError((error) =>
                error.code === "mutation_outcome_unknown"
                  ? error
                  : pluginError(
                      "config_conflict",
                      "Settings changed. Refresh before trying again.",
                    ),
              ),
            );
            if (written.status === "okOverridden")
              return yield* pluginError(
                "policy_denied",
                "These settings are controlled by policy.",
              );
            return yield* applied(context, undefined, "mcp");
          },
        ),
        "app-disconnect": Effect.fn("PluginManager.disconnectApp")(function* (context, input) {
          yield* assertCurrent(context);
          yield* withOperationLease(apps.disconnect(context, input, assertCurrent(context)));
          return yield* applied(context, undefined, "apps");
        }),
        "mcp-save": (context, input) => updateMcp(context, input, "save"),
        "mcp-remove": (context, input) => updateMcp(context, input, "remove"),
        "mcp-enabled": (context, input) => updateMcp(context, input, "enabled"),
        "mcp-login": Effect.fn("PluginManager.loginMcp")(function* (context, input) {
          const servers = yield* queryHandlers["mcp-servers"](context, context);
          const server = servers.servers.find((server) => server.name === input.name);
          if (!server || !server.enabled)
            return yield* pluginError("not_found", "The enabled MCP server was not found.");
          yield* assertCurrent(context);
          const response = yield* request(context, "mcpServer/oauth/login", {
            name: input.name,
            clientRegistration: input.clientRegistration,
            scopes: input.scopes,
          });
          const url = yield* Effect.try({
            try: () => new URL(response.authorizationUrl),
            catch: () =>
              pluginError(
                "service_unavailable",
                "The MCP server returned an invalid authorization URL.",
              ),
          });
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            return yield* pluginError(
              "service_unavailable",
              "The MCP server returned an invalid authorization URL.",
            );
          return {
            status: "success" as const,
            value: {
              ...response,
              authorizationUrl: url.href,
              loginId: response.loginId ?? undefined,
            },
            refreshFailures: [],
          };
        }),
        "skill-install": Effect.fn("PluginManager.installSkill")(function* (context, input) {
          const root = input.scope === "user" ? null : (input.cwd ?? context.cwds[0]);
          if (input.scope === "project" && (!root || !context.cwds.includes(root)))
            return yield* pluginError(
              "project_unavailable",
              "Select an active Project source for this skill.",
            );
          const value = yield* withOperationLease(
            standaloneSkills.install(input.id, root ?? null, assertCurrent(context)),
          );
          return yield* applied(context, value, "skills");
        }),
        "skill-uninstall": Effect.fn("PluginManager.uninstallSkill")(function* (context, input) {
          const response = yield* queryHandlers.skills(context, context);
          const skill = response.data
            .flatMap((entry) => entry.skills)
            .find((skill) => skill.path === input.path);
          if (!skill) return yield* pluginError("not_found", "The standalone skill was not found.");
          yield* withOperationLease(
            standaloneSkills.uninstall(skill, context.cwds, assertCurrent(context)),
          );
          return yield* applied(context, undefined, "skills");
        }),
        "prepare-helper": Effect.fn("PluginManager.prepareHelper")(function* (context, input) {
          const capabilities = yield* queryHandlers["creation-capabilities"](context, context);
          const capability =
            input.helper === "plugin-creator"
              ? capabilities.createPlugin
              : capabilities.recordSkill;
          if (!capability.available || !capability.plugin)
            return yield* pluginError(
              capability.reason?.code ?? "not_found",
              capability.reason?.message ?? "This helper is unavailable.",
            );
          let detail = yield* queryHandlers.read(context, {
            ...context,
            ...capability.plugin.selector,
          });
          const refreshFailures: PluginRefreshResource[] = [];
          if (!detail.summary.installed) {
            const result = yield* commandHandlers.install(context, {
              ...context,
              ...detail.row.selector,
              installAttemptId: input.installAttemptId,
            });
            if ("error" in result) return result;
            refreshFailures.push(...result.refreshFailures);
            detail = yield* queryHandlers.read(context, { ...context, ...detail.row.selector });
          }
          if (!detail.summary.enabled) {
            const result = yield* commandHandlers["set-enabled"](context, {
              ...context,
              pluginId: detail.row.nativeId,
              enabled: true,
            });
            if ("error" in result) return result;
            refreshFailures.push(...result.refreshFailures);
            detail = yield* queryHandlers.read(context, { ...context, ...detail.row.selector });
          }
          if (
            !detail.summary.installed ||
            !detail.summary.enabled ||
            detail.summary.availability === "DISABLED_BY_ADMIN"
          )
            return yield* pluginError(
              "inventory_unavailable",
              "The helper could not be verified as enabled.",
            );
          const appIds = [
            ...new Set([
              ...detail.apps.map((app) => app.id),
              ...(input.helper === "plugin-creator" ? ["connector_openai_plugin_creator"] : []),
            ]),
          ];
          if (appIds.length) {
            const view = yield* withOperationLease(
              apps.list(context, { ...context, appIds, forceRefresh: true }),
            );
            for (const id of appIds) {
              const app = view.apps.find(
                (app) => normalizeConnectorId(app.id) === normalizeConnectorId(id),
              );
              if (app?.enabled && app.callable) continue;
              if (app?.connectionState === "admin_disabled")
                return yield* pluginError(
                  "policy_denied",
                  "A required app is disabled by your administrator.",
                );
              if (app?.runtime && !app.enabled)
                return yield* pluginError(
                  "invalid_input",
                  "Enable the helper's required apps before creating a draft.",
                );
              if (app?.connectionState === "connected")
                return yield* pluginError(
                  "inventory_unavailable",
                  "The helper's app is connected but is not callable by the agent.",
                  true,
                );
              if (view.connectionError)
                return yield* pluginError(
                  view.connectionError.code,
                  view.connectionError.message,
                  view.connectionError.retryable,
                );
              return yield* pluginError(
                "auth_required",
                "Connect the helper's required apps before creating a draft.",
              );
            }
          }
          yield* assertCurrent(context);
          const displayName = detail.summary.interface?.displayName ?? detail.summary.name;
          const label =
            input.helper === "plugin-creator"
              ? "Plugin Creator"
              : displayName.replaceAll("[", "").replaceAll("]", "");
          const prompt =
            input.helper === "plugin-creator"
              ? "help me create a plugin"
              : (detail.info.defaultPrompts.find((prompt) => prompt.trim()) ??
                "help me record a skill");
          const failures = [...new Set(refreshFailures)];
          return {
            status: failures.length
              ? ("success-with-refresh-warning" as const)
              : ("success" as const),
            value: {
              nativeId: detail.row.nativeId,
              displayName,
              draft: `[@${label}](plugin://${detail.row.nativeId}) ${prompt}`,
            },
            refreshFailures: failures,
          };
        }),
        install: Effect.fn("PluginManager.install")(function* (context, input) {
          const detail = yield* queryHandlers.read(context, input);
          if (detail.row.managed || !policy.visible(detail.row.nativeId, "local"))
            return failed(pluginError("protected", "This desktop tool is managed by Nodex."));
          if (
            detail.summary.availability === "DISABLED_BY_ADMIN" ||
            detail.summary.installPolicy === "NOT_AVAILABLE"
          )
            return failed(
              pluginError("policy_denied", "This plugin is unavailable for installation."),
            );
          yield* assertCurrent(context);
          const result = yield* request(context, "plugin/install", {
            marketplacePath: input.marketplacePath ?? null,
            remoteMarketplaceName: input.remoteMarketplaceName ?? null,
            pluginName: input.pluginName,
            installAttemptId: input.installAttemptId,
          });
          return yield* applied(context, result as unknown as PluginInstallResponse);
        }),
        uninstall,
        "set-enabled": Effect.fn("PluginManager.setEnabled")(function* (context, input) {
          const row = yield* findPlugin(context, input.pluginId, true);
          if (!row.canSetEnabled)
            return failed(pluginError("policy_denied", "This plugin is disabled by policy."));
          yield* assertCurrent(context);
          if (row.summary.source.type === "remote") {
            if (!(yield* access(context)).remoteToggle)
              return failed(pluginError("unsupported", "Remote plugin settings are unavailable."));
            yield* service.setEnabled(row.stableIdentity, input.enabled);
          } else {
            const config = yield* configRead(context);
            yield* writeConfig(context, config, [
              {
                keyPath: `plugins.${JSON.stringify(row.nativeId)}.enabled`,
                value: input.enabled,
                mergeStrategy: "replace",
              },
            ]);
          }
          return yield* applied(context, undefined);
        }),
        "skill-enabled": Effect.fn("PluginManager.setSkillEnabled")(function* (context, input) {
          const inventory = yield* queryHandlers.skills(context, context);
          const matches = inventory.data
            .flatMap((entry) => entry.skills)
            .filter((skill) =>
              input.path !== undefined ? skill.path === input.path : skill.name === input.name,
            );
          if (!matches.length) return failed(pluginError("not_found", "The skill was not found."));
          const pluginInventory = yield* requireInventory(context);
          const protectedRoots = pluginInventory
            .filter((row) => row.managed && row.summary.source.type === "local")
            .map((row) =>
              row.summary.source.type === "local"
                ? row.summary.source.path.replaceAll("\\", "/").replace(/\/+$/u, "")
                : "",
            );
          if (
            matches.some((skill) =>
              protectedRoots.some((root) =>
                skill.path.replaceAll("\\", "/").startsWith(`${root}/`),
              ),
            )
          )
            return failed(pluginError("protected", "This skill is managed by Nodex."));
          if (
            matches.some(
              (skill) =>
                skill.pluginId &&
                (policy.managed(skill.pluginId, "local") ||
                  !policy.visible(skill.pluginId, "local")),
            )
          )
            return failed(pluginError("protected", "This skill is managed by Nodex."));
          if (matches.some((skill) => skill.scope === "admin"))
            return failed(
              pluginError("policy_denied", "This skill is managed by your administrator."),
            );
          yield* assertCurrent(context);
          yield* request(context, "skills/config/write", {
            path: input.path ?? null,
            name: input.name ?? null,
            enabled: input.enabled,
          });
          return yield* applied(context, undefined, "skills");
        }),
        "marketplace-add": Effect.fn("PluginManager.addMarketplace")(function* (context, input) {
          yield* assertCurrent(context);
          return yield* applied(
            context,
            yield* request(context, "marketplace/add", {
              source: input.source,
              refName: input.refName ?? null,
              sparsePaths: input.sparsePaths ?? null,
            }),
          );
        }),
        "marketplace-remove": removeMarketplace,
        "marketplace-upgrade": Effect.fn("PluginManager.upgradeMarketplaces")(
          function* (context, input) {
            const directoryResponse = yield* directoryRaw(context);
            const configured = yield* marketplaces(context);
            if (
              input.marketplaceName != null &&
              !configured.marketplaces.some((m) => m.name === input.marketplaceName && m.canUpgrade)
            )
              return failed(
                pluginError("protected", "Only configured Git marketplaces can be upgraded."),
              );
            const selected = configured.marketplaces.filter(
              (m) =>
                m.canUpgrade && (input.marketplaceName == null || m.name === input.marketplaceName),
            );
            const result: MarketplaceUpgradeResponse = {
              selectedMarketplaces: [],
              upgradedRoots: [],
              errors: [],
            };
            for (const name of new Set(selected.map((m) => m.name))) {
              if (protectedMarketplace(directoryResponse, name))
                return failed(pluginError("protected", "This marketplace is managed by Nodex."));
              yield* assertCurrent(context);
              const upgraded = yield* request(context, "marketplace/upgrade", {
                marketplaceName: name,
              });
              result.selectedMarketplaces.push(...upgraded.selectedMarketplaces);
              result.upgradedRoots.push(...upgraded.upgradedRoots);
              result.errors.push(...upgraded.errors);
            }
            if (result.errors.length) {
              if (result.upgradedRoots.length) {
                yield* emit("plugins");
                yield* reload(context);
              }
              return {
                status: "failed" as const,
                error: {
                  code: "service_unavailable" as const,
                  message: "Some marketplaces could not be upgraded.",
                  retryable: true,
                  marketplaceErrors: result.errors,
                },
              };
            }
            return yield* applied(context, result);
          },
        ),
        refresh: (context) => applied(context, undefined),
      };
      return PluginManager.of({
        changes: Stream.fromPubSub(events),
        query: Effect.fn("PluginManager.query")(function* <K extends keyof PluginQueries>(
          name: K,
          input: PluginQueries[K]["input"],
        ) {
          const lease = yield* auth.backendLease(input.hostId);
          const context = yield* resolve(input);
          const expected = yield* captureAccount;
          const value = yield* queryHandlers[name](context, input).pipe(
            Effect.flatMap((value) =>
              [
                "list",
                "installed",
                "search",
                "public-home",
                "category",
                "personal",
                "personal-page",
              ].includes(name)
                ? hydrateAppConnections(context, value)
                : Effect.succeed(value),
            ),
            Effect.provideService(PluginServiceAccount, expected),
            Effect.provideService(PluginOperationLease, lease),
          );
          yield* assertCurrent(context);
          if (lease.aborted)
            return yield* pluginError("account_changed", "The authenticated account changed.");
          if (name === "read") {
            const detail = value as PluginQueries["read"]["output"];
            const read = input as PluginQueries["read"]["input"];
            const selector: PluginSelector =
              read.marketplacePath !== undefined
                ? { marketplacePath: read.marketplacePath, pluginName: read.pluginName }
                : {
                    remoteMarketplaceName: read.remoteMarketplaceName,
                    pluginName: read.pluginName,
                  };
            const scope = skillGrantScope(context, expected);
            const grants = detailSkillGrants.get(scope) ?? new Map();
            grants.set(JSON.stringify(selector), {
              selector,
              nativeId: detail.row.nativeId,
              paths: new Set(
                detail.skills.flatMap((skill) =>
                  skill.path && skillManifestPath(skill.path) ? [skill.path] : [],
                ),
              ),
            });
            detailSkillGrants.set(scope, grants);
          }
          return value;
        }),
        command: <K extends keyof PluginCommands>(name: K, input: PluginCommands[K]["input"]) =>
          lane
            .withPermits(1)(
              Effect.gen(function* () {
                const lease = yield* auth.backendLease(input.hostId);
                const context = yield* resolve(input);
                if (lease.aborted)
                  return yield* pluginError(
                    "account_changed",
                    "The authenticated account changed.",
                  );
                const expected = yield* captureAccount;
                const value = yield* commandHandlers[name](context, input).pipe(
                  Effect.provideService(PluginServiceAccount, expected),
                  Effect.provideService(PluginOperationLease, lease),
                  Effect.tapError((error) =>
                    error.code === "mutation_outcome_unknown"
                      ? installed(context).pipe(Effect.ignore)
                      : Effect.void,
                  ),
                );
                if (lease.aborted)
                  return yield* pluginError(
                    "account_changed",
                    "The authenticated account changed.",
                  );
                return value;
              }),
            )
            .pipe(
              Effect.catch((error) =>
                Effect.succeed(
                  (name === "marketplace-remove"
                    ? {
                        marketplaceName: (input as PluginCommands["marketplace-remove"]["input"])
                          .marketplaceName,
                        pluginIds: [],
                        protected: error.code === "protected",
                        operationId:
                          (input as PluginCommands["marketplace-remove"]["input"]).operationId ??
                          "",
                        completedPluginIds: [],
                        remainingPluginIds: [],
                        removed: false,
                        outcome: failed(error),
                      }
                    : failed(error)) as PluginCommands[K]["output"],
                ),
              ),
            ),
      });
    }),
  );

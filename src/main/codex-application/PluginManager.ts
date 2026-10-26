import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as FileSystem from "effect/FileSystem";
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
const nativeFailure = (cause: { reason?: string; message?: string; cause?: unknown }) => {
  if (
    cause.reason === "outcome-unknown" ||
    cause.reason === "timeout" ||
    cause.reason === "session-lost"
  )
    return pluginError(
      "mutation_outcome_unknown",
      "The plugin operation could not be confirmed. Refresh before trying again.",
    );
  return pluginError("service_unavailable", "The plugin operation could not be completed.", true);
};
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
      const fs = yield* FileSystem.FileSystem;
      const policy = createPluginInventoryPolicy(options.runtimeStateHome);
      const epoch = yield* Ref.make(0);
      const events = yield* PubSub.unbounded<PluginManagementChanged>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(events));
      const lane = yield* Semaphore.make(1);
      const removals = new Map<
        string,
        { context: ResolvedPluginContext; progress: MarketplaceRemovalProgress }
      >();
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
              yield* Ref.update(epoch, (n) => n + 1);
              yield* emit("connection");
              return;
            }
            if (event.hostId !== "local") return;
            if (event.value.method === "account/updated") {
              yield* Ref.update(epoch, (n) => n + 1);
              yield* emit("account");
              return;
            }
            const method: string = event.value.method;
            if (method === "skills/changed" || method === "codex/event/skills_update_available")
              yield* emit("skills");
            else if (method === "app/list/updated" || method === "mcpServer/oauthLogin/completed")
              yield* emit("apps");
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
      const reload = Effect.fn("PluginManager.reload")(function* (context: ResolvedPluginContext) {
        const failures: PluginRefreshResource[] = [];
        const settle = <A>(
          resource: PluginRefreshResource,
          effect: Effect.Effect<A, PluginManagementError>,
        ) =>
          effect.pipe(
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
        yield* settle("apps", request(context, "app/list", { forceRefetch: true }));
        yield* settle("hooks", request(context, "hooks/list", { cwds: [...context.cwds] }));
        yield* settle("mcp", request(context, "mcpServerStatus/list", {}));
        return failures;
      });
      const applied = Effect.fn("PluginManager.applied")(function* <A>(
        context: ResolvedPluginContext,
        value: A,
        notify = true,
      ) {
        if (notify) yield* emit("plugins");
        const refreshFailures = yield* reload(context);
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
      const queryHandlers: {
        [K in keyof PluginQueries]: (
          context: ResolvedPluginContext,
          input: PluginQueries[K]["input"],
        ) => Effect.Effect<PluginQueries[K]["output"], PluginManagementError>;
      } = {
        marketplaces: () =>
          Effect.fail(pluginError("unsupported", "Marketplace settings are unavailable.")),
        apps: () => Effect.fail(pluginError("unsupported", "App settings are unavailable.")),
        "mcp-servers": () =>
          Effect.fail(pluginError("unsupported", "MCP settings are unavailable.")),
        "recommended-skills": () =>
          Effect.fail(pluginError("unsupported", "Recommended skills are unavailable.")),
        "creation-capabilities": () =>
          Effect.fail(pluginError("unsupported", "Plugin creation is unavailable.")),
        "plugin-hooks": () =>
          Effect.fail(pluginError("unsupported", "Plugin hooks are unavailable.")),
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
          return {
            detail: { ...detail, summary: row.summary },
            row,
            summary: row.summary,
            description: detail.description,
            skills: detail.skills,
            apps: detail.apps,
            mcpServers: detail.mcpServers,
            hooks: detail.hooks,
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
        "skill-contents": Effect.fn("PluginManager.skillContents")(function* (context, input) {
          if ("remotePluginId" in input)
            return yield* request(context, "plugin/skill/read", {
              remoteMarketplaceName: input.remoteMarketplaceName,
              remotePluginId: input.remotePluginId,
              skillName: input.skillName,
            }).pipe(Effect.map((response) => ({ contents: response.contents ?? null })));
          const response = yield* queryHandlers.skills(context, context);
          const skill = response.data
            .flatMap((entry) => entry.skills)
            .find((item) => item.path === input.path);
          const contents = (path: string) =>
            fs.readFileString(path).pipe(
              Effect.map((contents) => ({ contents })),
              Effect.mapError(() =>
                pluginError("not_found", "The skill contents are unavailable."),
              ),
            );
          if (skill) return yield* contents(skill.path);
          // Inactive plugins do not contribute to skills/list. Current native details
          // authorize their exact skill files without admitting arbitrary filesystem reads.
          const catalog = yield* directory(context);
          const plugins = dedupePluginRows([
            ...(yield* requireInventory(context)),
            ...rows(catalog),
          ]);
          for (const row of plugins) {
            if (row.marketplace.path === null) continue;
            const detail = yield* queryHandlers.read(context, { ...context, ...row.selector });
            const pluginSkill = detail.skills.find((item) => item.path === input.path);
            if (pluginSkill?.path) return yield* contents(pluginSkill.path);
          }
          if (catalog.marketplaceLoadErrors.length)
            return yield* pluginError("inventory_unavailable", "Plugin inventory is incomplete.");
          return yield* pluginError(
            "not_found",
            "The skill was not found in the current inventory.",
          );
        }),
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
            if (raw.marketplaceLoadErrors.length)
              return yield* pluginError(
                "inventory_unavailable",
                "Plugin inventory is incomplete. Refresh before changing plugins.",
              );
            const inventory = rows(raw);
            const selected = inventory.filter(
              (row) => row.marketplace.name === input.marketplaceName && row.summary.installed,
            );
            return {
              marketplaceName: input.marketplaceName,
              pluginIds: selected.map((row) => row.nativeId),
              protected:
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
        const preview = yield* queryHandlers["marketplace-removal-preview"](context, input);
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
        "app-disconnect": () =>
          Effect.fail(pluginError("unsupported", "This operation is unavailable.")),
        "mcp-save": () => Effect.fail(pluginError("unsupported", "This operation is unavailable.")),
        "mcp-remove": () =>
          Effect.fail(pluginError("unsupported", "This operation is unavailable.")),
        "mcp-enabled": () =>
          Effect.fail(pluginError("unsupported", "This operation is unavailable.")),
        "mcp-login": () =>
          Effect.fail(pluginError("unsupported", "This operation is unavailable.")),
        "skill-install": () =>
          Effect.fail(pluginError("unsupported", "This operation is unavailable.")),
        "skill-uninstall": () =>
          Effect.fail(pluginError("unsupported", "This operation is unavailable.")),
        "prepare-helper": () =>
          Effect.fail(pluginError("unsupported", "This operation is unavailable.")),
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
            const config = (yield* request(context, "config/read", {
              includeLayers: true,
              cwd: context.cwds[0] ?? null,
            })) as unknown as ConfigReadResponse;
            const userLayer = config.layers?.findLast(
              (layer) =>
                layer.name.type === "user" &&
                layer.name.profile == null &&
                layer.disabledReason == null,
            );
            if (!userLayer || userLayer.name.type !== "user")
              return failed(
                pluginError(
                  "inventory_unavailable",
                  "Versioned user configuration is unavailable.",
                ),
              );
            const written = yield* request(context, "config/batchWrite", {
              edits: [
                {
                  keyPath: `plugins.${row.nativeId}.enabled`,
                  value: input.enabled,
                  mergeStrategy: "replace",
                },
              ],
              filePath: userLayer.name.file,
              expectedVersion: userLayer.version,
              reloadUserConfig: true,
            }).pipe(
              Effect.mapError((error) =>
                error.code === "mutation_outcome_unknown"
                  ? error
                  : pluginError(
                      "config_conflict",
                      "Plugin settings changed. Refresh before trying again.",
                    ),
              ),
            );
            if (written.status === "okOverridden")
              return failed(
                pluginError("policy_denied", "Plugin enablement is controlled by policy."),
              );
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
          return yield* applied(context, undefined);
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
            if (protectedMarketplace(directoryResponse, input.marketplaceName))
              return failed(pluginError("protected", "This marketplace is managed by Nodex."));
            const result = (yield* request(context, "marketplace/upgrade", {
              marketplaceName: input.marketplaceName ?? null,
            })) as unknown as MarketplaceUpgradeResponse;
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
            Effect.provideService(PluginServiceAccount, expected),
            Effect.provideService(PluginOperationLease, lease),
          );
          yield* assertCurrent(context);
          if (lease.aborted)
            return yield* pluginError("account_changed", "The authenticated account changed.");
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

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  PluginContext,
  PluginRow,
  PluginSummary,
  PluginManagementChanged,
  PluginCommands,
  PluginMutationResult,
  SkillEnabledSelector,
} from "../../shared/codex-plugin-management";
import { pluginActionState } from "../../shared/codex-plugin-management-model";
import { pluginManagementKeys } from "./plugin-management-query-keys";
import { queryKeys } from "./query-keys";
import {
  commandPluginManagement,
  subscribePluginManagement,
  subscribePluginProjectChanges,
} from "./plugin-management-adapter";

export type PluginPatch = {
  readonly installed?: boolean;
  readonly enabled?: boolean;
  readonly pending?: boolean;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function mapInventoryData(
  value: unknown,
  transform: (value: Record<string, unknown>) => unknown,
): unknown {
  if (Array.isArray(value)) return value.map((item) => mapInventoryData(item, transform));
  if (!record(value)) return value;
  const mapped = transform(value);
  if (mapped !== undefined) return mapped;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mapInventoryData(item, transform)]),
  );
}
/** Only protocol summaries and derived rows are patched; cursors, errors and scope stay intact. */
export function patchPluginData(value: unknown, identity: string, patch: PluginPatch): unknown {
  return mapInventoryData(value, (node) => {
    if ("summary" in node && "stableIdentity" in node) {
      const row = node as unknown as PluginRow;
      if (row.nativeId !== identity && row.stableIdentity !== identity) return node;
      const summary = {
        ...row.summary,
        ...(patch.installed === undefined ? {} : { installed: patch.installed }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      };
      const installState = summary.installed ? "installed" : "not_installed";
      return {
        ...row,
        summary,
        installState,
        canUninstall:
          summary.installed && !row.managed && summary.installPolicy !== "INSTALLED_BY_DEFAULT",
        canSetEnabled:
          summary.installed && !row.managed && summary.availability !== "DISABLED_BY_ADMIN",
        actionState: pluginActionState(summary, installState, patch.pending),
      };
    }
    if (!("installed" in node && "id" in node && "source" in node)) return undefined;
    const summary = node as unknown as PluginSummary;
    if (
      summary.id !== identity &&
      summary.remotePluginId !== identity &&
      summary.shareContext?.remotePluginId !== identity
    )
      return node;
    return {
      ...node,
      ...(patch.installed === undefined ? {} : { installed: patch.installed }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    };
  });
}
const patchSkillData = (value: unknown, selector: SkillEnabledSelector): unknown =>
  mapInventoryData(value, (node) => {
    if (
      typeof node.name !== "string" ||
      typeof node.enabled !== "boolean" ||
      typeof node.path !== "string"
    )
      return undefined;
    const matches =
      selector.path !== undefined ? node.path === selector.path : node.name === selector.name;
    return matches ? { ...node, enabled: selector.enabled } : node;
  });
const resourcesForChange = (kind: PluginManagementChanged["kind"]): readonly string[] | null => {
  if (kind === "hooks") return ["hooks", "plugin-hooks", "read"];
  if (kind === "skills")
    return ["skills", "recommended-skills", "skill-contents", "read", "creation-capabilities"];
  if (kind === "apps")
    return [
      "apps",
      "read",
      "list",
      "installed",
      "public-home",
      "category",
      "personal",
      "personal-page",
      "search",
      "creation-capabilities",
    ];
  if (kind === "mcp") return ["mcp-servers", "apps", "read"];
  return null;
};
export async function invalidatePluginManagement(
  client: QueryClient,
  hostId: string,
  kind: PluginManagementChanged["kind"] = "plugins",
): Promise<void> {
  const resources = resourcesForChange(kind);
  const composer =
    kind === "mcp" || kind === "hooks"
      ? []
      : [queryKeys.codexComposerPlugins.all(), queryKeys.codexComposerSkills.all()];
  await Promise.all([
    client.invalidateQueries({
      queryKey: pluginManagementKeys.all(hostId),
      predicate: (query) => resources === null || resources.includes(String(query.queryKey[7])),
    }),
    ...composer.map((queryKey) =>
      client.invalidateQueries({ queryKey, predicate: (query) => query.queryKey[2] === hostId }),
    ),
    ...(kind === "skills" || kind === "hooks"
      ? []
      : [
          client.invalidateQueries({ queryKey: queryKeys.mcp.apps() }),
          client.invalidateQueries({ queryKey: queryKeys.mcp.statuses() }),
        ]),
  ]);
}
const changeForCommand = (name: keyof PluginCommands): PluginManagementChanged["kind"] => {
  if (name === "plugin-hooks-trust") return "hooks";
  if (name === "plugin-mcp-enabled") return "mcp";
  if (["skill-enabled", "skill-install", "skill-uninstall"].includes(name)) return "skills";
  if (["mcp-save", "mcp-remove", "mcp-enabled", "mcp-login"].includes(name)) return "mcp";
  if (name === "app-disconnect") return "apps";
  return "plugins";
};
const accountRevisions = new WeakMap<QueryClient, Map<string, number>>();
const accountRevision = (client: QueryClient, hostId: string) =>
  accountRevisions.get(client)?.get(hostId) ?? 0;
export function applyPluginManagementEvent(
  client: QueryClient,
  event: PluginManagementChanged,
): void {
  if (event.progress || event.mcpOauthCompletion) {
    for (const [key] of client.getQueriesData({
      queryKey: ["plugin-management-context", event.hostId],
    })) {
      const capabilities =
        client.getQueryData<import("../../shared/codex-plugin-management").ResolvedPluginContext>(
          key,
        );
      const progressContext = event.progress?.context;
      if (
        capabilities &&
        capabilities.accountEpoch === event.accountEpoch &&
        (event.hostGeneration === undefined ||
          capabilities.hostGeneration === event.hostGeneration) &&
        (!progressContext ||
          JSON.stringify(pluginManagementKeys.scope(progressContext)) ===
            JSON.stringify(pluginManagementKeys.scope(capabilities)))
      ) {
        if (event.mcpOauthCompletion)
          client.setQueryData(
            pluginManagementKeys.resource(capabilities, "mcp-oauth-completion"),
            event.mcpOauthCompletion,
          );
        if (!event.progress) continue;
        client.setQueryData(
          pluginManagementKeys.resource(capabilities, "marketplace-progress", null),
          event.progress,
        );
        client.setQueryData(
          pluginManagementKeys.resource(
            capabilities,
            "marketplace-progress",
            event.progress.operationId,
          ),
          event.progress,
        );
      }
    }
  }
  if (event.kind === "account" || event.kind === "connection") {
    const revisions = accountRevisions.get(client) ?? new Map<string, number>();
    revisions.set(event.hostId, accountRevision(client, event.hostId) + 1);
    accountRevisions.set(client, revisions);
    void client.cancelQueries({ queryKey: pluginManagementKeys.all(event.hostId) });
    client.removeQueries({ queryKey: pluginManagementKeys.all(event.hostId) });
    for (const queryKey of [
      queryKeys.codexComposerPlugins.all(),
      queryKeys.codexComposerSkills.all(),
    ]) {
      void client.cancelQueries({
        queryKey,
        predicate: (query) => query.queryKey[2] === event.hostId,
      });
      client.removeQueries({ queryKey, predicate: (query) => query.queryKey[2] === event.hostId });
    }
    client.removeQueries({ queryKey: queryKeys.mcp.apps() });
    client.removeQueries({ queryKey: queryKeys.mcp.statuses() });
    void client.resetQueries({ queryKey: ["plugin-management-context", event.hostId] });
    void client.resetQueries({ queryKey: ["plugin-management-capabilities", event.hostId] });
  }
  void invalidatePluginManagement(client, event.hostId, event.kind);
}
const subscriptions = new WeakMap<QueryClient, { count: number; release: () => void }>();
export function acquirePluginManagementSubscription(client: QueryClient): () => void {
  let subscription = subscriptions.get(client);
  if (!subscription) {
    const releaseInventory = subscribePluginManagement((event) =>
      applyPluginManagementEvent(client, event),
    );
    const releaseProjects = subscribePluginProjectChanges((event) => {
      if (!["sources", "lifecycle", "delete"].includes(event.changeType)) return;
      const matches = (query: { queryKey: QueryKey }) =>
        event.projectId === undefined || query.queryKey[4] === event.projectId;
      void client.cancelQueries({ queryKey: ["plugin-management"], predicate: matches });
      client.removeQueries({ queryKey: ["plugin-management"], predicate: matches });
      for (const prefix of ["plugin-management-context", "plugin-management-capabilities"])
        void client.resetQueries({
          queryKey: [prefix],
          predicate: (query) =>
            event.projectId === undefined || query.queryKey[2] === event.projectId,
        });
    });
    subscription = {
      count: 0,
      release: () => {
        releaseInventory();
        releaseProjects();
      },
    };
    subscriptions.set(client, subscription);
  }
  subscription.count++;
  return () => {
    if (--subscription.count > 0) return;
    subscription.release();
    subscriptions.delete(client);
  };
}
const findRow = (value: unknown, predicate: (row: PluginRow) => boolean): PluginRow | undefined => {
  if (Array.isArray(value)) return value.map((item) => findRow(item, predicate)).find(Boolean);
  if (!record(value)) return undefined;
  if ("stableIdentity" in value && "summary" in value)
    return predicate(value as unknown as PluginRow) ? (value as unknown as PluginRow) : undefined;
  return Object.values(value)
    .map((item) => findRow(item, predicate))
    .find(Boolean);
};
const succeeded = (
  result: PluginMutationResult<unknown>,
): result is Extract<
  PluginMutationResult<unknown>,
  { status: "success" | "success-with-refresh-warning" }
> => result.status === "success" || result.status === "success-with-refresh-warning";
export async function runPluginMutation<K extends keyof PluginCommands>(
  client: QueryClient,
  context: PluginContext,
  name: K,
  input: Omit<PluginCommands[K]["input"], keyof PluginContext>,
): Promise<PluginCommands[K]["output"]> {
  const revision = accountRevision(client, context.hostId);
  const queryKey = pluginManagementKeys.all(context.hostId);
  const failure = (
    code: "account_changed" | "mutation_outcome_unknown",
    message: string,
  ): PluginCommands[K]["output"] => {
    const error = { code, message, retryable: false };
    return (
      name === "marketplace-remove"
        ? {
            marketplaceName: "marketplaceName" in input ? input.marketplaceName : "",
            operationId: "operationId" in input ? (input.operationId ?? "") : "",
            pluginIds: [],
            completedPluginIds: [],
            remainingPluginIds: [],
            protected: false,
            removed: false,
            outcome: { status: "failed", error },
          }
        : { status: "failed", error }
    ) as PluginCommands[K]["output"];
  };
  await client.cancelQueries({ queryKey });
  if (name === "mcp-login")
    for (const [key] of client.getQueriesData({ queryKey })) {
      if (key[7] === "mcp-oauth-completion") client.setQueryData(key, null);
    }
  const snapshots = client.getQueriesData({ queryKey });
  const touched: typeof snapshots = [];
  if (name === "skill-enabled")
    for (const snapshot of snapshots) {
      if (!["skills", "read"].includes(String(snapshot[0][7]))) continue;
      touched.push(snapshot);
      client.setQueryData(snapshot[0], (current: unknown) =>
        patchSkillData(current, input as unknown as SkillEnabledSelector),
      );
    }
  const id = "pluginId" in input && typeof input.pluginId === "string" ? input.pluginId : undefined;
  const target =
    id ??
    snapshots
      .map(([, value]) =>
        findRow(
          value,
          (row) =>
            "pluginName" in input &&
            row.selector.pluginName === input.pluginName &&
            ("marketplacePath" in input
              ? row.selector.marketplacePath === input.marketplacePath
              : "remoteMarketplaceName" in input &&
                row.selector.remoteMarketplaceName === input.remoteMarketplaceName),
        ),
      )
      .find(Boolean)?.nativeId;
  const optimistic: PluginPatch =
    name === "set-enabled" && "enabled" in input
      ? { enabled: Boolean(input.enabled) }
      : { pending: true };
  if (target && (name === "install" || name === "uninstall" || name === "set-enabled"))
    for (const snapshot of snapshots) {
      if (!findRow(snapshot[1], (row) => row.nativeId === target || row.stableIdentity === target))
        continue;
      touched.push(snapshot);
      client.setQueryData(snapshot[0], (current: unknown) =>
        patchPluginData(current, target, optimistic),
      );
    }
  const rollback = () => {
    if (accountRevision(client, context.hostId) !== revision) return;
    for (const [key, value] of touched)
      if (client.getQueryState(key)) client.setQueryData(key, value);
  };
  try {
    const result = await commandPluginManagement(name, {
      ...context,
      ...input,
    } as PluginCommands[K]["input"]);
    if (accountRevision(client, context.hostId) !== revision)
      return failure("account_changed", "The authenticated account changed.");
    if ("status" in result) {
      if (!succeeded(result)) {
        if (result.error.code !== "mutation_outcome_unknown") rollback();
        await invalidatePluginManagement(client, context.hostId, changeForCommand(name));
        return result;
      }
      if (name === "skill-install" && "id" in input && typeof input.id === "string") {
        const installedId = input.id;
        const scope = client.getQueryData<
          import("../../shared/codex-plugin-management").ResolvedPluginContext
        >(pluginManagementKeys.context(context));
        if (scope)
          client.setQueryData<readonly string[]>(
            pluginManagementKeys.resource(scope, "recommended-installs"),
            (previous) => [...new Set([...(previous ?? []), installedId])],
          );
      }
      if (target) {
        const patch =
          name === "install"
            ? { installed: true, enabled: true }
            : name === "uninstall"
              ? { installed: false, enabled: false }
              : optimistic;
        for (const [key] of snapshots)
          if (client.getQueryState(key))
            client.setQueryData(key, (current: unknown) =>
              patchPluginData(current, target, { ...patch, pending: false }),
            );
        if (name === "install") {
          const candidate = snapshots
            .map(([, value]) =>
              findRow(value, (row) => row.nativeId === target || row.stableIdentity === target),
            )
            .find(Boolean);
          if (candidate)
            for (const [key] of snapshots) {
              if (key[7] !== "installed") continue;
              client.setQueryData(key, (current: unknown) => {
                if (
                  !record(current) ||
                  !Array.isArray(current.rows) ||
                  findRow(current.rows, (row) => row.stableIdentity === candidate.stableIdentity)
                )
                  return current;
                return {
                  ...current,
                  rows: [
                    ...current.rows,
                    patchPluginData(candidate, target, {
                      installed: true,
                      enabled: true,
                      pending: false,
                    }),
                  ],
                };
              });
            }
        }
      }
    }
    await invalidatePluginManagement(client, context.hostId, changeForCommand(name));
    return result;
  } catch {
    await invalidatePluginManagement(client, context.hostId, changeForCommand(name));
    return failure(
      "mutation_outcome_unknown",
      "The plugin operation could not be confirmed. Refresh before trying again.",
    );
  }
}

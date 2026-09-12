import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { CodexThreadTitleReadOnlyAppTool } from "../codex/thread-title-generator";
import { CodexGateway } from "../codex-runtime/CodexGateway";

const TITLE_APP_INVENTORY_TIMEOUT_MS = 30_000;
const TITLE_APP_PAGE_SIZE = 1_000;
const TITLE_MCP_PAGE_SIZE = 100;
const CODEX_APPS_SERVER = "codex_apps";
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()\]]+/gu;
const RESOURCE_PATTERN = /\b(?:app|plugin):\/\/[^\s<>()\]]+/gu;

type TitleAppInfo = ClientRequestResponsesByMethod["app/list"]["data"][number];
type TitleMcpServerStatus = ClientRequestResponsesByMethod["mcpServerStatus/list"]["data"][number];
type TitleMcpTool = NonNullable<TitleMcpServerStatus["tools"][string]>;

const TITLE_APP_HOSTS: readonly {
  readonly appId: string;
  readonly hostnames: readonly string[];
}[] = [
  { appId: "box", hostnames: ["box.com"] },
  { appId: "dropbox", hostnames: ["dropbox.com"] },
  { appId: "google-calendar", hostnames: ["calendar.google.com"] },
  { appId: "google-drive", hostnames: ["docs.google.com"] },
  { appId: "google-drive", hostnames: ["drive.google.com"] },
  { appId: "figma", hostnames: ["figma.com"] },
  { appId: "github", hostnames: ["github.com"] },
  { appId: "linear", hostnames: ["linear.app"] },
  { appId: "gmail", hostnames: ["mail.google.com"] },
  { appId: "notion", hostnames: ["app.notion.com", "notion.so"] },
  { appId: "salesforce", hostnames: ["force.com", "salesforce.com"] },
  { appId: "google-drive", hostnames: ["sheets.google.com"] },
  { appId: "sharepoint", hostnames: ["sharepoint.com", "sharepoint.de"] },
  { appId: "slack", hostnames: ["slack.com"] },
  { appId: "google-drive", hostnames: ["slides.google.com"] },
] as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalizeAppAlias = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((part) => part.length > 0)
    .join("-")
    .replace(/^connector-/u, "")
    .replace(/-mcp-server$/u, "");

const uniqueAppMatch = (apps: readonly TitleAppInfo[], value: string): TitleAppInfo | null => {
  const normalized = value.trim().toLowerCase();
  const byId = apps.filter((app) => app.id.trim().toLowerCase() === normalized);
  if (byId.length > 0) return byId.length === 1 ? (byId[0] ?? null) : null;

  const byName = apps.filter((app) => app.name.trim().toLowerCase() === normalized);
  if (byName.length > 0) return byName.length === 1 ? (byName[0] ?? null) : null;

  const alias = normalizeAppAlias(value);
  const matches = apps.filter((app) =>
    [app.id, app.name, ...(app.pluginDisplayNames ?? [])].some(
      (candidate) => normalizeAppAlias(candidate) === alias,
    ),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

const appIdForUrl = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname.toLowerCase();
  return (
    TITLE_APP_HOSTS.find((candidate) =>
      candidate.hostnames.some(
        (expected) => hostname === expected || hostname.endsWith(`.${expected}`),
      ),
    )?.appId ?? null
  );
};

const trimResourcePunctuation = (value: string): string => value.replace(/[.,!?;:'"]+$/u, "");

const promptResources = (prompt: string): readonly string[] => [
  ...[...prompt.matchAll(RESOURCE_PATTERN)].map((match) => trimResourcePunctuation(match[0])),
  ...[...prompt.matchAll(URL_PATTERN)].map((match) => trimResourcePunctuation(match[0])),
];

export function promptNeedsThreadTitleAppTools(prompt: string): boolean {
  return promptResources(prompt).some(
    (resource) =>
      resource.startsWith("app://") ||
      resource.startsWith("plugin://") ||
      appIdForUrl(resource) !== null,
  );
}

const pluginResourceAppId = (value: string): string | null => {
  const raw = value.slice("plugin://".length).trim();
  if (!raw) return null;
  const withoutQuery = raw.split("?", 1)[0]?.trim() ?? "";
  if (!withoutQuery) return null;
  const at = withoutQuery.lastIndexOf("@");
  return at > 0 && at < withoutQuery.length - 1 ? withoutQuery.slice(0, at) : withoutQuery;
};

const referencedAppIds = (prompt: string, apps: readonly TitleAppInfo[]): readonly string[] => {
  const ids = new Set<string>();
  for (const resource of promptResources(prompt)) {
    if (resource.startsWith("app://")) {
      const app = apps.find((candidate) => `app://${candidate.id}` === resource);
      if (app) ids.add(app.id);
      continue;
    }
    if (resource.startsWith("plugin://")) {
      const pluginId = pluginResourceAppId(resource);
      if (pluginId) ids.add(pluginId);
      continue;
    }
    const linkedAppId = appIdForUrl(resource);
    if (linkedAppId) ids.add(linkedAppId);
  }
  return [...ids];
};

const connectorId = (tool: TitleMcpTool): string | null => {
  const meta = asRecord(tool._meta);
  const value = meta?.connectorId ?? meta?.connector_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const isReadOnlyTool = (tool: TitleMcpTool): boolean =>
  asRecord(tool.annotations)?.readOnlyHint === true;

export function resolveThreadTitleReadOnlyAppToolAllowlist(input: {
  readonly prompt: string;
  readonly apps: readonly TitleAppInfo[];
  readonly mcpServerStatuses: readonly TitleMcpServerStatus[];
}): readonly CodexThreadTitleReadOnlyAppTool[] {
  const apps = input.apps.filter((app) => app.isAccessible === true && app.isEnabled === true);
  const referencedApps = [
    ...new Set(
      referencedAppIds(input.prompt, apps)
        .map((appId) => uniqueAppMatch(apps, appId))
        .filter((app): app is TitleAppInfo => app !== null),
    ),
  ];
  if (referencedApps.length === 0) return [];

  const tools = input.mcpServerStatuses
    .filter((server) => server.name === CODEX_APPS_SERVER)
    .flatMap((server) => Object.values(server.tools))
    .filter((tool): tool is TitleMcpTool => tool !== undefined && isReadOnlyTool(tool));

  return referencedApps.flatMap((app) => {
    const toolNames = [
      ...new Set(
        tools.flatMap((tool) => {
          const id = connectorId(tool);
          if (!id || uniqueAppMatch(apps, id)?.id !== app.id) return [];
          return [tool.name];
        }),
      ),
    ];
    return toolNames.length === 0 ? [] : [{ appId: app.id, toolNames }];
  });
}

export class CodexThreadTitleAppTools extends Context.Service<
  CodexThreadTitleAppTools,
  {
    readonly discover: (input: {
      readonly hostId: string;
      readonly threadId: string;
      readonly prompt: string;
    }) => Effect.Effect<readonly CodexThreadTitleReadOnlyAppTool[]>;
  }
>()("nodex/main/codex-application/CodexThreadTitleAppTools") {}

export const make: Effect.Effect<CodexThreadTitleAppTools["Service"], never, CodexGateway> =
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;

    const discover = (input: {
      readonly hostId: string;
      readonly threadId: string;
      readonly prompt: string;
    }) => {
      if (!promptNeedsThreadTitleAppTools(input.prompt)) return Effect.succeed([]);

      const listApps = Effect.gen(function* () {
        const apps: TitleAppInfo[] = [];
        let cursor: string | null = null;
        do {
          const page: ClientRequestResponsesByMethod["app/list"] = yield* gateway.requestOnHost(
            input.hostId,
            "app/list",
            { cursor, forceRefetch: false, limit: TITLE_APP_PAGE_SIZE, threadId: input.threadId },
            { timeoutMs: TITLE_APP_INVENTORY_TIMEOUT_MS, conversationId: input.threadId },
          );
          apps.push(...page.data);
          cursor = page.nextCursor ?? null;
        } while (cursor !== null);
        return apps;
      });

      const listMcpServers = Effect.gen(function* () {
        const statuses: TitleMcpServerStatus[] = [];
        let cursor: string | null = null;
        do {
          const page: ClientRequestResponsesByMethod["mcpServerStatus/list"] =
            yield* gateway.requestOnHost(
              input.hostId,
              "mcpServerStatus/list",
              {
                cursor,
                detail: "toolsAndAuthOnly",
                limit: TITLE_MCP_PAGE_SIZE,
                threadId: input.threadId,
              },
              { timeoutMs: TITLE_APP_INVENTORY_TIMEOUT_MS, conversationId: input.threadId },
            );
          statuses.push(...page.data);
          cursor = page.nextCursor ?? null;
        } while (cursor !== null);
        return statuses;
      });

      return Effect.all(
        { apps: listApps, mcpServerStatuses: listMcpServers },
        { concurrency: 2 },
      ).pipe(
        Effect.map(({ apps, mcpServerStatuses }) =>
          resolveThreadTitleReadOnlyAppToolAllowlist({
            prompt: input.prompt,
            apps,
            mcpServerStatuses,
          }),
        ),
        Effect.catch(() => Effect.succeed([])),
      );
    };

    return CodexThreadTitleAppTools.of({ discover });
  });

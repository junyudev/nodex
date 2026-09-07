import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import {
  selectAppToolCatalog,
  type AppToolCatalogPurpose,
} from "../../shared/nodex-app-tools/catalog-selection";
import { buildCodexThreadConfigOverrides } from "./codex-thread-capabilities";

type ThreadConfig = NonNullable<ClientRequestParamsByMethod["thread/start"]["config"]>;
type ThreadConfigValue = ThreadConfig[string];

const normalizeConfigValue = (value: unknown): ThreadConfigValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map(normalizeConfigValue);
  if (typeof value !== "object") throw new Error("Thread configuration must contain JSON values");
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      entry === undefined ? [] : [[key, normalizeConfigValue(entry)]],
    ),
  );
};

/** Refresh app-tool visibility at every Thread launch, fork, and live resume. */
export function buildCodexThreadConfig(input: {
  readonly nativeMcp: boolean;
  readonly purpose?: AppToolCatalogPurpose;
  readonly overrides?: Readonly<Record<string, unknown>> | null;
}): ThreadConfig {
  const purpose = input.purpose ?? "session";
  return {
    ...Object.fromEntries(
      Object.entries(input.overrides ?? {}).flatMap(([key, entry]) =>
        entry === undefined ? [] : [[key, normalizeConfigValue(entry)]],
      ),
    ),
    ...(purpose === "system" ? {} : buildCodexThreadConfigOverrides()),
    // Remote endpoints without the private server must not receive a partial MCP definition.
    ...(input.nativeMcp
      ? {
          "mcp_servers.nodex_app.enabled_tools": selectAppToolCatalog({
            nativeMcp: true,
            purpose,
          }).map((tool) => tool.name),
        }
      : {}),
  };
}

import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import {
  parseCollaborationModePreset,
  parseModelOption,
} from "../../../shared/codex-composer-catalog";
import type { CodexCollaborationModePreset, CodexModelOption } from "../../../shared/types";
import { RendererNativeAppServer } from "./renderer-native-app-server";

export async function readNativeModelCatalog(
  client: RendererNativeAppServer,
): Promise<CodexModelOption[]> {
  const models: CodexModelOption[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const response: ClientRequestResponsesByMethod["model/list"] = await client.request(
      "model/list",
      { cursor, limit: 100 },
    );
    models.push(
      ...response.data
        .map(parseModelOption)
        .filter((model): model is CodexModelOption => model !== null),
    );
    cursor = response.nextCursor ?? null;
    if (cursor === null) return models;
    if (seen.has(cursor)) throw new Error(`Model catalog repeated cursor '${cursor}'`);
    seen.add(cursor);
  }
  throw new Error("Model catalog exceeded 100 pages without completing");
}

export async function readNativeCollaborationModes(
  client: RendererNativeAppServer,
): Promise<CodexCollaborationModePreset[]> {
  const response = await client.request("collaborationMode/list", {});
  return response.data
    .map(parseCollaborationModePreset)
    .filter((mode): mode is CodexCollaborationModePreset => mode !== null);
}

export async function readModelCatalogForHost(
  hostId: string,
  signal?: AbortSignal,
): Promise<CodexModelOption[]> {
  const client = new RendererNativeAppServer(hostId);
  const close = () => client[Symbol.dispose]();
  if (signal?.aborted) close();
  signal?.addEventListener("abort", close, { once: true });
  try {
    return await readNativeModelCatalog(client);
  } finally {
    signal?.removeEventListener("abort", close);
    close();
  }
}

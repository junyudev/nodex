import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { CodexConversationImageAssetResolveResult } from "../../shared/types";
import { installWindowApi } from "../test/browser-globals";
import { createTestQueryClient } from "../test/query";
import {
  CODEX_IMAGE_ASSET_STALE_TIME_MS,
  codexConversationImageAssetQueryOptions,
} from "./codex-conversation-image-assets";

const clients: QueryClient[] = [];
const resolveAsset = vi.fn<() => Promise<CodexConversationImageAssetResolveResult>>();

function createClient(): QueryClient {
  const client = createTestQueryClient();
  clients.push(client);
  return client;
}

beforeEach(() => {
  vi.useFakeTimers();
  resolveAsset.mockReset();
  resolveAsset.mockResolvedValue({ ok: true, dataBase64: "BAUG", mimeType: "image/webp" });
  installWindowApi({
    invoke: async (channel: string) => {
      if (channel === "codex:conversation-image-asset:resolve") return resolveAsset();
      throw new Error(`Unexpected channel: ${channel}`);
    },
    on: () => () => undefined,
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.clear();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Codex image asset cache lifetime", () => {
  test("shares one materialized object URL per QueryClient and image identity", async () => {
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:shared")
      .mockReturnValueOnce("blob:other-client");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const client = createClient();
    const options = codexConversationImageAssetQueryOptions("file-service://asset-1");

    const [first, concurrent] = await Promise.all([
      client.fetchQuery(options),
      client.fetchQuery(options),
    ]);
    const retained = await client.fetchQuery(options);
    expect(concurrent).toBe(first);
    expect(retained).toBe(first);
    expect(first.objectUrl).toBe("blob:shared");
    expect(first.dataUrl).toBe("data:image/webp;base64,BAUG");
    expect(resolveAsset).toHaveBeenCalledTimes(1);

    const separate = await createClient().fetchQuery(options);
    expect(separate.objectUrl).toBe("blob:other-client");
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
  });

  test("keeps the current URL during refresh and releases only replaced cache data", async () => {
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:previous")
      .mockReturnValueOnce("blob:replacement");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const client = createClient();
    const options = codexConversationImageAssetQueryOptions("sediment://asset-1");
    await client.fetchQuery(options);
    let finishRefresh!: (result: CodexConversationImageAssetResolveResult) => void;
    resolveAsset.mockImplementationOnce(() => new Promise((resolve) => (finishRefresh = resolve)));

    const refresh = client.fetchQuery({ ...options, staleTime: 0 });
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    expect(client.getQueryData(options.queryKey)?.objectUrl).toBe("blob:previous");
    finishRefresh({ ok: true, dataBase64: "AQID", mimeType: "image/png" });
    const replacement = await refresh;
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement.objectUrl).toBe("blob:replacement");
    expect(revokeObjectUrl.mock.calls).toEqual([["blob:previous"]]);

    client.removeQueries({ queryKey: options.queryKey, exact: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeObjectUrl.mock.calls).toEqual([["blob:previous"], ["blob:replacement"]]);
  });

  test("collects unused image bytes and their object URL after five minutes", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:expired");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const client = createClient();
    const options = codexConversationImageAssetQueryOptions("file-service://asset-1");
    await client.fetchQuery(options);

    await vi.advanceTimersByTimeAsync(CODEX_IMAGE_ASSET_STALE_TIME_MS - 1);
    expect(client.getQueryData(options.queryKey)?.objectUrl).toBe("blob:expired");
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith("blob:expired");
  });

  test("does not create an object URL for a cancelled native read that finishes late", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    const client = createClient();
    const options = codexConversationImageAssetQueryOptions("file-service://asset-1");
    let finishRead!: (result: CodexConversationImageAssetResolveResult) => void;
    resolveAsset.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    const pending = client.fetchQuery(options).catch((error: unknown) => error);

    await client.cancelQueries({ queryKey: options.queryKey, exact: true });
    finishRead({ ok: true, dataBase64: "AQID", mimeType: "image/png" });
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  });

  test("retains data URLs for image types outside the object URL allowlist", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    resolveAsset.mockResolvedValueOnce({
      ok: true,
      dataBase64: "AQID",
      mimeType: "image/svg+xml",
    });
    const result = await createClient().fetchQuery(
      codexConversationImageAssetQueryOptions("file-service://vector-1"),
    );

    expect(result.objectUrl).toBeNull();
    expect(result.dataUrl).toBe("data:image/svg+xml;base64,AQID");
    expect(createObjectUrl).not.toHaveBeenCalled();
  });
});

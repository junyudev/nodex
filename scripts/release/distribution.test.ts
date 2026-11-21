import { expect, test, vi } from "vite-plus/test";
import { verifyMacDesktopToolsDownload } from "./distribution";

const asset = { url: "https://example.com/component.tar.gz", archiveSize: 100 };

test("checks the pinned size through the published URL", async () => {
  const fetchAsset = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { headers: { "content-length": "100" } }));
  await verifyMacDesktopToolsDownload(asset, fetchAsset);
  expect(fetchAsset).toHaveBeenCalledExactlyOnceWith(asset.url, {
    method: "HEAD",
    signal: expect.any(AbortSignal),
  });
});

test("checks the total archive size with a ranged GET when HEAD cannot provide it", async () => {
  const fetchAsset = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 405 }))
    .mockResolvedValueOnce(
      new Response("x", {
        status: 206,
        headers: { "content-range": "bytes 0-0/100" },
      }),
    );
  await verifyMacDesktopToolsDownload(asset, fetchAsset);
  expect(fetchAsset).toHaveBeenLastCalledWith(asset.url, {
    headers: { Range: "bytes=0-0" },
    signal: expect.any(AbortSignal),
  });
});

test("rejects a missing asset or a different published size", async () => {
  const fetchAsset = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { headers: { "content-length": "99" } }))
    .mockImplementation(async () => new Response(null, { status: 404 }));
  await expect(verifyMacDesktopToolsDownload(asset, fetchAsset)).rejects.toThrow("has 99 bytes");
  await expect(verifyMacDesktopToolsDownload(asset, fetchAsset)).rejects.toThrow("HTTP 404");
  await expect(verifyMacDesktopToolsDownload({ ...asset, url: null }, fetchAsset)).rejects.toThrow(
    "Publish the pinned macOS Desktop Tools archive first",
  );
});

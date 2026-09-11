import { beforeEach, expect, test, vi } from "vite-plus/test";
import { materializePagePromptInput } from "./page-prompt-input";
import { readFileBytes } from "./api";
import { readBlobAsDataUrl } from "./assets";

vi.mock("./api", () => ({ readFileBytes: vi.fn() }));
vi.mock("./assets", () => ({ readBlobAsDataUrl: vi.fn() }));
const access = { kind: "project", projectId: "source-project" } as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readFileBytes).mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
    etag: "version-a",
  });
  vi.mocked(readBlobAsDataUrl).mockImplementation(
    async (blob) =>
      `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`,
  );
});

test("freezes authorized Page image bytes once per File while preserving occurrences and other input", async () => {
  const input = {
    text: "Explain",
    images: [
      { source: "nodex://files/file-a", caption: "First" },
      { source: "https://example.com/image.png" },
      { source: "nodex://files/file-a", caption: "Second" },
    ],
    agentConfigs: [{ model: "model-a" }],
  };
  const frozen = await materializePagePromptInput(access, "page-a", input);
  expect(readFileBytes).toHaveBeenCalledExactlyOnceWith(access, {
    fileId: "file-a",
    source: { kind: "page", page_id: "page-a" },
  });
  expect(frozen).toEqual({
    ...input,
    images: [
      { source: "data:image/png;base64,AQID", caption: "First" },
      input.images[1],
      { source: "data:image/png;base64,AQID", caption: "Second" },
    ],
  });
  expect(input.images[0]?.source).toBe("nodex://files/file-a");
});

test("reauthorizes and captures current bytes on each submission without rewriting an earlier snapshot", async () => {
  const input = { text: "", images: [{ source: "nodex://files/file-a" }] };
  const first = await materializePagePromptInput(access, "page-a", input);
  vi.mocked(readFileBytes).mockResolvedValue({
    bytes: new Uint8Array([4]),
    mimeType: "image/webp",
    etag: "version-b",
  });
  const second = await materializePagePromptInput(access, "page-a", input);
  expect(first?.images?.[0]?.source).toBe("data:image/png;base64,AQID");
  expect(second?.images?.[0]?.source).toBe("data:image/webp;base64,BA==");
  expect(readFileBytes).toHaveBeenCalledTimes(2);
});

test("rejects revoked Page access instead of dropping the image or using stale display bytes", async () => {
  vi.mocked(readFileBytes).mockRejectedValue(new Error("Page access revoked"));
  await expect(
    materializePagePromptInput(access, "page-a", {
      text: "Explain",
      images: [{ source: "nodex://files/file-a" }],
    }),
  ).rejects.toThrow("Page access revoked");
  expect(readBlobAsDataUrl).not.toHaveBeenCalled();
});

test("rejects a File whose current content is not an image", async () => {
  vi.mocked(readFileBytes).mockResolvedValue({
    bytes: new Uint8Array([1]),
    mimeType: "text/plain",
    etag: "version-a",
  });
  await expect(
    materializePagePromptInput(access, "page-a", {
      text: "Explain",
      images: [{ source: "nodex://files/file-a" }],
    }),
  ).rejects.toThrow("not an image");
});

test("preserves already portable image sources and text-only submissions", async () => {
  const input = { text: "Explain", images: [{ source: "data:image/png;base64,AQID" }] };
  expect(await materializePagePromptInput(access, "page-a", input)).toBe(input);
  expect(await materializePagePromptInput(access, "page-a", undefined)).toBeUndefined();
  expect(readFileBytes).not.toHaveBeenCalled();
});

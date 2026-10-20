import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { FileReadAuthority } from "@/lib/library-file-resources";
import { TestQueryProvider } from "@/test/query";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { MessageDocument } from "./message-document";

const reads = vi.hoisted(() => ({ bytes: vi.fn() }));
vi.mock("@/lib/library-file-resources", async (original) => ({
  ...(await original<typeof import("@/lib/library-file-resources")>()),
  readAuthorizedFile: reads.bytes,
}));

const authority: FileReadAuthority = {
  libraryId: "library",
  storeEpoch: "epoch",
  contentRoutingContext: { kind: "library" },
  readSource: { kind: "page", page_id: "page:1" },
};
const createObjectUrl = URL.createObjectURL;
const revokeObjectUrl = URL.revokeObjectURL;
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:shot");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  URL.createObjectURL = createObjectUrl;
  URL.revokeObjectURL = revokeObjectUrl;
  vi.resetAllMocks();
});

test("a message reads its Markdown as structure and the rest as typed", () => {
  const view = render(
    <MessageDocument
      nfm={"**Ship** the changelog\n- check the links\nKeep a \\< b and \\[draft"}
      fileAuthority={null}
    />,
  );
  expect(view.getByText("Ship")).toBeDefined();
  expect(view.queryByText(/\*\*/)).toBeNull();
  expect(within(view.getByRole("list")).getByText("check the links")).toBeDefined();
  expect(view.getByText("Keep a < b and [draft")).toBeDefined();
});

test("a message shows its attached Library images and opens them", async () => {
  reads.bytes.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
    etag: "shot",
  });
  const view = render(
    <TestQueryProvider>
      <MessageDocument
        nfm={'The banner is cut off\n<image source="nodex://files/shot">Banner</image>'}
        fileAuthority={authority}
      />
    </TestQueryProvider>,
  );
  const thumbnail = await view.findByRole("button", { name: "Open image preview" });
  expect(within(thumbnail).getByRole("img", { name: "Banner" }).getAttribute("src")).toBe(
    "blob:shot",
  );
  // The image is read with the message Page's own access, not a broader one.
  expect(reads.bytes).toHaveBeenCalledWith(authority, "nodex://files/shot");
  expect(view.getByText("The banner is cut off")).toBeDefined();

  await act(async () => {
    fireEvent.click(thumbnail);
    await Promise.resolve();
  });
  expect(
    within(await view.findByRole("dialog")).getByRole("img", { name: "Banner" }),
  ).toBeDefined();
});

test("an image the message cannot read says so instead of loading forever", () => {
  const view = render(
    <MessageDocument
      nfm={'<image source="nodex://files/shot">Banner</image>'}
      fileAuthority={null}
    />,
  );
  expect(view.getByRole("status", { name: "Image unavailable" })).toBeDefined();
});

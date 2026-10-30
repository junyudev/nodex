import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { FileReadAuthority } from "@/lib/library-file-resources";
import { TestQueryProvider } from "@/test/query";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { readMarkdown } from "../../../shared/nodex-markdown";
import { MessageDocument, MessageText } from "./message-document";

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

test("written text reads its Markdown as structure and the rest as typed", () => {
  const view = render(
    <MessageText
      text={
        "**Ship** the changelog\n* check the links\n  * in the footer\n\nAs typed: https://example.com/notes\nKeep a < b and [draft"
      }
    />,
  );
  expect(view.getByText("Ship")).toBeDefined();
  expect(view.queryByText(/\*\*/)).toBeNull();
  const lists = view.getAllByRole("list");
  expect(within(lists[0]!).getByText("check the links")).toBeDefined();
  expect(within(lists[0]!).getByText("in the footer")).toBeDefined();
  // Lines written together stay one paragraph, broken where they were written.
  const paragraph = view.getByText(/Keep a < b and \[draft/).closest("p")!;
  expect(paragraph.querySelector("br")).not.toBeNull();
  expect(within(paragraph).getByRole("link", { name: "https://example.com/notes" })).toBeDefined();
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
        blocks={readMarkdown("The banner is cut off\n\n![Banner](nodex://files/shot)")}
        contentKey="pictured"
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

test("the image row sits where the message keeps its images", () => {
  const order = (markdown: string) => {
    const view = render(
      <MessageDocument
        blocks={readMarkdown(markdown)}
        contentKey={markdown}
        fileAuthority={null}
      />,
    );
    const image = view.getByRole("status", { name: "Image unavailable" });
    const text = view.getByText("The banner is cut off");
    const before = Boolean(image.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING);
    view.unmount();
    return before ? "images first" : "text first";
  };
  expect(order("![](nodex://files/shot)\n\nThe banner is cut off")).toBe("images first");
  // A message written before images came first keeps them after its text.
  expect(order("The banner is cut off\n\n![](nodex://files/shot)")).toBe("text first");
});

test("an image the message cannot read says so instead of loading forever", () => {
  const view = render(
    <MessageDocument
      blocks={readMarkdown("![Banner](nodex://files/shot)")}
      contentKey="picture"
      fileAuthority={null}
    />,
  );
  expect(view.getByRole("status", { name: "Image unavailable" })).toBeDefined();
});

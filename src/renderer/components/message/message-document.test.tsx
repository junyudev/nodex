import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { FileReadAuthority } from "@/lib/library-file-resources";
import { ConversationImageAssetProvider } from "@/features/local-conversation/view/conversation-image-asset-context";
import { installWindowApi } from "@/test/browser-globals";
import { libraryMetadataQueryOptions } from "@/lib/use-library-navigation";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
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
    <TestQueryProvider>
      <MessageText
        text={
          "**Ship** the changelog\n* check the links\n  * in the footer\n\nAs typed: https://example.com/notes\nKeep a < b and [draft"
        }
      />
    </TestQueryProvider>,
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
      <TestQueryProvider>
        <MessageDocument
          blocks={readMarkdown(markdown)}
          contentKey={markdown}
          fileAuthority={null}
        />
      </TestQueryProvider>,
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
    <TestQueryProvider>
      <MessageDocument
        blocks={readMarkdown("![Banner](nodex://files/shot)")}
        contentKey="picture"
        fileAuthority={null}
      />
    </TestQueryProvider>,
  );
  expect(view.getByRole("status", { name: "Image unavailable" })).toBeDefined();
});

test("a file path in a message shows the image it names on this computer", async () => {
  const view = render(
    <TestQueryProvider>
      <MessageText
        text={
          "![](/Users/me/before.png)\n\nThe banner is cut off\n\n![](</Users/me/cut off.png>)\n\nSee ![badge](file:///Users/me/badge.svg) too"
        }
      />
    </TestQueryProvider>,
  );
  const attached = await view.findByRole("button", { name: "Open image preview" });
  expect(within(attached).getByRole("img").getAttribute("src")).toBe(
    "app://fs/@fs/Users/me/before.png",
  );
  // An image between paragraphs stays in place, as large as an Agent's reply shows one.
  const between = view.getByRole("button", { name: "Open Image" });
  expect(within(between).getByRole("img").getAttribute("src")).toBe(
    "app://fs/@fs/Users/me/cut%20off.png",
  );
  expect(view.getByRole("img", { name: "badge" }).getAttribute("src")).toBe(
    "app://fs/@fs/Users/me/badge.svg",
  );

  await act(async () => {
    fireEvent.click(between);
    await Promise.resolve();
  });
  expect(within(await view.findByRole("dialog")).getByRole("img")).toBeDefined();
});

test("a managed asset shows from this Profile's cache, even in a chat on another host", () => {
  installWindowApi({
    invoke: vi.fn(async () => {
      throw new Error("Managed assets display without a read");
    }),
    on: () => () => {},
    resolveManagedAssetPath: (source: string) =>
      source === "nodex://assets/diagram.svg" ? "/profile/cache/assets/diagram.svg" : null,
  });
  const view = render(
    <TestQueryProvider>
      <ConversationImageAssetProvider conversationId="thread" hostId="devbox">
        <MessageText text={"Before\n\n![](nodex://assets/diagram.svg)\n\nAfter"} />
      </ConversationImageAssetProvider>
    </TestQueryProvider>,
  );
  const image = within(view.getByRole("button", { name: "Open Image" })).getByRole("img");
  expect(image.getAttribute("src")).toBe("app://fs/@fs/profile/cache/assets/diagram.svg");
});

test("a file path that names no image says the image is unavailable", async () => {
  const view = render(
    <TestQueryProvider>
      <MessageText text={"Before\n\n![](/Users/me/missing.png)\n\nAfter"} />
    </TestQueryProvider>,
  );
  const image = within(view.getByRole("button", { name: "Open Image" })).getByRole("img");
  await act(async () => {
    fireEvent.error(image);
    await Promise.resolve();
  });
  expect(await view.findByRole("status", { name: "Image unavailable" })).toBeDefined();
  expect(view.queryByRole("button", { name: "Open Image" })).toBeNull();
});

test("text written to an Agent reads its Library images with the Library's access", async () => {
  reads.bytes.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
    etag: "shot",
  });
  const client = createTestQueryClient();
  client.setQueryData(libraryMetadataQueryOptions().queryKey, {
    profileId: "profile",
    libraryId: "library",
    storeEpoch: "epoch",
    commitSeq: 1,
    value: { kind: "metadata" },
  } as never);
  const view = render(
    <TestQueryProvider client={client}>
      <MessageText text={"![Banner](nodex://files/shot)\n\nThe banner is cut off"} />
    </TestQueryProvider>,
  );
  const thumbnail = await view.findByRole("button", { name: "Open image preview" });
  expect(within(thumbnail).getByRole("img", { name: "Banner" }).getAttribute("src")).toBe(
    "blob:shot",
  );
  expect(reads.bytes).toHaveBeenCalledWith(
    {
      libraryId: "library",
      storeEpoch: "epoch",
      contentRoutingContext: { kind: "library" },
      readSource: { kind: "direct" },
    },
    "nodex://files/shot",
  );
});

test("in a chat, a file path reads from the chat's host", async () => {
  const invoke = vi.fn(async (_channel: string, _input?: unknown) => ({
    contentsBase64: "aW1hZ2U=",
    mimeType: "image/png",
  }));
  installWindowApi({ invoke, on: () => () => {} });
  const view = render(
    <TestQueryProvider>
      <ConversationImageAssetProvider conversationId="thread" hostId="devbox">
        <MessageText text={"Before\n\n![](/home/me/shot.png)\n\nAfter"} />
      </ConversationImageAssetProvider>
    </TestQueryProvider>,
  );
  const image = within(await view.findByRole("button", { name: "Open Image" })).getByRole("img");
  expect(image.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
  expect(invoke.mock.calls.filter(([channel]) => channel === "read-file-binary")).toEqual([
    ["read-file-binary", { hostId: "devbox", path: "/home/me/shot.png" }],
  ]);
});

import { act, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { TestQueryProvider } from "@/test/query";
import {
  EMPTY_INBOX_DRAFT,
  inboxDraftBody,
  inboxDraftFromBody,
  type InboxDraft,
} from "./inbox-capture-state";
import { InboxComposer } from "./inbox-composer";
import { InboxMessageEditor } from "./inbox-message-editor";
import { useInboxImageAccess } from "./use-inbox-image-access";

const files = vi.hoisted(() => ({ importFile: vi.fn(), bytes: vi.fn(), metadata: vi.fn() }));
vi.mock("@/lib/library-file-resources", async (original) => ({
  ...(await original<typeof import("@/lib/library-file-resources")>()),
  importLibraryFile: files.importFile,
  readAuthorizedFile: files.bytes,
  readFilePresentation: files.metadata,
}));
const trash = vi.hoisted(() => vi.fn());
vi.mock("@/lib/library-file-commands", async (original) => ({
  ...(await original<typeof import("@/lib/library-file-commands")>()),
  changeFileLifecycle: trash,
}));
vi.mock("@/lib/use-library-navigation", () => ({
  useLibraryMetadata: () => ({ data: { storeEpoch: "epoch", libraryId: "library" } }),
}));

const createObjectUrl = URL.createObjectURL;
const revokeObjectUrl = URL.revokeObjectURL;
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:shot");
  URL.revokeObjectURL = vi.fn();
  files.importFile.mockResolvedValue({
    file: { file_id: "shot", default_name: "shot.png", revision: 1 },
    source: "nodex://files/shot",
  });
  trash.mockResolvedValue(null);
  files.bytes.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png", etag: "e" });
  files.metadata.mockResolvedValue({
    file_id: "shot",
    default_name: "shot.png",
    mime_type: "image/png",
    byte_length: 1,
    version: 1,
    blob_etag: "e",
  });
});
afterEach(() => {
  URL.createObjectURL = createObjectUrl;
  URL.revokeObjectURL = revokeObjectUrl;
  vi.resetAllMocks();
});

const screenshot = () =>
  new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
const clipboardWith = (file: File) => ({
  files: [file],
  items: [{ kind: "file", type: file.type, getAsFile: () => file }],
  types: ["Files"],
  getData: () => "",
});

function Composer({ onSend }: { readonly onSend: (draft: InboxDraft) => void }) {
  const [draft, setDraft] = useState<InboxDraft>(EMPTY_INBOX_DRAFT);
  return (
    <InboxComposer
      draft={draft}
      onDraftChange={setDraft}
      images={useInboxImageAccess({ kind: "library" })}
      onSend={async () => onSend(draft)}
    />
  );
}

test("a pasted image becomes a Library File sent ahead of the message's text", async () => {
  const onSend = vi.fn();
  const view = render(
    <TestQueryProvider>
      <Composer onSend={onSend} />
    </TestQueryProvider>,
  );
  const text = view.getByRole("textbox", { name: "Message your Inbox" });
  await act(async () => {
    fireEvent.change(text, { target: { value: "The toolbar is cut off" } });
    fireEvent.paste(text, { clipboardData: clipboardWith(screenshot()) });
    await Promise.resolve();
  });
  await view.findByRole("button", { name: "shot.png" });
  expect(files.importFile).toHaveBeenCalledWith(
    { contentRoutingContext: { kind: "library" }, storeEpoch: "epoch", libraryId: "library" },
    { kind: "browser_file", file: expect.any(File) },
    "shot.png",
  );

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Send to Inbox" }));
    await Promise.resolve();
  });
  expect(inboxDraftBody(onSend.mock.calls[0]![0])).toBe(
    "![](nodex://files/shot)\n\nThe toolbar is cut off",
  );
});

test("rich text pasted into the message arrives as its Markdown, every line kept", async () => {
  const onSend = vi.fn();
  const view = render(
    <TestQueryProvider>
      <Composer onSend={onSend} />
    </TestQueryProvider>,
  );
  const text = view.getByRole("textbox", { name: "Message your Inbox" }) as HTMLTextAreaElement;
  const data: Record<string, string> = {
    "text/plain": "Milk\nEggs\nSee the list",
    "text/html":
      '<div>Milk</div><div>Eggs</div><div><br></div><div>See <a href="https://e.x/list">the list</a></div>',
  };
  await act(async () => {
    fireEvent.paste(text, {
      clipboardData: {
        files: [],
        items: [],
        types: Object.keys(data),
        getData: (f: string) => data[f] ?? "",
      },
    });
    await Promise.resolve();
  });
  expect(text.value).toBe("Milk\nEggs\n\nSee [the list](https://e.x/list)");
  // The draft took the paste, not only the field.
  const send = view.getByRole("button", { name: "Send to Inbox" }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
});

test("a removed image leaves the draft, and an image alone can be sent", async () => {
  const onSend = vi.fn();
  const view = render(
    <TestQueryProvider>
      <Composer onSend={onSend} />
    </TestQueryProvider>,
  );
  const text = view.getByRole("textbox", { name: "Message your Inbox" });
  const send = view.getByRole("button", { name: "Send to Inbox" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  await act(async () => {
    fireEvent.paste(text, { clipboardData: clipboardWith(screenshot()) });
    await Promise.resolve();
  });
  await view.findByRole("button", { name: "shot.png" });
  expect(send.disabled).toBe(false);

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Remove shot.png" }));
    await Promise.resolve();
  });
  expect(view.queryByRole("button", { name: "shot.png" })).toBeNull();
  expect(send.disabled).toBe(true);
  // The draft imported it and let it go, so it goes to Trash rather than lingering unused.
  expect(trash).toHaveBeenCalledWith(
    { contentRoutingContext: { kind: "library" }, storeEpoch: "epoch", libraryId: "library" },
    { file_id: "shot", revision: 1 },
    "trash",
  );
});

test("an image cancelled while it imports goes to Trash once it is in", async () => {
  let finish!: (value: unknown) => void;
  files.importFile.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const view = render(
    <TestQueryProvider>
      <Composer onSend={vi.fn()} />
    </TestQueryProvider>,
  );
  const text = view.getByRole("textbox", { name: "Message your Inbox" });
  await act(async () => {
    fireEvent.paste(text, { clipboardData: clipboardWith(screenshot()) });
    await Promise.resolve();
  });
  const remove = await view.findByRole("button", { name: "Remove shot.png" });
  await act(async () => {
    fireEvent.click(remove);
    await Promise.resolve();
  });
  await act(async () => {
    finish({
      file: { file_id: "shot", default_name: "shot.png", revision: 1 },
      source: "nodex://files/shot",
    });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(trash).toHaveBeenCalledWith(
      expect.anything(),
      { file_id: "shot", revision: 1 },
      "trash",
    ),
  );
  expect(view.queryByRole("button", { name: "shot.png" })).toBeNull();
});

const PICTURED = "Settings\n\n![](nodex://files/shot)";

const editor = (onSave: (body: string) => Promise<boolean>, onCancel = vi.fn()) =>
  render(
    <TestQueryProvider>
      <InboxMessageEditor
        body={PICTURED}
        draft={inboxDraftFromBody(PICTURED)!}
        routing={{ kind: "library" }}
        onSave={onSave}
        onCancel={onCancel}
      />
    </TestQueryProvider>,
  );

test("a message whose image was resized in its Page keeps its exact Markdown in the editor", () => {
  expect(inboxDraftFromBody("Settings\n\n![|320](nodex://files/shot)")).toEqual({
    text: "Settings\n\n![|320](nodex://files/shot)",
    images: [],
  });
});

test("a rewrite of the text keeps the message's images", async () => {
  const onSave = vi.fn(async () => true);
  const view = editor(onSave);
  const text = view.getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement;
  expect(text.value).toBe("Settings");
  const save = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  await act(async () => {
    fireEvent.change(text, { target: { value: "Settings, again" } });
  });
  await act(async () => {
    fireEvent.click(save);
    await Promise.resolve();
  });
  expect(onSave).toHaveBeenCalledWith("![](nodex://files/shot)\n\nSettings, again");
});

test("a rewrite can drop one of the message's images", async () => {
  const onSave = vi.fn(async () => true);
  const view = editor(onSave);
  const remove = await view.findByRole("button", { name: "Remove shot.png" });
  await act(async () => {
    fireEvent.click(remove);
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Settings"));
  // The message still has it until the rewrite lands; the draft did not import it.
  expect(trash).not.toHaveBeenCalled();
});

test("an image added during a rewrite goes to Trash when the rewrite is put back", async () => {
  files.importFile.mockResolvedValue({
    file: { file_id: "added", default_name: "added.png", revision: 1 },
    source: "nodex://files/added",
  });
  const onCancel = vi.fn();
  const view = editor(
    vi.fn(async () => true),
    onCancel,
  );
  const text = view.getByRole("textbox", { name: "Edit message" });
  await act(async () => {
    fireEvent.paste(text, { clipboardData: clipboardWith(screenshot()) });
    await Promise.resolve();
  });
  await view.findByRole("button", { name: "added.png" });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await Promise.resolve();
  });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(trash).toHaveBeenCalledTimes(1);
  expect(trash).toHaveBeenCalledWith(expect.anything(), { file_id: "added", revision: 1 }, "trash");
});

test("a rewrite shows the message's text as typed and saves only a change", async () => {
  const onSave = vi.fn(async () => true);
  const view = render(
    <TestQueryProvider>
      <InboxMessageEditor
        body={"Keep a \\< b and C:\\\\Users"}
        draft={inboxDraftFromBody("Keep a \\< b and C:\\\\Users")!}
        routing={{ kind: "library" }}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    </TestQueryProvider>,
  );
  const text = view.getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement;
  expect(text.value).toBe("Keep a < b and C:\\Users");
  expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    fireEvent.change(text, { target: { value: "Keep a < b and C:\\Users, please" } });
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await Promise.resolve();
  });
  expect(onSave).toHaveBeenCalledWith("Keep a < b and C:\\Users, please");
});

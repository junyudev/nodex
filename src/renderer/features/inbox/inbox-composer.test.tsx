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
vi.mock("@/lib/use-library-navigation", () => ({
  useLibraryMetadata: () => ({ data: { storeEpoch: "epoch", libraryId: "library" } }),
}));

const createObjectUrl = URL.createObjectURL;
const revokeObjectUrl = URL.revokeObjectURL;
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:shot");
  URL.revokeObjectURL = vi.fn();
  files.importFile.mockResolvedValue({
    file: { file_id: "shot", default_name: "shot.png" },
    source: "nodex://files/shot",
  });
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

test("a pasted image becomes a Library File sent after the message's text", async () => {
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
    'The toolbar is cut off\n<image source="nodex://files/shot"></image>',
  );
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
});

const PICTURED = 'Settings\n<image source="nodex://files/shot" preview-width="320">Toolbar</image>';

const editor = (onSave: (body: string) => Promise<boolean>) =>
  render(
    <TestQueryProvider>
      <InboxMessageEditor
        body={PICTURED}
        draft={inboxDraftFromBody(PICTURED)!}
        routing={{ kind: "library" }}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    </TestQueryProvider>,
  );

test("a rewrite of the text keeps the message's images exactly", async () => {
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
  expect(onSave).toHaveBeenCalledWith(
    'Settings, again\n<image source="nodex://files/shot" preview-width="320">Toolbar</image>',
  );
});

test("a rewrite can drop one of the message's images", async () => {
  const onSave = vi.fn(async () => true);
  const view = editor(onSave);
  await act(async () => {
    fireEvent.click(await view.findByRole("button", { name: "Remove shot.png" }));
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Settings"));
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

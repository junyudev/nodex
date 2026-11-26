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

const replyDestination = vi.hoisted(() => vi.fn());
vi.mock("@/lib/inbox-runtime", () => ({ readInboxReplyDestination: replyDestination }));
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
  replyDestination.mockResolvedValue({ kind: "nodex", chat: null });
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
    { kind: "browser_file", file: expect.any(File), fromClipboard: true },
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

test("a title already in the draft shows without being opened, so it is never sent unseen", () => {
  const view = render(
    <InboxComposer
      draft={{ ...EMPTY_INBOX_DRAFT, title: "Release notes", text: "List what shipped" }}
      onDraftChange={() => undefined}
      images={null}
      onSend={async () => undefined}
    />,
  );
  expect((view.getByRole("textbox", { name: "Message title" }) as HTMLInputElement).value).toBe(
    "Release notes",
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

test("the reply bar waits for typing to settle before asking where a reply goes", async () => {
  replyDestination.mockClear();
  replyDestination.mockResolvedValue({
    kind: "send",
    chat: { sessionId: "chat", title: "Review work" },
  });
  const props = {
    onDraftChange: vi.fn(),
    images: null,
    onSend: async () => {},
  };
  const draft = (text: string) => ({
    ...EMPTY_INBOX_DRAFT,
    text,
    replyTo: { pageId: "post", label: "Ready" },
  });
  const view = render(<InboxComposer draft={draft("S")} {...props} />);
  await waitFor(() => expect(view.getByLabelText("Reply destination")).toBeTruthy());
  view.rerender(<InboxComposer draft={draft("Sm")} {...props} />);
  view.rerender(<InboxComposer draft={draft("Small")} {...props} />);
  await waitFor(() => expect(replyDestination).toHaveBeenCalledWith("post", "Small"));
  expect(replyDestination).not.toHaveBeenCalledWith("post", "Sm");
  expect(view.getByLabelText("Reply destination").textContent).toBe("· goes to Review work");
});

test("a reply the host cannot deliver says where to continue instead of offering Send", async () => {
  const props = { onDraftChange: vi.fn(), images: null, onSend: async () => {} };
  const reply = (turnEpisode?: string) => ({
    ...EMPTY_INBOX_DRAFT,
    text: "Use the release branch",
    replyTo: { pageId: "post", label: "Question", ...(turnEpisode ? { turnEpisode } : {}) },
  });

  replyDestination.mockResolvedValue({
    kind: "unavailable",
    reason: "Continue this chat on its desktop.",
    chat: null,
  });
  const view = render(<InboxComposer draft={reply()} {...props} />);
  await waitFor(() =>
    expect(view.getByLabelText("Reply destination").textContent).toBe(
      "· Continue this chat on its desktop.",
    ),
  );
  expect((view.getByRole("button", { name: "Send to Inbox" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  view.unmount();

  // A Turn reply has no Nodex destination to fall back to.
  replyDestination.mockResolvedValue({ kind: "nodex", chat: null });
  const turn = render(<InboxComposer draft={reply("episode")} {...props} />);
  await waitFor(() =>
    expect(turn.getByLabelText("Reply destination").textContent).toBe("· Open chat to continue"),
  );
  expect((turn.getByRole("button", { name: "Send reply" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

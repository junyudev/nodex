import { render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import "@/globals.css";
import type { MessageImageAccess } from "@/components/message/message-images-input";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import { EMPTY_INBOX_DRAFT, type InboxDraft } from "./inbox-capture-state";
import { InboxComposer } from "./inbox-composer";

installRendererThemeFixture();

const LONG_TEXT = Array.from({ length: 120 }, (_, index) => `Line ${index + 1}`).join("\n");

const imageAccess = {
  importImage: async () => ({ fileId: "file", name: "file.png" }),
  discardImport: async () => undefined,
  readAuthority: {},
} as unknown as MessageImageAccess;

const composer = (draft: Partial<InboxDraft>, titleOpen = false) => (
  <div style={{ width: 640 }}>
    <InboxComposer
      draft={{ ...EMPTY_INBOX_DRAFT, ...draft }}
      onDraftChange={() => undefined}
      images={imageAccess}
      titleOpen={titleOpen}
      onSend={async () => undefined}
    />
  </div>
);

const parts = () => ({
  surface: screen.getByTestId("inbox-composer"),
  text: screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message your Inbox" }),
  add: screen.getByRole("button", { name: "Add photos" }),
  send: screen.getByRole("button", { name: "Send to Inbox" }),
});

const box = (element: Element) => element.getBoundingClientRect();
const fromBottom = (element: Element, surface: Element) => box(surface).bottom - box(element).top;

afterEach(() => {
  document.body.replaceChildren();
});

test("the text grows with what it holds, then scrolls by itself above controls that stay put", () => {
  const view = render(composer({}));
  const { surface, text, add, send } = parts();
  const emptyHeight = box(surface).height;
  const addPlace = fromBottom(add, surface);
  const sendPlace = fromBottom(send, surface);
  expect(text.scrollHeight).toBe(text.clientHeight);

  view.rerender(composer({ text: "One\nTwo\nThree\nFour" }));
  expect(box(surface).height).toBeGreaterThan(emptyHeight);
  expect(text.scrollHeight).toBe(text.clientHeight);

  view.rerender(composer({ text: LONG_TEXT }));
  expect(text.scrollHeight).toBeGreaterThan(text.clientHeight);
  expect(box(text).height).toBeLessThanOrEqual(window.innerHeight / 4);
  // The scrollbar runs beside the text alone, never beside the controls beneath it.
  expect(box(text).bottom).toBeLessThanOrEqual(box(send).top);
  expect(box(text).bottom).toBeLessThanOrEqual(box(add).top);
  expect(fromBottom(add, surface)).toBe(addPlace);
  expect(fromBottom(send, surface)).toBe(sendPlace);
  // The plus and the send button sit at the row's two ends, on one line.
  expect(box(add).left - box(surface).left).toBe(box(surface).right - box(send).right);
  expect(box(add).top).toBe(box(send).top);
  expect(getComputedStyle(text).scrollbarColor).not.toBe("auto");
});

test("a re-render leaves the text where it was scrolled", () => {
  const view = render(composer({ text: LONG_TEXT }));
  const { text } = parts();
  text.scrollTop = 120;

  view.rerender(composer({ text: `${LONG_TEXT}\nOne more` }));

  expect(text.scrollTop).toBe(120);
});

test("a title takes the room of the text's second line and stays above text that scrolls", () => {
  const view = render(composer({}));
  const { surface } = parts();
  const emptyHeight = box(surface).height;

  view.rerender(composer({}, true));
  const title = screen.getByRole("textbox", { name: "Message title" });
  expect(box(surface).height).toBe(emptyHeight);

  view.rerender(composer({ text: LONG_TEXT }, true));
  const { text } = parts();
  const titleTop = box(title).top;
  text.scrollTop = text.scrollHeight;

  expect(text.scrollTop).toBeGreaterThan(0);
  expect(box(title).top).toBe(titleTop);
  expect(box(title).bottom).toBeLessThanOrEqual(box(text).top);
});

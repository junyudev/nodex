import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { UserMessagePageReferences } from "./user-message-page-references";
import { ComposerPageContextChips } from "../composer/composer-page-context-chips";

const references = [{ pageId: "page-a", titleSnapshot: "Plan", selectedBlockIds: ["a", "b"] }];

test("transcript references expose canonical Page navigation and dispatch the optional local callback", async () => {
  const open = vi.fn();
  const subject = render(<UserMessagePageReferences references={references} onOpenPage={open} />);
  const link = subject.getByRole("link");
  expect(link.getAttribute("href")).toBe("nodex://pages/page-a?spaceId=test-space");
  await act(async () => {
    fireEvent.click(link);
    await Promise.resolve();
  });
  expect(open).toHaveBeenCalledExactlyOnceWith("page-a", "Plan");
});

test("a Composer Page offer is one toggle that includes the Page, then removes it, by identity", async () => {
  const include = vi.fn();
  const remove = vi.fn();
  const chips = (included: boolean) => (
    <ComposerPageContextChips
      offers={[{ reference: references[0]!, included }]}
      onInclude={include}
      onRemove={remove}
    />
  );
  const subject = render(chips(false));
  const toggle = subject.getByRole("button", { name: "Send Plan with this message" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  await act(async () => {
    fireEvent.click(toggle);
    await Promise.resolve();
  });
  expect(include).toHaveBeenCalledExactlyOnceWith("page-a");
  subject.rerender(chips(true));
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  await act(async () => {
    fireEvent.click(toggle);
    await Promise.resolve();
  });
  expect(remove).toHaveBeenCalledExactlyOnceWith("page-a");
});

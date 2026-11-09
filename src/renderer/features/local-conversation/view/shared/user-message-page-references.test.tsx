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

test("Composer context removal identifies the Page independently of its title", async () => {
  const remove = vi.fn();
  const subject = render(<ComposerPageContextChips references={references} onRemove={remove} />);
  await act(async () => {
    fireEvent.click(subject.getByRole("button", { name: "Don't send Plan" }));
    await Promise.resolve();
  });
  expect(remove).toHaveBeenCalledExactlyOnceWith("page-a");
});

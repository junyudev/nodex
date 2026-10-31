import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import { MessageText } from "@/components/message/message-document";

vi.mock("@/lib/use-theme", () => ({ useTheme: () => ({ resolved: "dark" }) }));

describe("MessageText", () => {
  test("keeps the full large prompt in its expandable chat occurrence", async () => {
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(1_000);
    const originalComputedStyle = window.getComputedStyle.bind(window);
    const style = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const result = originalComputedStyle(element, pseudo);
      result.fontSize = "13px";
      result.lineHeight = "20px";
      return result;
    });
    const text = "A long submitted prompt: " + "bounded text ".repeat(3_000) + " END OF PROMPT";
    try {
      const view = render(
        <TestQueryProvider>
          <MessageText text={text} />
        </TestQueryProvider>,
      );
      const disclosure = await view.findByRole("button", { name: "Show more" });
      const occurrence = view.container.querySelector(".codex-markdown-user");
      expect(occurrence?.textContent).toBe(text);
      await act(async () => {
        fireEvent.click(disclosure);
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
          "true",
        ),
      );
      expect(view.container.querySelector(".codex-markdown-user")).toBe(occurrence);
      expect(occurrence?.parentElement?.parentElement?.style.maxHeight).toBe("");
    } finally {
      scrollHeight.mockRestore();
      style.mockRestore();
    }
  });
});

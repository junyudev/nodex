import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import "streamdown/styles.css";
import { installWindowApi } from "../../../test/browser-globals";
import { fixture, key } from "./conversation-markdown-targets.test-fixtures";
import {
  createLocalConversationSearchSource,
  projectLocalConversationResidentSearchResult,
} from "./local-conversation-search-source";
import { createLocalConversationSearchHighlightOwner } from "./local-conversation-search-highlight-owner";
import type { LocalConversationSearchTarget } from "./local-conversation-persisted-search";

vi.mock("@/lib/native-context-menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/native-context-menu")>()),
  showNativeContextMenu: async () => null,
}));

describe("compiled native message target lifetime", () => {
  test.each([
    { source: "[Read](/tmp/a%252520b.ts)", label: "Read", path: "/tmp/a%20b.ts" },
    { source: "@tmp/mentioned.ts", label: "tmp/mentioned.ts", path: "/source/tmp/mentioned.ts" },
  ])(
    "keeps a focused $label target and native Find through streaming append and completion",
    async ({ source: authored, label, path }) => {
      installWindowApi({
        invoke: async () => {
          throw new Error("Unsupported fixture request");
        },
        on: () => () => {},
      });
      const native = fixture(`${authored}\n\nA needle **phrase**`, "local", "inline");
      const setPhase = (status: "inProgress" | "completed") => {
        const details = native.owner.readTurnDetails(key.entityKey)!;
        native.owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "turn",
              key: { ...key, hostId: "local" },
              details: { ...details, status, lifecycleStatusByItemId: { answer: status } },
              hasSubagentActivity: false,
            },
          ],
        });
      };
      setPhase("inProgress");
      const readTurn = vi.spyOn(native.owner, "readTurn");
      const view = native.mount([]);
      const source = createLocalConversationSearchSource({
        routeContextId: "thread",
        getTurns: () => [],
        getProjectedEntries: () => native.project().entries,
        readOwner: () => native.owner,
        scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
      });
      const highlights = createLocalConversationSearchHighlightOwner({
        readRoot: () => view.container,
        resolveTarget: (match) => match.meta as LocalConversationSearchTarget,
      });
      try {
        await act(async () => {
          native.connect();
          await Promise.resolve();
        });
        const button = await view.findByRole("button", { name: label });
        const unit = button.closest("[data-content-search-unit-key]");
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
        expect(unit?.querySelector("[data-markdown-segment]")).not.toBeNull();
        const units = source.findMatches("needle phrase");
        expect(units).toHaveLength(1);
        const result = projectLocalConversationResidentSearchResult({
          units,
          query: "needle phrase",
          contextId: "thread",
          limit: 250,
        });
        const markedText = () =>
          Array.from(
            view.container.querySelectorAll<HTMLElement>("mark[data-content-search-match-id]"),
          )
            .filter((element) => element.dataset.contentSearchMatchId === result.matches[0]!.id)
            .map((element) => element.textContent)
            .join("");
        await act(async () => {
          button.focus();
          highlights.publishResult(result, result.matches[0]!.id);
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(highlights.readActiveMatch(result.matches[0]!.id)?.isConnected).toBe(true);
          expect(markedText()).toBe("needle phrase");
        });
        const rect = button.getBoundingClientRect();
        await act(async () => {
          const raw = native.owner.readItem(key.entityKey, key.itemId)!;
          if (raw.type !== "agentMessage") throw new Error("Missing authored answer");
          native.owner.applyEvent({
            type: "changes",
            changes: [
              {
                type: "text",
                key: { ...key, hostId: "local" },
                target: { field: "text" },
                edits: [{ at: raw.text.length, deleteCount: 0, insert: "\n\nAppended tail" }],
              },
            ],
          });
          await Promise.resolve();
        });
        await view.findByText(
          (_text, element) =>
            element?.tagName === "P" && element.textContent?.startsWith("Appended ") === true,
        );
        await act(async () => {
          setPhase("completed");
          await Promise.resolve();
        });
        await view.findByText(
          (_text, element) => element?.tagName === "P" && element.textContent === "Appended tail",
        );
        await waitFor(() => expect(view.getByRole("button", { name: label })).toBe(button));
        expect(button.closest("[data-content-search-unit-key]")).toBe(unit);
        expect(document.activeElement).toBe(button);
        expect(Math.abs(button.getBoundingClientRect().top - rect.top)).toBeLessThanOrEqual(1);
        await waitFor(() => expect(markedText()).toBe("needle phrase"));
        await act(async () => {
          fireEvent.click(button);
          await Promise.resolve();
        });
        expect(native.opened).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ path, hostId: "local" }),
        );
        expect(readTurn).not.toHaveBeenCalled();
      } finally {
        highlights.clear();
        view.unmount();
        native.dispose();
      }
    },
  );
});

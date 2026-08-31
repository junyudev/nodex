import { describe, expect, it } from "vitest";
import type { ThreadSearchOccurrence } from "@nodex/codex-app-server-protocol/v2";
import type { VisibleConversationTurnEntry } from "../selectors";
import type { ThreadSearchUnitModel } from "../thread-stage-types";
import {
  isLocalConversationPersistedSearchMatchMeta,
  projectLocalConversationPersistedSearchResult,
  resolveLocalConversationPersistedSearchTarget,
} from "./local-conversation-persisted-search";

const occurrence = (overrides: Partial<ThreadSearchOccurrence> = {}): ThreadSearchOccurrence => ({
  turnId: "turn-older",
  itemId: "item-user-2",
  snippet: "needle",
  snippetMatchRange: { start: 0, end: 6 },
  turnCursor: "turn-cursor",
  ...overrides,
});

describe("persisted conversation search projection", () => {
  it("preserves stable server identities and advertises a capped first page", () => {
    const projected = projectLocalConversationPersistedSearchResult({
      contextId: "conversation:thread-1",
      limit: 2,
      page: {
        threadId: "thread-1",
        query: "needle",
        hostId: "host-1",
        hostGeneration: 7,
        topologyGeneration: 11,
        occurrences: [
          occurrence(),
          occurrence({ snippet: "needle", snippetMatchRange: { start: 0, end: 6 } }),
          occurrence({ itemId: "item-2" }),
        ],
        capped: false,
      },
    });

    expect(projected).toMatchObject({ query: "needle", totalMatches: 2, capped: true });
    expect(projected.matches[0]?.id).toContain('"turn-older","item-user-2",0');
    expect(projected.matches[1]?.id).toContain('"turn-older","item-user-2",1');
    expect(projected.matches[0]?.id).not.toBe(projected.matches[1]?.id);
    expect(isLocalConversationPersistedSearchMatchMeta(projected.matches[0]?.meta)).toBe(true);
    expect(projected.matches[0]?.meta).toMatchObject({
      kind: "persisted",
      threadId: "thread-1",
      hostGeneration: 7,
      topologyGeneration: 11,
      itemOccurrenceIndex: 0,
    });
  });

  it("resolves the exact hydrated user item and occurrence inside a grouped turn", () => {
    const entry = {
      turnKey: "turn-older",
      turn: {
        items: [
          { itemId: "item-user-1", kind: "userMessage" },
          { itemId: "item-assistant", kind: "assistantMessage" },
          { itemId: "item-user-2", kind: "userMessage" },
        ],
      },
    } as unknown as VisibleConversationTurnEntry;
    const units: ThreadSearchUnitModel[] = [
      {
        key: "turn-older:user:0",
        turnId: "turn-older",
        turnKey: "turn-older",
        text: "first user",
        blockType: "userMessage",
      },
      {
        key: "turn-older:user:1",
        turnId: "turn-older",
        turnKey: "turn-older",
        text: "needle wrong; beta needle right",
        blockType: "userMessage",
      },
    ];

    expect(
      resolveLocalConversationPersistedSearchTarget({
        entry,
        occurrence: occurrence({
          snippet: "…beta needle right…",
          snippetMatchRange: { start: 6, end: 12 },
        }),
        itemOccurrenceIndex: 0,
        query: "needle",
        units,
      }),
    ).toEqual({
      turnKey: "turn-older",
      unitKey: "turn-older:user:1",
      occurrenceIndex: 1,
    });
  });

  it("fails closed until the selected item is resident", () => {
    const entry = {
      turnKey: "turn-older",
      turn: { items: [{ itemId: "another-item", kind: "userMessage" }] },
    } as unknown as VisibleConversationTurnEntry;

    expect(
      resolveLocalConversationPersistedSearchTarget({
        entry,
        occurrence: occurrence(),
        itemOccurrenceIndex: 0,
        query: "needle",
        units: [],
      }),
    ).toBeNull();
  });

  it("uses the server item occurrence order when snippets are textually identical", () => {
    const entry = {
      turnKey: "turn-older",
      turn: { items: [{ itemId: "item-user-2", kind: "userMessage" }] },
    } as unknown as VisibleConversationTurnEntry;
    const units: ThreadSearchUnitModel[] = [
      {
        key: "turn-older:user:0",
        turnId: "turn-older",
        turnKey: "turn-older",
        text: "needle between needle",
        blockType: "userMessage",
      },
    ];

    expect(
      resolveLocalConversationPersistedSearchTarget({
        entry,
        occurrence: occurrence(),
        itemOccurrenceIndex: 1,
        query: "needle",
        units,
      }),
    ).toEqual({
      turnKey: "turn-older",
      unitKey: "turn-older:user:0",
      occurrenceIndex: 1,
    });
  });
});

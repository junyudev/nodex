import { describe, expect, it } from "vitest";
import type { ThreadSearchOccurrence } from "@nodex/codex-app-server-protocol/v2";
import type { VisibleConversationTurnEntry } from "../selectors";
import type { ThreadSearchUnitModel } from "../thread-stage-types";
import {
  isLocalConversationPersistedSearchMatchMeta,
  mergeLocalConversationSearchResults,
  projectLocalConversationPersistedSearchResult,
  resolveLocalConversationPersistedSearchTarget,
  waitForLocalConversationPersistedSearchTarget,
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
  it("resolves a resident commentary occurrence to its native assistant unit rather than the final answer", () => {
    const entry = {
      turnKey: "turn-older",
      turn: {
        items: [
          {
            itemId: "projected-commentary",
            rawItemId: "native-commentary",
            kind: "assistantMessage",
          },
          { itemId: "final", kind: "assistantMessage" },
        ],
      },
    } as unknown as VisibleConversationTurnEntry;
    const units: ThreadSearchUnitModel[] = [
      {
        key: "turn-older:assistant:final",
        itemId: "final",
        turnKey: "turn-older",
        turnId: "turn-older",
        text: "final needle",
        blockType: "assistantMessage",
      },
      {
        key: "turn-older:assistant:native-commentary",
        itemId: "native-commentary",
        turnKey: "turn-older",
        turnId: "turn-older",
        text: "commentary needle",
        blockType: "assistantMessage",
      },
    ];
    expect(
      resolveLocalConversationPersistedSearchTarget({
        entry,
        occurrence: occurrence({
          itemId: "native-commentary",
          snippet: "commentary needle",
          snippetMatchRange: { start: 11, end: 17 },
        }),
        query: "needle",
        itemOccurrenceIndex: 0,
        units,
      }),
    ).toEqual({
      turnKey: "turn-older",
      unitKey: "turn-older:assistant:native-commentary",
      occurrenceIndex: 0,
    });
  });
  it("keeps realtime and live local matches when native search succeeds with no occurrences", () => {
    const resident = {
      query: "needle",
      totalMatches: 1,
      capped: false,
      matches: [
        {
          id: "voice",
          contextId: "thread",
          domain: "conversation" as const,
          ordinal: 0,
          meta: { turnKey: "realtime:voice", unitKey: "voice-unit", occurrenceIndex: 0 },
        },
      ],
    };
    expect(
      mergeLocalConversationSearchResults({
        resident,
        persisted: { ...resident, matches: [], totalMatches: 0 },
        resolveResidentTarget: () => null,
      }),
    ).toEqual(resident);
  });

  it("preserves native result order, reuses resident reveal identity and deduplicates its occurrence", () => {
    const residentTarget = {
      turnKey: "resident",
      unitKey: "resident:assistant",
      occurrenceIndex: 0,
    };
    const local = {
      id: "resident",
      contextId: "thread",
      domain: "conversation" as const,
      ordinal: 0,
      meta: residentTarget,
    };
    const voice = {
      ...local,
      id: "voice",
      meta: { ...residentTarget, turnKey: "realtime:voice", unitKey: "voice-unit" },
    };
    const persisted = projectLocalConversationPersistedSearchResult({
      contextId: "thread",
      limit: 250,
      page: {
        threadId: "thread",
        hostId: "local",
        hostGeneration: 1,
        topologyGeneration: 1,
        query: "needle",
        capped: false,
        occurrences: [occurrence({ turnId: "older" }), occurrence({ turnId: "resident" })],
      },
    });
    const result = mergeLocalConversationSearchResults({
      resident: { query: "needle", totalMatches: 2, matches: [local, voice], capped: false },
      persisted,
      resolveResidentTarget: (meta) =>
        meta.occurrence.turnId === "resident" ? residentTarget : null,
    });
    expect(result.matches.map((match) => match.id)).toEqual([
      persisted.matches[0]!.id,
      "resident",
      "voice",
    ]);
    expect(result.totalMatches).toBe(3);
    expect(result.matches[1]?.meta).toBe(residentTarget);
  });
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

it("waits beyond five renders for the actual selected projection", async () => {
  let renders = 0;
  const target = { turnKey: "turn", unitKey: "item", occurrenceIndex: 0 };
  const result = await waitForLocalConversationPersistedSearchTarget({
    signal: new AbortController().signal,
    readTarget: () => (renders >= 8 ? target : null),
    waitForRender: async () => {
      renders += 1;
    },
  });
  expect(result).toBe(target);
  expect(renders).toBe(8);
});

it("cancels projection waiting even when the next render is suspended", async () => {
  const controller = new AbortController();
  const pending = waitForLocalConversationPersistedSearchTarget({
    signal: controller.signal,
    readTarget: () => null,
    waitForRender: () => new Promise(() => {}),
  });
  controller.abort();
  await expect(pending).resolves.toBeNull();
});

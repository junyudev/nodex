import { describe, expect, test } from "vite-plus/test";
import type { ConversationPromptTurn } from "../conversation-runtime";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { buildLocalConversationPromptRailItems } from "./local-conversation-prompt-rail-model";

const indexedTurns = (count: number): ConversationPromptTurn[] =>
  Array.from({ length: count }, (_, index) => ({ turnId: `turn-${index + 1}` }));

const residentItem = (
  turnId: string | null,
  label: string,
  id = `${turnId}:user:0`,
): ThreadUserMessageNavigationItem => ({
  id,
  turnId,
  turnKey: turnId ?? id,
  ordinal: 1,
  label,
  responsePreview: "resident response",
  outputs: [],
  isHeartbeat: false,
});

describe("local conversation prompt rail model", () => {
  test("keeps one item-free marker per indexed Turn and replaces only resident or previewed Turns", () => {
    const resident = residentItem("turn-999", "resident prompt");
    const items = buildLocalConversationPromptRailItems({
      turns: indexedTurns(1_000),
      residentItems: [resident],
      previewsByTurnId: new Map([
        [
          "turn-4",
          [
            {
              itemId: "prompt-4",
              promptPreview: "lazy prompt",
              responsePreview: "lazy response",
              isHeartbeat: false,
            },
          ],
        ],
      ]),
    });

    expect(items).toHaveLength(1_000);
    expect(items[0]).toMatchObject({
      label: "Load prompt preview",
      promptRailShell: { turnId: "turn-1", hasPreview: false },
    });
    expect(items[3]).toMatchObject({
      id: "turn-4:user:0",
      label: "lazy prompt",
      responsePreview: "lazy response",
      promptRailShell: { turnId: "turn-4", hasPreview: true },
    });
    expect(items[998]).toEqual({ ...resident, ordinal: 999 });
  });

  test("shows previews an owner read with its index without another read", () => {
    const [item] = buildLocalConversationPromptRailItems({
      turns: [
        {
          turnId: "run-1",
          previews: [
            {
              itemId: "message-1",
              promptPreview: "Align the theme",
              responsePreview: "Aligned",
              isHeartbeat: false,
            },
          ],
        },
      ],
      residentItems: [],
      previewsByTurnId: new Map(),
    });

    expect(item).toMatchObject({
      label: "Align the theme",
      responsePreview: "Aligned",
      promptRailShell: { turnId: "run-1", hasPreview: true },
    });
  });

  test("keeps resident markers outside the index in conversation order", () => {
    const items = buildLocalConversationPromptRailItems({
      turns: indexedTurns(3),
      residentItems: [
        residentItem(null, "imported prompt", "imported:user:0"),
        residentItem("turn-2", "second prompt"),
        residentItem("turn-unindexed", "between prompt"),
        residentItem("turn-3", "third prompt"),
        residentItem("turn-new", "newest prompt"),
      ],
      previewsByTurnId: new Map(),
    });

    expect(items.map((item) => item.label)).toEqual([
      "Load prompt preview",
      "imported prompt",
      "second prompt",
      "between prompt",
      "third prompt",
      "newest prompt",
    ]);
    expect(items.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("navigates resident messages alone without an index", () => {
    const resident = residentItem("turn-1", "resident prompt");
    expect(
      buildLocalConversationPromptRailItems({
        turns: null,
        residentItems: [resident],
        previewsByTurnId: new Map(),
      }),
    ).toEqual([resident]);
  });
});

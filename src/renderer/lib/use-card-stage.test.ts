import { describe, expect, test } from "bun:test";

import {
  closeCardStageState,
  openCardStageState,
  type CardStageState,
} from "./use-card-stage";

const CLOSED_STATE: CardStageState = {
  open: false,
  projectId: "",
  cardId: null,
};

describe("card stage pointer state helpers", () => {
  test("openCardStageState sets project/card pointer", () => {
    const opened = openCardStageState(CLOSED_STATE, "default", "card-1");

    expect(JSON.stringify(opened)).toBe(JSON.stringify({
      open: true,
      projectId: "default",
      cardId: "card-1",
    }));
  });

  test("openCardStageState ignores empty pointer inputs", () => {
    const noProject = openCardStageState(CLOSED_STATE, "", "card-1");
    const noCard = openCardStageState(CLOSED_STATE, "default", "");

    expect(noProject).toBe(CLOSED_STATE);
    expect(noCard).toBe(CLOSED_STATE);
  });

  test("closeCardStageState only flips open flag", () => {
    const opened = openCardStageState(CLOSED_STATE, "default", "card-1");
    const closed = closeCardStageState(opened);

    expect(JSON.stringify(closed)).toBe(JSON.stringify({
      open: false,
      projectId: "default",
      cardId: "card-1",
    }));
  });
});

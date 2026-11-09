import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { PageTurn, TurnReason } from "../../../shared/page-turn";
import { render } from "@/test/dom";
import type { PageTurnHolder } from "@/lib/page-turn-phrase";
import { PageTurnChip } from "./page-turn-chip";
const turn = (
  reason: TurnReason | null,
  actor: PageTurn["actor"] = { kind: "member", member_id: "me" },
): PageTurn => ({ page_id: "page", actor, reason, since: "now", episode: "episode" });
const you: PageTurnHolder = { you: true, name: "You" };
describe("a card's turn", () => {
  test("names whose move it is with the reason's glyph", () => {
    const view = render(<PageTurnChip turn={turn("question")} holder={you} />);
    const chip = screen.getByText("Needs your answer").closest("[data-page-turn]");
    expect(chip?.getAttribute("data-page-turn")).toBe("question");
    expect(view.container.querySelector("svg")).toBeTruthy();
  });
  test("a pause says who paused how much", () => {
    render(
      <PageTurnChip
        turn={{
          ...turn("paused"),
          hold: {
            scope: { kind: "project", project_id: "project" },
            actor: "me",
            revision: 1,
            paused_at: "now",
          },
        }}
        holder={you}
      />,
    );
    expect(screen.getByText("Paused", { exact: true })).toBeTruthy();
    expect(screen.getByLabelText("You paused this Project")).toBeTruthy();
  });
  test("names queue and prerequisite actors", async () => {
    const open = vi.fn();
    const view = render(
      <PageTurnChip turn={turn("queued", { kind: "queue", position: 2 })} holder={you} />,
    );
    expect(screen.getByText("Queued · 2nd")).toBeTruthy();
    view.rerender(
      <PageTurnChip
        turn={turn("waiting_on_prerequisite", {
          kind: "page",
          page_id: "prerequisite",
          key: "NODEX-2",
        })}
        holder={you}
        onOpenPage={open}
      />,
    );
    expect(screen.getByRole("link", { name: "Waiting for NODEX-2" }).getAttribute("href")).toBe(
      "nodex://pages/prerequisite?spaceId=test-space",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Waiting for NODEX-2" }));
      await Promise.resolve();
    });
    expect(open).toHaveBeenCalledWith("prerequisite");
  });
  test("offers a single Start that does not open the card", async () => {
    const start = vi.fn();
    const card = vi.fn();
    render(
      <div onClick={card}>
        <PageTurnChip turn={turn("ready_to_start")} holder={you} onStart={start} />
      </div>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledOnce();
    expect(card).not.toHaveBeenCalled();
  });
  test("ready work without a Start control reads as ready", () => {
    render(<PageTurnChip turn={turn("ready_to_start")} holder={you} />);
    expect(screen.getByText("Ready to start")).toBeTruthy();
  });
  test("leaves no chip for none", () => {
    const view = render(<PageTurnChip turn={turn(null, { kind: "none" })} holder={you} />);
    expect(view.container.childElementCount).toBe(0);
  });
});

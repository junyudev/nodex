import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { useMotionValue } from "motion/react";
import { describe, expect, test } from "vite-plus/test";
import { CODEX_SUMMARY_SHIFT_X, useCodexAnimatedContentShift } from "@/lib/codex-panel-motion";
import { LocalConversationNewThreadHomeScreen } from "./local-conversation-new-thread-home-screen";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
} from "./local-conversation-thread-scroll-controller";
import "../../../globals.css";

interface Presentation {
  width: number;
  pinned?: boolean;
  reducedMotion?: boolean;
  threadId?: string;
  visible?: boolean;
  surface?: "home" | "loading" | "thread";
}

function Conversation({
  width,
  pinned = true,
  reducedMotion = false,
  threadId = "thread-one",
  visible = true,
  surface = "thread",
}: Presentation) {
  const mainContentWidth = useMotionValue(width);
  useLayoutEffect(() => mainContentWidth.set(width), [mainContentWidth, width]);
  const contentX = useCodexAnimatedContentShift({
    mainContentWidth,
    pinnedOpen: pinned,
    reducedMotion,
    resetKey: threadId,
    fullWidth: !visible,
  });
  return (
    <div style={{ width, height: 800 }}>
      {surface === "home" ? (
        <LocalConversationNewThreadHomeScreen
          contentShiftX={contentX}
          hero={<h1>Start a chat</h1>}
          footer={<textarea aria-label="Message" />}
        />
      ) : (
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationThreadScrollLayout
            contentX={contentX}
            footer={<textarea aria-label="Message" />}
          >
            {surface === "loading" ? (
              <div role="status">Loading chat</div>
            ) : (
              <p>A response remains aligned with the composer while the summary moves.</p>
            )}
          </LocalConversationThreadScrollLayout>
        </EnsureLocalConversationThreadScrollController>
      )}
    </div>
  );
}

function readTranslation(element: Element): number {
  return new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
}

function readPositions(container: HTMLElement): { body: number; footer: number } {
  const home = container.querySelector("[data-new-thread-home-main='true']");
  if (home) {
    const x = readTranslation(home.parentElement!.parentElement!);
    return { body: x, footer: x };
  }
  const viewport = container.querySelector("[data-local-conversation-thread-body='true']")!;
  const footer = container.querySelector("[data-thread-scroll-footer='true']")!;
  return {
    body: readTranslation(viewport.firstElementChild!),
    footer: readTranslation(footer),
  };
}

async function frame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function samplePositions(container: HTMLElement, count = 8) {
  const positions: ReturnType<typeof readPositions>[] = [];
  await act(async () => {
    for (let index = 0; index < count; index += 1) {
      await frame();
      positions.push(readPositions(container));
    }
  });
  for (const position of positions) {
    expect(position.body).toBeCloseTo(position.footer, 4);
  }
  return positions;
}

async function update(view: ReturnType<typeof render>, presentation: Presentation) {
  await act(async () => {
    view.rerender(<Conversation {...presentation} />);
  });
}

async function expectSettled(container: HTMLElement, x: number) {
  await waitFor(() => {
    const position = readPositions(container);
    expect(position.body).toBeCloseTo(x, 2);
    expect(position.footer).toBeCloseTo(x, 2);
  });
}

describe("conversation summary placement motion", () => {
  test("crosses both responsive boundaries and pin changes without snapping the transcript or footer", async () => {
    const view = render(<Conversation width={1536} />);
    await expectSettled(view.container, 0);

    await update(view, { width: 1535 });
    const entering = await samplePositions(view.container);
    expect(entering.some(({ body }) => body < -1 && body > CODEX_SUMMARY_SHIFT_X + 1)).toBe(true);
    await expectSettled(view.container, CODEX_SUMMARY_SHIFT_X);

    await update(view, { width: 1095 });
    const leaving = await samplePositions(view.container, 4);
    expect(leaving.some(({ body }) => body > CODEX_SUMMARY_SHIFT_X + 1 && body < -1)).toBe(true);

    // Reverse a live resize before it settles; the next frame continues from the painted position.
    const beforeReverse = readPositions(view.container).body;
    await update(view, { width: 1096 });
    expect(Math.abs(readPositions(view.container).body - beforeReverse)).toBeLessThan(30);
    await samplePositions(view.container);
    await expectSettled(view.container, CODEX_SUMMARY_SHIFT_X);

    await update(view, { width: 1096, pinned: false });
    const unpinning = await samplePositions(view.container);
    expect(unpinning.some(({ body }) => body > CODEX_SUMMARY_SHIFT_X + 1 && body < -1)).toBe(true);
    await expectSettled(view.container, 0);
  });

  test("keeps the current animation through Home, loading, and transcript presentation changes", async () => {
    const view = render(<Conversation width={1536} surface="home" />);
    await update(view, { width: 1535, surface: "home" });
    const home = await samplePositions(view.container, 3);
    expect(home.some(({ body }) => body < -1 && body > CODEX_SUMMARY_SHIFT_X + 1)).toBe(true);

    const beforeLoading = readPositions(view.container).body;
    await update(view, { width: 1535, surface: "loading" });
    expect(Math.abs(readPositions(view.container).body - beforeLoading)).toBeLessThan(30);
    await samplePositions(view.container, 3);

    const beforeTranscript = readPositions(view.container).body;
    await update(view, { width: 1535, surface: "thread" });
    expect(Math.abs(readPositions(view.container).body - beforeTranscript)).toBeLessThan(30);
    await samplePositions(view.container);
    await expectSettled(view.container, CODEX_SUMMARY_SHIFT_X);
  });

  test("snaps reduced motion, a different chat, and a hidden or restored primary viewport", async () => {
    const view = render(<Conversation width={1536} />);
    await update(view, { width: 1535 });
    await samplePositions(view.container, 3);
    await update(view, { width: 1535, reducedMotion: true });
    expect((await samplePositions(view.container, 2)).at(-1)?.body).toBe(CODEX_SUMMARY_SHIFT_X);

    await update(view, { width: 1536, threadId: "thread-two" });
    expect((await samplePositions(view.container, 2)).at(-1)?.body).toBe(0);

    await update(view, { width: 1535, threadId: "thread-two" });
    await samplePositions(view.container, 3);
    await update(view, { width: 0, threadId: "thread-two", visible: false });
    expect((await samplePositions(view.container, 2)).at(-1)?.body).toBe(0);

    // The scene can restore before its measured width arrives in the next frame.
    await update(view, { width: 0, threadId: "thread-two", visible: true });
    expect((await samplePositions(view.container, 2)).at(-1)?.body).toBe(0);
    await update(view, { width: 1535, threadId: "thread-two", visible: true });
    expect((await samplePositions(view.container, 2)).at(-1)?.body).toBe(CODEX_SUMMARY_SHIFT_X);
  });
});

import type { Locator, Page } from "@playwright/test";

const summarize = (values: readonly number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    medianMs: ordered[Math.floor(ordered.length / 2)],
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
  };
};

export async function measureTranscriptWheel(page: Page, count = 30) {
  const viewport = page.locator("[data-local-conversation-thread-body=true]");
  const box = await viewport.boundingBox();
  if (!box) throw new Error("Transcript viewport is unavailable");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  type WheelState = {
    pending: { startedAt: number; scheduled: boolean } | null;
    samples: Array<{
      latencyMs: number;
      eventToTwoRafMs: number;
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
    }>;
  };
  type MeasuredElement = HTMLElement & { readOnlyWheel: WheelState };
  await viewport.evaluate((element) => {
    const target = element as MeasuredElement;
    target.readOnlyWheel = { pending: null, samples: [] };
    element.addEventListener(
      "scroll",
      () => {
        const state = target.readOnlyWheel;
        const pending = state.pending;
        if (!pending || pending.scheduled) return;
        pending.scheduled = true;
        const eventAt = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            state.samples.push({
              latencyMs: performance.now() - pending.startedAt,
              eventToTwoRafMs: performance.now() - eventAt,
              scrollTop: element.scrollTop,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            });
            state.pending = null;
          }),
        );
      },
      { passive: true },
    );
  });
  for (let index = 0; index < count; index += 1) {
    const position = await viewport.evaluate((element) => ({
      top: element.scrollTop,
      minimum: element.clientHeight - element.scrollHeight,
    }));
    const direction =
      (index % 2 === 0 || position.top >= -1) && position.top > position.minimum + 1 ? -220 : 220;
    await viewport.evaluate((element) => {
      (element as MeasuredElement).readOnlyWheel.pending = {
        startedAt: performance.now(),
        scheduled: false,
      };
    });
    await page.mouse.wheel(0, direction);
    await viewport.evaluate(
      (element, count) =>
        new Promise<void>((resolve, reject) => {
          const deadline = performance.now() + 5_000;
          const check = () => {
            if ((element as MeasuredElement).readOnlyWheel.samples.length > count) return resolve();
            if (performance.now() > deadline)
              return reject(new Error("Wheel produced no settled scroll frame"));
            requestAnimationFrame(check);
          };
          check();
        }),
      index,
    );
  }
  const samples = await viewport.evaluate(
    (element) => (element as MeasuredElement).readOnlyWheel.samples,
  );
  return { samples, ...summarize(samples.map((sample) => sample.latencyMs)) };
}

export async function measureTranscriptFind(
  page: Page,
  input: Locator,
  corpus: "short" | "long",
  count = 30,
) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const target = corpus === "short" ? 5 + (index % 2) : 5_000 + index;
    const term = `Synthetic history ${String(target).padStart(4, "0")}`;
    const wasInDOM = (await page.getByText(term, { exact: true }).count()) > 0;
    const startedAt = performance.now();
    await input.fill(term);
    await page.waitForFunction(
      (term) =>
        [...document.querySelectorAll("mark.codex-thread-find-active")].some((element) => {
          if (element.textContent !== term) return false;
          const rect = element.getBoundingClientRect();
          const viewport = element
            .closest("[data-local-conversation-thread-body=true]")
            ?.getBoundingClientRect();
          return (
            viewport && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
          );
        }),
      term,
      { timeout: 30_000 },
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    samples.push({ term, wasInDOM, activeHighlightPaintMs: performance.now() - startedAt });
  }
  return { samples, ...summarize(samples.map((sample) => sample.activeHighlightPaintMs)) };
}

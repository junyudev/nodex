import { expect, test } from "vite-plus/test";
import { buildInboxDecisionTimeline, INBOX_CARD_EXIT_MS } from "./inbox-decision-timeline";

test("anticipates each next button before the previous card folds, then clicks when it arrives", () => {
  const ids = ["passkeys", "changelog", "digest", "darkmode", "coldstart", "webhooks"];
  const { cues, clearAt } = buildInboxDecisionTimeline(ids, 12000);
  const at = (id: string) => cues.find((cue) => cue.id === id)!.at;

  for (const [index, id] of ids.entries()) {
    expect(at(`decided:${id}`)).toBeGreaterThan(at(`press:${id}`));
    expect(at(`folded:${id}`)).toBeGreaterThan(at(`decided:${id}`));
    if (index === 0) continue;
    const previous = ids[index - 1];
    expect(at(`aim:${id}`)).toBeGreaterThan(at(`decided:${previous}`));
    expect(at(`aim:${id}`)).toBeLessThan(at(`folded:${previous}`));
    expect(at(`press:${id}`)).toBeGreaterThan(at(`folded:${previous}`) + INBOX_CARD_EXIT_MS);
    const interval = at(`press:${id}`) - at(`press:${previous}`);
    expect(interval).toBeGreaterThanOrEqual(600);
    expect(interval).toBeLessThanOrEqual(850);
  }
  expect(at("press:passkeys") - at("aim:passkeys")).toBeLessThanOrEqual(400);
  expect(clearAt).toBeGreaterThan(at("folded:webhooks") + INBOX_CARD_EXIT_MS);
  expect(cues.map((cue) => cue.at)).toEqual(cues.map((cue) => cue.at).sort((a, b) => a - b));
});

test("an empty Inbox is clear immediately, without cursor actions", () => {
  expect(buildInboxDecisionTimeline([], 12000)).toEqual({ cues: [], clearAt: 12000 });
});

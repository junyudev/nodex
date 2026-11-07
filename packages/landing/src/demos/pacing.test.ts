import { expect, test } from "vite-plus/test";
import { SCRIPT as agents } from "./AgentsDemo";
import type { CaptureDemoId } from "./capture-demos";
import { SCRIPT as fanout } from "./FanOutDemo";
import { SCRIPT as hero } from "./HeroDemo";
import { SCRIPT as mobile } from "./MobileDemo";
import { SCRIPT as pages } from "./PagesDemo";
import { SCRIPT as tidy } from "./TidyDemo";
import { PACING, pacingIssues, type TimelineScript } from "./timeline";

const DEMOS: Record<CaptureDemoId, TimelineScript> = { hero, fanout, agents, pages, tidy, mobile };

test.each(Object.entries(DEMOS))("the %s demo never leaves a visitor waiting", (_, script) => {
  expect(pacingIssues(script)).toEqual([]);
});

test("names a late first beat, a long wait, and a long final hold", () => {
  const script = {
    cues: [
      { id: "open", at: PACING.firstBeatMs + 1 },
      { id: "answer", at: PACING.firstBeatMs + 1 + PACING.holdMs + 1 },
    ],
    durationMs: PACING.firstBeatMs + PACING.holdMs + PACING.tailMs + 3,
  };
  expect(pacingIssues(script)).toEqual([
    `first beat at ${PACING.firstBeatMs + 1} ms`,
    `waits ${PACING.holdMs + 1} ms after open`,
    `holds its last frame for ${PACING.tailMs + 1} ms`,
  ]);
});

test("a script right at every limit keeps moving", () => {
  const script = {
    cues: [
      { id: "answer", at: PACING.firstBeatMs + PACING.holdMs },
      { id: "open", at: PACING.firstBeatMs },
    ],
    durationMs: PACING.firstBeatMs + PACING.holdMs + PACING.tailMs,
  };
  expect(pacingIssues(script)).toEqual([]);
});

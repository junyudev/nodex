import { expect, test } from "vite-plus/test";
import { buildInboxBurstTimeline, composerTextAt, composingAt } from "./inbox-burst-timeline";
import { lumen } from "./lumen";

const START = 200;
for (const [locale, { inbox }] of Object.entries(lumen)) {
  const burst = buildInboxBurstTimeline(inbox, START);
  const at = (id: string) => burst.cues.find((cue) => cue.id === id)!.at;

  test(`${locale} gets to the first plan within a second and plans the whole burst within three`, () => {
    expect(at(`planned:${inbox[0]!.id}`) - START).toBeLessThanOrEqual(1000);
    expect(burst.plannedAt - START).toBeLessThanOrEqual(3000);
    expect(burst.plannedAt).toBe(at(`planned:${inbox.at(-1)!.id}`));
  });

  test(`${locale} sends one message at a time and plans each while the rest are still arriving`, () => {
    for (const [index, entry] of burst.entries.entries()) {
      expect(at(`sent:${entry.id}`)).toBe(entry.sent);
      expect(at(`planned:${entry.id}`)).toBeGreaterThan(entry.sent);
      const next = burst.entries[index + 1];
      if (!next) continue;
      expect(next.start).toBeGreaterThan(entry.sent);
      expect(at(`planned:${next.id}`)).toBeGreaterThan(at(`planned:${entry.id}`));
    }
    const last = burst.entries.at(-1)!;
    expect(at(`planned:${inbox[0]!.id}`)).toBeLessThan(last.sent);
    expect(burst.cues.map((cue) => cue.at)).toEqual(
      burst.cues.map((cue) => cue.at).sort((a, b) => a - b),
    );
  });

  test(`${locale} the composer fills with each message and shows it whole before it sends`, () => {
    const [first, second] = burst.entries;
    expect(composerTextAt(burst, first!.start - 1)).toBe("");
    expect(composerTextAt(burst, first!.start + 1)).toBe(first!.text.slice(0, 1));
    expect(composerTextAt(burst, first!.sent - 1)).toBe(first!.text);
    expect(composerTextAt(burst, first!.sent)).toBe("");
    expect(composerTextAt(burst, second!.start + 1)).toBe(second!.text.slice(0, 1));
  });

  test(`${locale} the placeholder stays away for the whole burst, even between messages`, () => {
    const [first, second] = burst.entries;
    expect(composingAt(burst, first!.start - 1)).toBe(false);
    expect(composingAt(burst, (first!.sent + second!.start) / 2)).toBe(true);
    expect(composingAt(burst, burst.entries.at(-1)!.sent)).toBe(false);
    expect(composingAt(buildInboxBurstTimeline([], START), START)).toBe(false);
  });
}

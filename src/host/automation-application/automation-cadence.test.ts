import { describe, expect, test } from "vite-plus/test";
import { computeAutomationIntervalMs } from "./automation-cadence";

describe("heartbeat cooldown cadence", () => {
  test.each([
    ["FREQ=MINUTELY;INTERVAL=5", 300_000],
    ["FREQ=HOURLY;INTERVAL=2;BYMINUTE=0", 7_200_000],
    ["FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR,SA,SU", 3_600_000],
    ["FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR", null],
    ["FREQ=HOURLY;BYMINUTE=30", null],
    ["FREQ=DAILY;BYHOUR=9", null],
    [null, null],
  ] as const)("%s retains its interval semantics", (rrule, expected) => {
    expect(computeAutomationIntervalMs(rrule)).toBe(expected);
  });
});

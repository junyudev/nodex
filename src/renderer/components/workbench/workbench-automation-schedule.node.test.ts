import { describe, expect, test } from "vite-plus/test";
import {
  buildWorkbenchAutomationScheduleRrule,
  formatWorkbenchAutomationScheduleLabel,
  resolveWorkbenchAutomationScheduleConfig,
  updateWorkbenchAutomationScheduleConfig,
} from "./workbench-automation-schedule";

describe("workbench automation schedule", () => {
  test("resolves daily wall-clock schedules with display labels", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      intervalStyle: "default",
    });

    expect(config.mode).toBe("daily");
    expect(config.time).toBe("09:00");
    expect(formatWorkbenchAutomationScheduleLabel(config)).toBe("Daily at 9:00 AM");
  });

  test("updates weekly schedules and preserves Nodex RRULE payload format", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      intervalStyle: "default",
    });
    const weekly = updateWorkbenchAutomationScheduleConfig({
      config,
      intervalStyle: "default",
      patch: {
        mode: "weekly",
        time: "10:30",
      },
    });

    expect(weekly.mode).toBe("weekly");
    expect(weekly.time).toBe("10:30");
    expect(
      buildWorkbenchAutomationScheduleRrule({
        config: weekly,
        intervalStyle: "default",
      }),
    ).toBe("FREQ=WEEKLY;BYDAY=SU;BYHOUR=10;BYMINUTE=30");
    expect(formatWorkbenchAutomationScheduleLabel(weekly)).toBe("Sundays at 10:30 AM");
  });

  test("names schedules it cannot express as custom", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0",
      intervalStyle: "default",
    });
    expect(formatWorkbenchAutomationScheduleLabel(config)).toBe("Custom schedule");
  });

  test("uses minutely RRULEs for heartbeat intervals", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=MINUTELY;INTERVAL=15",
      intervalStyle: "heartbeat",
    });

    expect(config.mode).toBe("hourly");
    expect(config.intervalMinutes).toBe(15);
    expect(formatWorkbenchAutomationScheduleLabel(config)).toBe("Every 15 minutes");
  });

  test("keeps unknown schedules editable as custom rules", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0",
      intervalStyle: "default",
    });

    expect(config.mode).toBe("custom");
    expect(config.customRrule).toBe("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0");
    expect(
      buildWorkbenchAutomationScheduleRrule({
        config,
        intervalStyle: "default",
      }),
    ).toBe("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0");
  });
});

import { describe, expect, test } from "vite-plus/test";
import type { MobileDevice } from "../../../shared/mobile-access";
import {
  describeDevice,
  describeLastSeen,
  formatPairingCountdown,
  routeAddresses,
} from "./mobile-access-presentation";

const device = (overrides: Partial<MobileDevice> = {}): MobileDevice => ({
  id: "d1",
  name: "iPhone",
  platform: "ios",
  appVersion: "1.2.0",
  pairedAt: 0,
  lastSeenAt: null,
  connected: false,
  notificationsEnabled: false,
  ...overrides,
});

const now = 1_000_000_000;

describe("describeLastSeen", () => {
  test.each([
    [null, "Not connected yet"],
    [now - 30_000, "Seen just now"],
    [now - 60_000, "Seen 1m ago"],
    [now - 3_600_000, "Seen 1h ago"],
    [now - 2 * 86_400_000, "Seen 2d ago"],
    // A clock that moved backwards still reads as just now.
    [now + 5_000, "Seen just now"],
  ])("reads %s", (lastSeenAt, expected) => {
    expect(describeLastSeen(lastSeenAt, now)).toBe(expected);
  });
});

describe("describeDevice", () => {
  test("says a live phone is connected instead of when it was seen", () => {
    expect(
      describeDevice(
        device({ connected: true, notificationsEnabled: true, lastSeenAt: now - 90_000 }),
        now,
      ),
    ).toBe("iOS · Nodex Mobile 1.2.0 · Notifications on · Connected");
  });

  test("names unknown platforms as reported and omits an unknown version", () => {
    expect(describeDevice(device({ platform: "tablet", appVersion: "" }), now)).toBe(
      "tablet · Notifications off · Not connected yet",
    );
  });
});

describe("formatPairingCountdown", () => {
  test("rounds up so a code never shows 0:00 while it still works", () => {
    expect(formatPairingCountdown(now + 245_000, now)).toBe("4:05");
    expect(formatPairingCountdown(now + 1, now)).toBe("0:01");
  });

  test("stops at zero", () => {
    expect(formatPairingCountdown(now - 5_000, now)).toBe("0:00");
  });
});

describe("routeAddresses", () => {
  test("keeps only the address of each route", () => {
    expect(
      routeAddresses(["ws://192.168.1.20:27510/mobile", "ws://100.64.0.2:27510/mobile"]),
    ).toEqual(["192.168.1.20", "100.64.0.2"]);
  });

  test("ignores anything that is not a WebSocket URL", () => {
    expect(routeAddresses(["http://x/", ""])).toEqual([]);
  });
});

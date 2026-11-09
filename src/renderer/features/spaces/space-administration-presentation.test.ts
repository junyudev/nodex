import { describe, expect, it } from "vite-plus/test";
import { parseSpaceInvite } from "../../../shared/space-connection";
import {
  activeDevices,
  describeDevice,
  describeExpiry,
  describeLastSeen,
  joinLinkFor,
  routeHosts,
} from "./space-administration-presentation";

const device = (
  id: string,
  memberId: string,
  createdAt: number,
  revokedAt: number | null = null,
  notificationsEnabled = false,
) => ({
  id,
  member_id: memberId,
  space_id: "space",
  label: id,
  form_factor: "phone" as const,
  created_at: createdAt,
  last_seen: createdAt,
  revoked_at: revokedAt,
  notifications_enabled: notificationsEnabled,
});

describe("Space administration presentation", () => {
  it("reads Core's second-based times at each boundary", () => {
    expect(describeLastSeen(1_000, 1_059)).toBe("Seen just now");
    expect(describeLastSeen(1_000, 1_060)).toBe("Seen 1m ago");
    expect(describeLastSeen(1_000, 1_000 + 3_600)).toBe("Seen 1h ago");
    expect(describeLastSeen(1_000, 1_000 + 86_400)).toBe("Seen 1d ago");
    expect(describeExpiry(1_300, 1_000)).toBe("Works once · expires in 5:00");
    expect(describeExpiry(1_000 + 86_400, 1_000)).toBe("Works once · expires in 24 hours");
    expect(describeExpiry(1_000 + 3_600, 1_000)).toBe("Works once · expires in 1 hour");
    expect(describeExpiry(1_000, 1_005)).toBe("Expired");
  });

  it("lists the reader's own active Devices first and drops revoked ones", () => {
    const devices = [
      device("bob-phone", "bob", 1),
      device("alice-old", "alice", 2, 9),
      device("alice-phone", "alice", 3),
    ];
    expect(activeDevices(devices, "alice").map((entry) => entry.id)).toEqual([
      "alice-phone",
      "bob-phone",
    ]);
    expect(describeDevice(devices[0]!, "Bob", false, 61)).toBe("Bob · Phone · Seen 1m ago");
    expect(describeDevice(devices[0]!, null, false, 1)).toBe("Phone · Seen just now");
    expect(describeDevice(devices[0]!, null, true, 1)).toBe("This computer");
    expect(describeDevice(device("alice-phone", "alice", 1, null, true), null, false, 1)).toBe(
      "Phone · Notifications on · Seen just now",
    );
  });

  it("builds a join link the desktop's Join dialog pins and accepts", () => {
    const fingerprint = "a".repeat(64);
    const link = joinLinkFor("https://192.168.1.4:8443", fingerprint);
    expect(parseSpaceInvite(link)).toEqual({ url: "https://192.168.1.4:8443", fingerprint });
    expect(routeHosts(["https://192.168.1.4:8443", "https://100.64.0.2:8443", "bad"])).toEqual([
      "192.168.1.4",
      "100.64.0.2",
    ]);
  });
});

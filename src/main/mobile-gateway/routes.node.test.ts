import { describe, expect, test } from "vitest";
import { isPrivateMobilePeer, mobileHostName, mobileRoutes } from "./routes";

describe("Mobile Access routes", () => {
  test.each([
    ["MacBook-Pro.local", "MacBook-Pro"],
    ["MacBook-Pro.LOCAL", "MacBook-Pro"],
    ["studio", "studio"],
    ["host.local.example", "host.local.example"],
  ])("names %s for a phone as %s", (hostname, name) => {
    expect(mobileHostName(hostname)).toBe(name);
  });

  test.each([
    "127.0.0.1",
    "::1",
    "127.255.255.255",
    "10.0.0.0",
    "10.255.255.255",
    "172.16.0.0",
    "172.31.255.255",
    "192.168.0.0",
    "169.254.255.255",
    "100.64.0.0",
    "100.127.255.255",
    "::ffff:100.64.0.1",
    "0:0:0:0:0:ffff:c0a8:0101",
  ])("admits %s", (address) => expect(isPrivateMobilePeer(address)).toBe(true));

  test.each([
    undefined,
    "0.0.0.0",
    "255.255.255.255",
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.169.0.0",
    "::ffff:192.0.2.1",
    "::127.0.0.1",
    "fe80::1",
    "172.16.00.1",
    "10.999.0.1",
  ])("rejects %s", (address) => expect(isPrivateMobilePeer(address)).toBe(false));

  test("ranks private LAN ahead of tailnet and omits virtual adapters", () => {
    const ip = (address: string, internal = false) => ({ address, family: "IPv4", internal });
    const interfaces = {
      utun1: [ip("100.64.12.1"), ip("10.1.1.1")],
      en0: [ip("192.168.1.2"), ip("100.64.12.1"), ip("8.8.8.8")],
      en1: [ip("169.254.1.2")],
      bridge0: [ip("192.168.2.2")],
      awdl0: [ip("192.168.3.2")],
      docker0: [ip("172.17.0.1")],
      lo0: [ip("127.0.0.1", true)],
    };
    const routes = [
      "ws://192.168.1.2:8000/mobile",
      "ws://169.254.1.2:8000/mobile",
      "ws://100.64.12.1:8000/mobile",
    ];
    expect(mobileRoutes(interfaces, 8000, false)).toEqual(routes);
    expect(mobileRoutes(interfaces, 8000, true)).toEqual([...routes, "ws://127.0.0.1:8000/mobile"]);
  });
});

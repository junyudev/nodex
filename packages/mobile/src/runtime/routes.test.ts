import { describe, expect, it } from "vite-plus/test";

import { orderRoutes } from "./routes";

describe("orderRoutes", () => {
  it("tries the phone's own network, then the tailnet, then the rest", () => {
    expect(
      orderRoutes([
        "https://nodex.example.com/",
        "https://100.100.228.24:8471/",
        "https://203.0.113.9:8443/",
        "https://192.168.31.103:8471/",
        "https://studio.tailnet-abc.ts.net:8471/",
        "https://studio.local:8471/",
        "https://[2001:db8::1]:8443/",
        "https://[fd7a:115c:a1e0::7001:e41c]:8471/",
        "https://10.0.0.4:8471/",
      ]),
    ).toEqual([
      "https://192.168.31.103:8471/",
      "https://studio.local:8471/",
      "https://10.0.0.4:8471/",
      "https://100.100.228.24:8471/",
      "https://studio.tailnet-abc.ts.net:8471/",
      "https://[fd7a:115c:a1e0::7001:e41c]:8471/",
      "https://nodex.example.com/",
      "https://203.0.113.9:8443/",
      "https://[2001:db8::1]:8443/",
    ]);
  });

  it("knows each local address form", () => {
    const local = [
      "https://172.20.1.2:8471",
      "https://127.0.0.1:8471",
      "https://169.254.2.3:8471",
      "https://[fd00::1]:8471",
      "https://[fe80::1]:8471",
      "https://[::1]:8471",
      "https://[::ffff:192.168.1.2]:8471",
      "https://studio.local.:8471",
      "https://studio:8471",
    ];
    for (const route of local)
      expect(orderRoutes(["https://100.64.0.1:8471", route]), route).toEqual([
        route,
        "https://100.64.0.1:8471",
      ]);
  });

  it("knows a tailnet address in each form, and the edges of its range", () => {
    for (const route of [
      "https://100.64.0.1:8471",
      "https://100.127.255.255:8471",
      "https://[::ffff:100.64.1.2]:8471",
      "https://[::ffff:6440:102]:8471",
      "https://studio.tail6f8e36.ts.net.:8471",
    ])
      expect(orderRoutes(["https://203.0.113.9", route, "https://10.0.0.1"]), route).toEqual([
        "https://10.0.0.1",
        route,
        "https://203.0.113.9",
      ]);
    for (const route of ["https://100.63.255.255", "https://100.128.0.1", "https://172.32.0.1"])
      expect(orderRoutes([route, "https://100.64.0.1"]), route).toEqual([
        "https://100.64.0.1",
        route,
      ]);
  });
});

import { describe, expect, test } from "vite-plus/test";
import { linkFaviconHostSchema, resolveLinkSite } from "./link-site";

describe("link sites", () => {
  test.each([
    ["https://github.com/acme/web/pull/7", { kind: "glyph", glyph: "github", host: "github.com" }],
    ["https://www.example.com/a?b=1", { kind: "favicon", host: "example.com" }],
    ["http://docs.python.org/3/", { kind: "favicon", host: "docs.python.org" }],
  ] as const)("%s", (href, site) => {
    expect(resolveLinkSite(href)).toEqual(site);
  });

  test.each([
    "http://localhost:5173",
    "http://app.localhost",
    "http://192.168.1.20/admin",
    "http://10.0.0.4",
    "http://172.20.1.1",
    "http://100.101.102.103",
    "http://[::1]:3000",
    "http://printer.local",
    "http://nas.lan",
    "http://intranet",
  ])("keeps %s on this device", (href) => {
    expect(resolveLinkSite(href)?.kind).toBe("private");
  });

  test.each(["mailto:a@b.c", "file:///tmp/a.html", "nodex://pages/x", "not a url"])(
    "ignores %s",
    (href) => {
      expect(resolveLinkSite(href)).toBeNull();
    },
  );

  test("only well-formed public hostnames reach the icon service", () => {
    expect(linkFaviconHostSchema.safeParse("docs.python.org").success).toBe(true);
    for (const host of ["localhost", "a b.com", "example.com:443", "x.com/path", "EXAMPLE.com"])
      expect(linkFaviconHostSchema.safeParse(host).success).toBe(false);
  });
});

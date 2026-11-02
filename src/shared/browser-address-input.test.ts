import { describe, expect, test } from "vite-plus/test";
import { normalizeBrowserAddressInput } from "./browser-address-input";

describe("normalizeBrowserAddressInput", () => {
  test.each([
    ["", ""],
    [" \t\r\n ", ""],
    [" https://example.com/path ", "https://example.com/path"],
    ["HTTPS://user:secret@example.com/", "HTTPS://user:secret@example.com/"],
    ["custom+v1://host/path", "custom+v1://host/path"],
    ["file:///tmp/page.html", "file:///tmp/page.html"],
    ["about:blank", "about:blank"],
    [" ABOUT:config ", "ABOUT:config"],
    ["/tmp/page.html", "file:///tmp/page.html"],
    [" /tmp/My page.html ", "file:///tmp/My%20page.html"],
    ["/tmp/a%20b?c#d.html", "file:///tmp/a%2520b%3Fc%23d.html"],
    ["/tmp/a/../page.html", "file:///tmp/page.html"],
    ["/tmp/你好.html", "file:///tmp/%E4%BD%A0%E5%A5%BD.html"],
    [String.raw`C:\Users\Jane Doe\page.html`, "file:///C:/Users/Jane%20Doe/page.html"],
    ["C:/Users/Jane/page.html", "file:///C:/Users/Jane/page.html"],
    [String.raw`/C:\Users\Jane\page.html`, "file:///C:/Users/Jane/page.html"],
    [String.raw`\\server\share\My page.html`, "file://server/share/My%20page.html"],
    [String.raw`\\?\UNC\server\share\page.html`, "file://server/share/page.html"],
    [String.raw`\\?\C:\Users\Jane\page.html`, "file:///C:/Users/Jane/page.html"],
    ["C:/page.html\n", "file:///C:/page.html"],
    ["localhost:5173", "http://localhost:5173"],
    ["LOCALHOST/dashboard?q=1#part", "http://LOCALHOST/dashboard?q=1#part"],
    ["app.localhost", "http://app.localhost"],
    ["deep.app.localhost:3000/path", "http://deep.app.localhost:3000/path"],
    ["0.0.0.0:8080", "http://0.0.0.0:8080"],
    ["127.0.0.1:3000/path", "http://127.0.0.1:3000/path"],
    ["[::1]:3000", "http://[::1]:3000"],
    ["localhost/path with spaces", "http://localhost/path with spaces"],
    ["192.168.0.1", "https://192.168.0.1"],
    ["127.1.2.3", "https://127.1.2.3"],
    ["001.002.003.004", "https://001.002.003.004"],
    ["[2001:db8::1]:3000/path", "https://[2001:db8::1]:3000/path"],
    ["host:8080/path", "https://host:8080/path"],
    ["host:99999", "https://host:99999"],
    ["tel:123", "https://tel:123"],
    ["www.example", "https://www.example"],
    ["example.com", "https://example.com"],
    ["foo.co.uk/path?q=1#part", "https://foo.co.uk/path?q=1#part"],
    ["foo.github.io", "https://foo.github.io"],
    ["spark-public.s3.amazonaws.com", "https://spark-public.s3.amazonaws.com"],
    ["EXAMPLE.COM", "https://EXAMPLE.COM"],
    ["例子.中国", "https://例子.中国"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeBrowserAddressInput(input)).toBe(expected);
  });

  test.each([
    "/tmp/page.html\n",
    "\n/tmp/page.html",
    "/tmp/a\nb.html",
    "//server/share/page.html",
    "//example.com",
    "./page.html",
    "C:relative",
    "256.1.2.3",
    "127.999.0.1",
    "[not-ipv6]:3000",
    "[::1]:not-a-port",
    "www.example/path with spaces",
    "WWW.example",
    "example.unknown",
    "co.uk",
    "github.io",
    "localhost.example",
    "user@example.com",
    "javascript:alert(1)",
    "data:text/html,<h1>Hello</h1>",
    "mailto:a@b.c",
    "blob:https://example.com/id",
    "view-source:https://example.com",
    "plain words",
    "what is C++?",
    "go/docs",
  ])("searches for %j", (input) => {
    const result = new URL(normalizeBrowserAddressInput(input));
    expect(result.origin).toBe("https://www.google.com");
    expect(result.pathname).toBe("/search");
    expect([...result.searchParams]).toEqual([["q", input.trim()]]);
  });

  test("uses form encoding for search terms", () => {
    expect(normalizeBrowserAddressInput("plain words")).toBe(
      "https://www.google.com/search?q=plain+words",
    );
  });
});

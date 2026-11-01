import { describe, expect, test } from "vite-plus/test";
import {
  requireCredentialFreeHttpUrl,
  requireCredentialFreeHttpsUrl,
} from "./external-navigation-url";

describe("desktop external navigation", () => {
  test("opens a normalized HTTPS address without credentials", () => {
    expect(requireCredentialFreeHttpsUrl("https://example.com/a?q=1")).toBe(
      "https://example.com/a?q=1",
    );
  });
  test.each([
    "http://example.com",
    "file:///tmp/test.html",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "https://user@example.com",
    `https://example.com/${"a".repeat(8_200)}`,
  ])("rejects non-HTTPS and credential-bearing addresses", (value) => {
    expect(() => requireCredentialFreeHttpsUrl(value)).toThrow();
  });
});

describe("Page report external navigation", () => {
  test.each(["http://example.com/report", "https://example.com/report"])(
    "accepts a credential-free web address: %s",
    (value) => {
      expect(requireCredentialFreeHttpUrl(value)).toBe(value);
    },
  );
  test.each([
    "file:///etc/passwd",
    "app://-/index.html",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "http://user@example.com",
    `https://example.com/${"a".repeat(8_200)}`,
  ])("rejects a privileged or credential-bearing address: %s", (value) => {
    expect(() => requireCredentialFreeHttpUrl(value)).toThrow();
  });
});

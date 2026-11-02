import { describe, expect, test } from "vite-plus/test";
import { parseExternalNavigationUrl } from "./external-navigation";

describe("explicit external navigation", () => {
  test.each([
    "file:///tmp/report.pdf",
    "https://user:secret@example.com/private",
    "http://example.com/",
    "mailto:hello@example.com",
    "sms:+123",
    "tel:+123",
    "vscode://file/tmp/report.txt",
    "vscode-insiders://vscode-remote/ssh-remote+host/tmp/report.txt",
    "onepassword://grant-brokered-access?access_request_reference=abc_123",
    `https://example.com/${"x".repeat(80_000)}`,
  ])("admits an explicit external target: %s", (value) => {
    expect(parseExternalNavigationUrl(value).protocol).toBe(new URL(value).protocol);
  });
  test.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "about:blank",
    "vscode://user:secret@file/tmp/a",
    "vscode://unknown/tmp/a",
    "onepassword://grant-brokered-access/?access_request_reference=abc",
    "unknown://example.com",
  ])("rejects unsupported external targets: %s", (value) => {
    expect(() => parseExternalNavigationUrl(value)).toThrow("This URL cannot be opened externally");
  });
});

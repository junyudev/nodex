import { describe, expect, test } from "vite-plus/test";
import { normalizeEnvironmentAwareAppResourceSource } from "./app-resource-source";

describe("environment-aware generic app resources", () => {
  test("uses Vite /@fs only for HTTP(S) development surfaces", () => {
    expect(normalizeEnvironmentAwareAppResourceSource("/tmp/icon.png", "http:")).toBe(
      "/@fs/tmp/icon.png",
    );
    expect(normalizeEnvironmentAwareAppResourceSource("C:\\Apps\\icon.png", "https:")).toBe(
      "app://fs/@fs/C:/Apps/icon.png",
    );
    expect(normalizeEnvironmentAwareAppResourceSource("/tmp/icon.png", "app:")).toBe(
      "app://fs/@fs/tmp/icon.png",
    );
  });

  test.each([
    "app://fs/@fs/tmp/icon.png",
    "data:image/png;base64,YQ==",
    "https://example.test/icon.png",
    "http://localhost/icon.png",
    "/@fs/tmp/icon.png",
  ])("preserves an already-supported resource source: %s", (source) => {
    expect(normalizeEnvironmentAwareAppResourceSource(source, "http:")).toBe(source);
  });

  test.each(["file:///tmp/icon.png", "blob:https://example.test/id", "relative/icon.png", ""])(
    "rejects a source outside the generic icon contract: %s",
    (source) => {
      expect(normalizeEnvironmentAwareAppResourceSource(source, "app:")).toBe(null);
    },
  );
});

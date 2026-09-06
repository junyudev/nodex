import { describe, expect, it } from "vitest";
import { buildDictationStreamConnectInfo } from "./dictation-stream-connect-info";
import { validateDictationStreamingConnectInfo } from "../../shared/dictation-streaming";

describe("dictation connection preparation", () => {
  it("preserves the configured API prefix and supplies the service's authenticated protocols", () => {
    const info = buildDictationStreamConnectInfo("https://chatgpt.test/backend-api/", "test-token");
    expect(info).toEqual({
      websocketUrl: "wss://chatgpt.test/backend-api/dictation/stream",
      protocols: ["chatgpt-dictation", "openai-bearer.test-token", "codex-desktop"],
    });
    expect(validateDictationStreamingConnectInfo(info).ok).toBe(true);
  });

  it("rejects missing authentication and insecure remote endpoints", () => {
    expect(() =>
      buildDictationStreamConnectInfo("https://chatgpt.test/backend-api", " "),
    ).toThrow();
    expect(() =>
      buildDictationStreamConnectInfo("http://chatgpt.test/backend-api", "token"),
    ).toThrow();
  });
});

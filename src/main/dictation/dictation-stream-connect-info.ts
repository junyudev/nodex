import type { DictationStreamingConnectInfo } from "../../shared/dictation-streaming";
import { resolveChatGptDesktopRequestUrl } from "../codex/chatgpt-desktop-request";

/** Connection preparation is local. The service exposes /dictation/stream, not a connect-info HTTP endpoint. */
export function buildDictationStreamConnectInfo(
  baseUrl: string,
  token: string,
): DictationStreamingConnectInfo {
  if (!token.trim()) throw new Error("Dictation requires a ChatGPT token");
  const url = new URL(resolveChatGptDesktopRequestUrl(baseUrl, "/dictation/stream"));
  if (url.protocol !== "https:") throw new Error("Dictation streaming requires HTTPS");
  url.protocol = "wss:";
  return {
    websocketUrl: url.toString(),
    protocols: ["chatgpt-dictation", `openai-bearer.${token}`, "codex-desktop"],
  };
}

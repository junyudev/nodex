import type { OpenCodeNativeMessage } from "../../platform/node/OpenCodeSdk";

export const openCodeUserMessage = (
  id: string,
  text: string,
  created = 1,
  sessionId = "ses_native",
): OpenCodeNativeMessage => ({
  info: {
    id,
    sessionID: sessionId,
    role: "user",
    time: { created },
    model: { providerID: "moonshot", modelID: "kimi-k3" },
    agent: "build",
  },
  parts: [{ type: "text", id: `prt_${id}`, sessionID: sessionId, messageID: id, text }],
});

export const openCodeAssistantMessage = (
  id: string,
  parentID: string,
  text: string,
  created = 1,
  sessionId = "ses_native",
): OpenCodeNativeMessage => ({
  info: {
    id,
    sessionID: sessionId,
    role: "assistant",
    parentID,
    time: { created, completed: created + 1 },
    providerID: "moonshot",
    modelID: "kimi-k3",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  },
  parts: [{ type: "text", id: `prt_${id}`, sessionID: sessionId, messageID: id, text }],
});

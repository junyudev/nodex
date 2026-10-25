import { expect, it } from "vite-plus/test";
import { AcpInputSchemas } from "./acp-api";

it.each(["acp.sessions.prepareImport", "acp.sessions.import", "acp.sessions.delete"] as const)(
  "%s preserves opaque native identity and the Runtime length limit",
  (method) => {
    for (const sessionId of [" x ", "x", " ", "n".repeat(1024)]) {
      const input = {
        instanceId: "agent",
        sessionId,
        ...(method === "acp.sessions.import" ? { requestId: "request", acceptedAt: 1 } : {}),
      };
      expect(AcpInputSchemas[method].parse(input).sessionId).toBe(sessionId);
    }
    for (const sessionId of ["", "n".repeat(1025)]) {
      expect(
        AcpInputSchemas[method].safeParse({
          instanceId: "agent",
          sessionId,
          ...(method === "acp.sessions.import" ? { requestId: "request", acceptedAt: 1 } : {}),
        }).success,
      ).toBe(false);
    }
  },
);

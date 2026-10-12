import { moveNativeSubtree } from "../../../src/renderer/lib/move-native-subtree";
import { parseMcpAppSandboxHostInitMessage } from "../../../src/shared/mcp-app/mcp-app-sandbox-contract";

interface PingReply {
  type: "fixture-pong";
  requestId: number;
  nonce: string;
  counter: number;
}

interface FixtureOwnerWindow extends Window {
  pingFixturePorts(): Promise<PingReply[]>;
  moveFixtureFrame(target: string): void;
  removeFixtureFrame(): void;
}

const owner = window as unknown as FixtureOwnerWindow;
const ports: MessagePort[] = [];
const pending = new Map<
  number,
  { resolve(reply: PingReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
>();
let sequence = 0;
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || ports.length > 0) return;
  const init = parseMcpAppSandboxHostInitMessage(event.data);
  if (!init || init.initId !== "fixture-init" || event.ports.length !== init.portNames.length + 1)
    return;
  ports.push(...event.ports);
  for (const port of ports) {
    port.onmessage = (message: MessageEvent<PingReply>) => {
      const reply = message.data;
      if (reply.type !== "fixture-pong") return;
      const request = pending.get(reply.requestId);
      if (!request) return;
      pending.delete(reply.requestId);
      clearTimeout(request.timer);
      request.resolve(reply);
    };
    port.start();
  }
});
owner.pingFixturePorts = () =>
  Promise.all(
    ports.map(
      (port) =>
        new Promise<PingReply>((resolve, reject) => {
          const requestId = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("Native fixture port stopped responding"));
          }, 3000);
          pending.set(requestId, { resolve, reject, timer });
          port.postMessage({ type: "fixture-ping", requestId });
        }),
    ),
  );
owner.moveFixtureFrame = (target) => {
  const frame = document.getElementById("fixture-frame");
  const parent = document.getElementById(target);
  if (!frame || !parent) throw new Error("Native fixture surface is missing");
  moveNativeSubtree(frame, parent);
};
owner.removeFixtureFrame = () => document.getElementById("fixture-frame")?.remove();
window.addEventListener("pagehide", () => {
  for (const port of ports) port.close();
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Native fixture owner closed"));
  }
  pending.clear();
});

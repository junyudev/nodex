import { describe, expect, it } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2/ThreadItem";
import {
  isCodexProtocolThreadItem,
  parseCodexProtocolThreadItem,
} from "./codex-protocol-thread-item";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { RpcSession, RpcTarget } from "capnweb";
import {
  ConversationServicePortTransport,
  type ConversationServicePort,
} from "./codex-service-port";

describe("generated Codex ThreadItem runtime boundary", () => {
  it("accepts representative current variants", () => {
    const values = [
      { type: "plan", id: "plan-1", text: "Ship it" },
      {
        type: "userMessage",
        id: "user-1",
        clientId: null,
        content: [{ type: "text", text: "Hello", text_elements: [] }],
      },
      { type: "contextCompaction", id: "compact-1" },
    ] satisfies ThreadItem[];

    expect(values.every(isCodexProtocolThreadItem)).toBe(true);
    expect(parseCodexProtocolThreadItem(values[0])).toEqual({
      ...values[0],
      startedAtMs: null,
      completedAtMs: null,
    });
  });

  it("rejects an invalid nested field", () => {
    expect(
      isCodexProtocolThreadItem({
        type: "userMessage",
        id: "user-1",
        clientId: null,
        content: [{ type: "text", text: 42, text_elements: [] }],
      }),
    ).toBe(false);
  });

  it.each([{ url: "https://example.com/image.png" }, { fileId: "file_123" }])(
    "preserves the image source %j through the runtime boundary",
    (source) => {
      const item = {
        type: "userMessage",
        id: "image-1",
        clientId: null,
        content: [{ type: "image", detail: "original", ...source }],
      } satisfies ThreadItem;

      expect(parseCodexProtocolThreadItem(item)).toEqual({
        ...item,
        startedAtMs: null,
        completedAtMs: null,
      });
    },
  );

  it("rejects an image without a source", () => {
    expect(
      parseCodexProtocolThreadItem({
        type: "userMessage",
        id: "image-1",
        clientId: null,
        content: [{ type: "image", detail: "original" }],
      }),
    ).toBeNull();
  });

  it.each([{ result: "aW1hZ2U=" }, { fileId: "file_123" }])(
    "preserves a generated image source and lifecycle times %j",
    (source) => {
      const item = {
        type: "imageGeneration",
        id: "generated-1",
        status: "completed",
        revisedPrompt: null,
        failure: null,
        generationId: null,
        transparentBackground: false,
        startedAtMs: 1_000,
        completedAtMs: 2_000,
        ...source,
      } satisfies ThreadItem;

      expect(parseCodexProtocolThreadItem(item)).toEqual(item);
    },
  );

  it("rejects a generated image without a source", () => {
    expect(
      parseCodexProtocolThreadItem({
        type: "imageGeneration",
        id: "generated-1",
        status: "completed",
        revisedPrompt: null,
        failure: null,
        generationId: null,
      }),
    ).toBeNull();
  });

  it("rejects an unknown variant instead of casting it into the generated union", () => {
    expect(
      parseCodexProtocolThreadItem({
        type: "futureItem",
        id: "future-1",
      }),
    ).toBeNull();
  });
});

describe("codex service port", () => {
  function portAdapter(port: MessageChannel["port1"]): ConversationServicePort {
    return {
      start: () => port.start(),
      postMessage: (message) => port.postMessage(message),
      close: () => port.close(),
      on: (event, listener) => {
        if (event === "message") return port.on("message", (data: unknown) => listener({ data }));
        return port.on("close", listener);
      },
    };
  }

  it("carries bidirectional service calls with native values over a transferred port", async () => {
    class Host extends RpcTarget {
      async echo(
        value: { date: Date; bytes: Uint8Array },
        callback: (size: number) => Promise<number>,
      ) {
        return { ...value, callbackResult: await callback(value.bytes.length) };
      }
    }
    const { port1, port2 } = new MessageChannel();
    const hostTransport = new ConversationServicePortTransport(portAdapter(port1));
    const viewTransport = new ConversationServicePortTransport(portAdapter(port2));
    const host = new RpcSession(hostTransport, new Host());
    const view = new RpcSession<Host>(viewTransport);
    try {
      const date = new Date("2026-01-01T00:00:00Z");
      const result = await view
        .getRemoteMain()
        .echo({ date, bytes: new Uint8Array([1, 2, 3]) }, async (size) => size + 1);
      expect(result).toEqual({ date, bytes: new Uint8Array([1, 2, 3]), callbackResult: 4 });
    } finally {
      hostTransport.abort(new Error("done"));
      viewTransport.abort(new Error("done"));
      await Promise.all([host.drain(), view.drain()]);
    }
  });

  it("rejects outstanding service calls when the peer closes its port", async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new ConversationServicePortTransport(portAdapter(port1));
    const result = expect(transport.receive()).rejects.toThrow("MessagePort message error");
    port2.close();
    await result;
  });

  it("settles a pending local receive immediately when its scope is aborted", async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new ConversationServicePortTransport(portAdapter(port1));
    const error = new Error("window scope closed");
    const pending = expect(transport.receive()).rejects.toBe(error);
    transport.abort(error);
    transport.abort(new Error("later close"));
    try {
      await pending;
      await expect(transport.receive()).rejects.toBe(error);
      expect(() => transport.send("late message")).toThrow(error);
    } finally {
      port2.close();
    }
  });

  it("closes its local endpoint on disposal after receiving the peer close sentinel", async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new ConversationServicePortTransport(portAdapter(port1));
    const failed = expect(transport.receive()).rejects.toThrow(
      "Peer closed MessagePort connection",
    );
    port2.postMessage(null);
    await failed;
    const closed = once(port1, "close");
    transport.abort(new Error("dispose failed session"));
    try {
      await closed;
      await expect(transport.receive()).rejects.toThrow("Peer closed MessagePort connection");
    } finally {
      port2.close();
    }
  });

  it.each([false, true])(
    "passes undefined through before the null close sentinel (buffered: %s)",
    async (buffered) => {
      const { port1, port2 } = new MessageChannel();
      const transport = new ConversationServicePortTransport(portAdapter(port1));
      try {
        const delivered = once(port1, "message");
        const pending = buffered ? null : transport.receive();
        port2.postMessage(undefined);
        await delivered;
        expect(await (pending ?? transport.receive())).toBeUndefined();
        const closed = expect(transport.receive()).rejects.toThrow(
          "Peer closed MessagePort connection",
        );
        port2.postMessage(null);
        await closed;
      } finally {
        port1.close();
        port2.close();
      }
    },
  );
});

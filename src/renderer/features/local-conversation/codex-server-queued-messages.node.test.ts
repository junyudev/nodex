import { expect, test, vi } from "vite-plus/test";
import { prepareUntrustedAppInput } from "../../../shared/codex-untrusted-app-input";
import {
  CodexServerQueuedMessages,
  type CodexServerQueuedMessagesOptions,
} from "./codex-server-queued-messages";

test("reconstructs hosted images and preserves their native details when a queued message is removed", async () => {
  const input = [{ type: "image" as const, fileId: "file-123", detail: "original" as const }];
  const request = vi.fn(async (method: string) => {
    if (method === "thread/queue/list")
      return {
        data: [
          {
            id: "queued-1",
            clientUserMessageId: "client-1",
            input: input.map((image) => ({ ...image, url: 123 })),
          },
        ],
        nextCursor: null,
      };
    if (method === "thread/queue/delete") return { deleted: true };
    throw new Error(`Unexpected request: ${method}`);
  });
  const queue = new CodexServerQueuedMessages({
    request: request as CodexServerQueuedMessagesOptions["request"],
    compileInput: () => ({ input: [], responseItems: [] }),
    getConversationCwd: () => "/workspace",
    isConversationInterrupted: () => false,
    isConversationStreaming: () => false,
    onQueueChanged: () => {},
  });
  try {
    await queue.load("thread-1");
    expect(queue.read("thread-1")?.[0]?.context.imageAttachments).toEqual([
      { source: "file-service://file-123" },
    ]);
    const removed = await queue.remove("thread-1", "queued-1");
    expect(removed?.serverSubmission.input).toEqual(input);
    expect(queue.read("thread-1")).toEqual([]);
  } finally {
    queue[Symbol.dispose]();
  }
});

test.each(["pair", "placeholder"] as const)(
  "refuses %s app input before server queue mutation",
  async (form) => {
    const compiled = prepareUntrustedAppInput(
      "Use the selected variant",
      {
        mcpAppModelContextAttachments: [
          {
            id: "/widget.html",
            kind: "context",
            sourceName: "Changes",
            text: null,
            structuredContent: { selectedVariants: [{ carousel: 0, variant: "Dots" }] },
            imageAttachments: [],
            untrusted: true,
          },
        ],
      },
      "annotation-call",
    );
    const request = vi.fn(async (method: string) => {
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected native queue mutation ${method}`);
    });
    const queue = new CodexServerQueuedMessages({
      request: request as CodexServerQueuedMessagesOptions["request"],
      compileInput: () => ({
        input: form === "pair" ? [] : [compiled.input],
        responseItems: form === "pair" ? compiled.responseItems : [],
      }),
      getConversationCwd: () => "/workspace",
      isConversationInterrupted: () => false,
      isConversationStreaming: () => false,
      onQueueChanged: () => {},
    });
    try {
      await expect(
        queue.enqueue("thread-1", {
          id: "message",
          cwd: "/workspace",
          context: {
            prompt: "Use the selected variant",
            fileAttachments: [],
            addedFiles: [],
            commentAttachments: [],
            imageAttachments: [],
          },
        }),
      ).rejects.toThrow("requires confirmation");
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/queue/list"]);
      expect(queue.read("thread-1")).toEqual([]);
    } finally {
      queue[Symbol.dispose]();
    }
  },
);

const plainMessage = {
  id: "client",
  cwd: "/workspace",
  context: {
    prompt: "Captured original",
    fileAttachments: [],
    addedFiles: [],
    commentAttachments: [],
    imageAttachments: [],
  },
};
function testQueue(
  request: CodexServerQueuedMessagesOptions["request"],
  compileInput: CodexServerQueuedMessagesOptions["compileInput"] = () => ({
    input: [{ type: "text", text: "Captured original", text_elements: [] }],
    responseItems: [],
  }),
  options: Partial<CodexServerQueuedMessagesOptions> = {},
) {
  return new CodexServerQueuedMessages({
    request,
    compileInput,
    getConversationCwd: () => "/workspace",
    isConversationInterrupted: () => false,
    isConversationStreaming: () => false,
    onQueueChanged: () => {},
    ...options,
  });
}
test("retiring native generation during compilation never dispatches to its replacement host", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const compile = vi.fn(async () => {
    await gate;
    return { input: [], responseItems: [] };
  });
  const request = vi.fn(async (method: string) => {
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    throw new Error("retired mutation");
  });
  const queue = testQueue(request as CodexServerQueuedMessagesOptions["request"], compile);
  try {
    const enqueue = queue.enqueue("thread", plainMessage);
    await vi.waitFor(() => expect(compile).toHaveBeenCalledOnce());
    queue.retire();
    release();
    await expect(enqueue).rejects.toThrow("owner lifetime ended");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/queue/list"]);
    expect(queue.read("thread")).toBeUndefined();
  } finally {
    release();
    queue[Symbol.dispose]();
  }
});
test.each(["list", "compile"] as const)(
  "a native mutation cannot revive across owner replacement while %s is awaited",
  async (stage) => {
    let role = { role: "owner" };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method !== "thread/queue/list") throw new Error("Retired owner dispatched a mutation");
      if (stage === "list") {
        entered();
        await held;
      }
      return { data: [], nextCursor: null };
    });
    const queue = testQueue(
      request as CodexServerQueuedMessagesOptions["request"],
      async () => {
        if (stage === "compile") {
          entered();
          await held;
        }
        return { input: [], responseItems: [] };
      },
      {
        captureMutationLifetime: () => {
          const admitted = role;
          return {
            assertCurrent: () => {
              if (admitted !== role) throw new Error("Owner incarnation changed");
            },
            [Symbol.dispose]: () => {},
          };
        },
      },
    );
    try {
      const operation = queue.enqueue("thread", plainMessage);
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      role = { role: "follower" };
      role = { role: "owner" };
      release();
      await expect(operation).rejects.toThrow("Owner incarnation changed");
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/queue/list"]);
    } finally {
      release();
      queue[Symbol.dispose]();
    }
  },
);
test("a stale refresh retries after native acceptance instead of hiding the newly captured row", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const item = {
    id: "native",
    clientUserMessageId: "client",
    input: [{ type: "text" as const, text: "Compiled generated text", text_elements: [] }],
  };
  const request = vi.fn(async (method: string) => {
    if (method === "thread/queue/add") return { queuedSubmission: item };
    if (method !== "thread/queue/list") throw new Error(method);
    reads++;
    if (reads === 2) {
      await gate;
      return { data: [], nextCursor: null };
    }
    return { data: reads === 1 ? [] : [item], nextCursor: null };
  });
  const queue = testQueue(request as CodexServerQueuedMessagesOptions["request"]);
  try {
    await queue.load("thread");
    const refresh = queue.refresh("thread");
    await vi.waitFor(() => expect(reads).toBe(2));
    await queue.enqueue("thread", plainMessage);
    release();
    await refresh;
    expect(reads).toBe(3);
    expect(queue.read("thread")?.map((message) => message.context.prompt)).toEqual([
      "Captured original",
    ]);
    expect(queue.findByClientMessageId("thread", "client")).toBe("native");
  } finally {
    release();
    queue[Symbol.dispose]();
  }
});

test("an authoritative native receipt settles an unknown add without resending the same client identity", async () => {
  const item = {
    id: "native",
    clientUserMessageId: "client",
    input: [{ type: "text" as const, text: "Captured original", text_elements: [] }],
  };
  let accepted = false;
  const request = vi.fn(async (method: string) => {
    if (method === "thread/queue/list") return { data: accepted ? [item] : [], nextCursor: null };
    if (method === "thread/queue/add") {
      accepted = true;
      throw new Error("Native outcome unknown");
    }
    throw new Error(method);
  });
  const queue = testQueue(request as CodexServerQueuedMessagesOptions["request"]);
  try {
    await expect(queue.enqueue("thread", plainMessage)).rejects.toThrow("Native outcome unknown");
    await queue.refresh("thread");
    expect(await queue.enqueue("thread", plainMessage)).toEqual({
      status: "queued",
      messageId: "native",
    });
    expect(request.mock.calls.filter(([method]) => method === "thread/queue/add")).toHaveLength(1);
    expect(queue.read("thread")?.map((message) => message.id)).toEqual(["native"]);
  } finally {
    queue[Symbol.dispose]();
  }
});

test("native send acceptance preserves a same-id edit made while steering is waiting", async () => {
  let item = {
    id: "native",
    clientUserMessageId: "client",
    input: [{ type: "text" as const, text: "Original", text_elements: [] }],
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === "thread/queue/list") return { data: [item], nextCursor: null };
    if (method === "thread/queue/update") {
      item = { ...item, input: (params as { input: typeof item.input }).input };
      return { queuedSubmission: item };
    }
    if (method === "thread/queue/reorder") return {};
    if (method === "thread/queue/delete") return { deleted: true };
    throw new Error(method);
  });
  const queue = testQueue(
    request as CodexServerQueuedMessagesOptions["request"],
    (message) => ({
      input: [{ type: "text", text: message.context.prompt, text_elements: [] }],
      responseItems: [],
    }),
    { isConversationStreaming: () => true },
  );
  const steer = vi.fn(async () => {
    await held;
    return { status: "sent" as const, messageId: "native", turnId: "turn" };
  });
  try {
    await queue.load("thread");
    const send = queue.sendNow("thread", "native", steer);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());
    await queue.enqueue(
      "thread",
      { ...plainMessage, context: { ...plainMessage.context, prompt: "Edited" } },
      { messageId: "native" },
    );
    release();
    expect(await send).toMatchObject({ status: "sent" });
    expect(request.mock.calls.filter(([method]) => method === "thread/queue/delete")).toEqual([]);
    expect(queue.read("thread")?.map((message) => message.context.prompt)).toEqual(["Edited"]);
  } finally {
    release();
    queue[Symbol.dispose]();
  }
});

test("accepted native steering retries only queue cleanup after delete fails", async () => {
  let items: import("@nodex/codex-app-server-protocol/v2").QueuedSubmission[] = [
    {
      id: "native",
      clientUserMessageId: "client",
      input: [{ type: "text", text: "Original", text_elements: [] }],
    },
  ];
  let receipts: typeof items = [];
  let fail = true;
  const request = vi.fn(async (method: string) => {
    if (method === "thread/queue/list") return { data: items, nextCursor: null };
    if (method === "thread/queue/delete") {
      if (fail) throw new Error("Cleanup transport failure");
      items = [];
      return { deleted: true };
    }
    throw new Error(method);
  });
  const queue = testQueue(request as CodexServerQueuedMessagesOptions["request"], undefined, {
    isConversationStreaming: () => true,
    readAccepted: () => receipts,
    recordAccepted: (_thread, item) => {
      receipts.push(structuredClone(item));
    },
    discardAccepted: (_thread, item) => {
      receipts = receipts.filter((receipt) => receipt.id !== item.id);
    },
  });
  const steer = vi.fn(async () => ({
    status: "sent" as const,
    messageId: "native",
    turnId: "turn",
  }));
  const accepted = vi.fn();
  try {
    await expect(queue.sendNow("thread", "native", steer, accepted)).rejects.toThrow(
      "Cleanup transport failure",
    );
    expect(accepted).toHaveBeenCalledOnce();
    expect(receipts).toEqual(items);
    fail = false;
    await queue.reconcileAccepted("thread");
    expect(receipts).toEqual([]);
    expect(queue.read("thread")).toEqual([]);
    expect(await queue.sendNow("thread", "native", steer)).toBeNull();
    expect(steer).toHaveBeenCalledOnce();
  } finally {
    queue[Symbol.dispose]();
  }
});

test("returned native acceptance settles admission before a retired owner can publish or clean up", async () => {
  const raw = {
    id: "native",
    clientUserMessageId: "client",
    input: [{ type: "text" as const, text: "Original", text_elements: [] }],
  };
  let owner = {};
  const record = vi.fn();
  const accepted = vi.fn();
  const request = vi.fn(async (method: string) => {
    if (method === "thread/queue/list") return { data: [raw], nextCursor: null };
    throw new Error("Retired owner attempted queue cleanup");
  });
  const queue = testQueue(request as CodexServerQueuedMessagesOptions["request"], undefined, {
    isConversationStreaming: () => true,
    recordAccepted: record,
    captureMutationLifetime: () => {
      const admitted = owner;
      return {
        assertCurrent: () => {
          if (owner !== admitted) throw new Error("Owner incarnation changed");
        },
        [Symbol.dispose]: () => {},
      };
    },
  });
  try {
    await expect(
      queue.sendNow(
        "thread",
        "native",
        async () => {
          owner = {};
          return { status: "sent", messageId: "native", turnId: "turn" };
        },
        accepted,
      ),
    ).rejects.toThrow("Owner incarnation changed");
    expect(accepted).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/queue/list"]);
  } finally {
    queue[Symbol.dispose]();
  }
});

test("a steered native row already cleaned by its owner confirms absence instead of resending", async () => {
  const raw = {
    id: "native",
    clientUserMessageId: "client",
    input: [{ type: "text" as const, text: "Original", text_elements: [] }],
  };
  let items = [raw];
  const request = vi.fn(async (method: string) => {
    if (method === "thread/queue/list") return { data: structuredClone(items), nextCursor: null };
    if (method === "thread/queue/delete") return { deleted: false };
    throw new Error(method);
  });
  const queue = testQueue(request as CodexServerQueuedMessagesOptions["request"], undefined, {
    isConversationStreaming: () => true,
  });
  const accepted = vi.fn();
  const steer = vi.fn(async () => {
    items = [];
    return { status: "sent" as const, messageId: "native", turnId: "turn" };
  });
  try {
    expect(await queue.sendNow("thread", "native", steer, accepted)).toEqual({
      status: "sent",
      messageId: "native",
      turnId: "turn",
    });
    expect(accepted).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenCalledOnce();
    expect(queue.read("thread")).toEqual([]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/queue/list",
      "thread/queue/delete",
      "thread/queue/list",
    ]);
  } finally {
    queue[Symbol.dispose]();
  }
});

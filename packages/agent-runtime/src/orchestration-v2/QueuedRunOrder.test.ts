import { describe, expect, it } from "vite-plus/test";

import { isRuntimeDeliveryRun, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("delivers person messages before delegated completions and Host wakes", () => {
    const projection = {
      messages: [
        { id: "message:visible-first", createdBy: "user" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second", createdBy: "user" },
        { id: "message:notice", notification: { summary: "Background work" } },
        { id: "message:host-input", createdBy: "system", creationSource: "server" },
      ],
      runs: [
        {
          id: "run:host-input",
          ordinal: 6,
          queuePosition: 5,
          status: "queued",
          userMessageId: "message:host-input",
        },
        {
          id: "run:notice",
          ordinal: 5,
          queuePosition: 4,
          status: "queued",
          userMessageId: "message:notice",
        },
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:visible-first",
      "run:visible-second",
      "run:automatic",
      "run:notice",
      "run:host-input",
    ]);
    const ordered = queuedRunsInDeliveryOrder(projection);
    expect(ordered.map((run) => isRuntimeDeliveryRun(projection, run))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });
});

it("puts a later person message ahead of an ordinary Agent-authored follow-up", () => {
  const projection = {
    messages: [
      { id: "agent", createdBy: "agent", creationSource: "mcp" },
      { id: "person", createdBy: "user", creationSource: "web" },
    ],
    runs: [
      { id: "automatic", ordinal: 1, queuePosition: 1, status: "queued", userMessageId: "agent" },
      { id: "person", ordinal: 2, queuePosition: 2, status: "queued", userMessageId: "person" },
    ],
  } as never;
  expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
    "person",
    "automatic",
  ]);
});

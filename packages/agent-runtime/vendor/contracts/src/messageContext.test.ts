import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MessageContextRecord, OrchestrationMessageContext } from "./messageContext.ts";
import {
  OrchestrationV2Command,
  OrchestrationV2ConversationMessageJson,
} from "./orchestrationV2.ts";

const decodeRecord = Schema.decodeUnknownOption(MessageContextRecord);
const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const encodeContext = Schema.encodeUnknownSync(Schema.toCodecJson(OrchestrationMessageContext));

const record = {
  kind: "nodex-page-reference",
  label: "Roadmap",
  payload: { pageId: "page-1" },
} as const;

describe("MessageContextRecord", () => {
  it("round-trips a record with its payload", () => {
    expect(Option.getOrThrow(decodeRecord(record))).toEqual(record);
  });

  it("reads a stored record by its kind, label and payload alone", () => {
    expect(
      Option.getOrThrow(decodeRecord({ ...record, version: 1, contextId: "stored_1" })),
    ).toEqual(record);
  });

  it("bounds kinds, labels and payloads", () => {
    expect(Option.isNone(decodeRecord({ ...record, kind: "Not A Kind" }))).toBe(true);
    expect(Option.isNone(decodeRecord({ ...record, label: "x".repeat(201) }))).toBe(true);
    expect(Option.isSome(decodeRecord({ ...record, label: "x".repeat(200) }))).toBe(true);
    expect(Option.isNone(decodeRecord({ ...record, payload: "x".repeat(64_001) }))).toBe(true);
  });
});

describe("OrchestrationMessageContext", () => {
  it("rejects aggregate context size even when each record is valid", () => {
    const large = { ...record, payload: "x".repeat(63_000) };
    expect(Option.isSome(decodeRecord(large))).toBe(true);
    expect(() => decodeContext({ version: 1, records: [large] })).not.toThrow();
    expect(() =>
      decodeContext({
        version: 1,
        records: Array.from({ length: 201 }, () => record),
      }),
    ).toThrow();
  });

  it("sends a message without the records the wire cannot carry", () => {
    const wire = encodeContext({
      version: 1,
      records: [
        record,
        { ...record, payload: { count: Number.NaN } },
        // JSON.stringify throws on a bigint on every engine.
        { ...record, payload: { n: 1n } },
      ],
    });
    expect(decodeContext(wire).records).toEqual([record]);
  });

  it("reports a hole as a schema issue, even when collecting every issue", () => {
    const result = Schema.decodeUnknownExit(Schema.toType(OrchestrationMessageContext))(
      { version: 1, records: [undefined] },
      { errors: "all" },
    );
    expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(true);
  });

  it("drops undecodable records and keeps valid siblings", () => {
    const context = decodeContext({
      version: 1,
      records: [record, { kind: "nodex-app-context" }, { ...record, label: "Second" }],
    });
    expect(context.records.map((entry) => entry.label)).toEqual(["Roadmap", "Second"]);
  });

  it("is optional on messages and message dispatch commands", () => {
    const message = {
      createdBy: "user",
      creationSource: "web",
      id: "m1",
      threadId: "t1",
      runId: null,
      nodeId: null,
      role: "user",
      text: "hi",
      attachments: [],
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(decodeMessage(message).context).toBeUndefined();
    const withContext = decodeMessage({
      ...message,
      context: { version: 1, records: [record] },
    });
    expect(withContext.context?.records).toHaveLength(1);

    const command = decodeCommand({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: "c1",
      threadId: "t1",
      messageId: "m1",
      text: "hi",
      attachments: [],
      context: { version: 1, records: [record] },
      dispatchMode: { type: "start_immediately" },
    });
    expect(command.type === "message.dispatch" && command.context?.records[0]?.kind).toBe(
      "nodex-page-reference",
    );
  });
});

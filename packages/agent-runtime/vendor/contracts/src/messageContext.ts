import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Structured data the host attaches beside a user's words. A message's `text` holds only what
 * the user wrote; each record names one attachment and carries its payload, which provider
 * projection renders as data.
 */

const MESSAGE_CONTEXT_MAX_RECORDS = 200;
const MESSAGE_CONTEXT_LABEL_MAX_CHARS = 200;
const MESSAGE_CONTEXT_PAYLOAD_MAX_CHARS = 64_000;
const MESSAGE_CONTEXT_MAX_SERIALIZED_CHARS = 16_000_000;

const isJson = Schema.is(Schema.Json);

export const MessageContextRecord = Schema.Struct({
  kind: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/)),
  label: Schema.String.check(Schema.isMaxLength(MESSAGE_CONTEXT_LABEL_MAX_CHARS)),
  payload: Schema.Unknown.check(
    Schema.makeFilter((payload) => {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(payload);
      } catch {
        // Cycles, bigints, and payloads nested deeper than this engine's stack.
        return false;
      }
      // Only JSON values, so a payload the wire cannot carry (a Date, NaN, an
      // undefined field) fails this record alone instead of the whole message.
      return (
        encoded !== undefined &&
        encoded.length <= MESSAGE_CONTEXT_PAYLOAD_MAX_CHARS &&
        isJson(payload)
      );
    }),
  ),
});
export type MessageContextRecord = typeof MessageContextRecord.Type;

/** Structured context riding on a user message. Undecodable records are dropped, not fatal. */
export const OrchestrationMessageContext = Schema.Struct({
  version: Schema.Literal(1),
  records: Schema.Array(Schema.Unknown)
    .check(
      Schema.isMaxLength(MESSAGE_CONTEXT_MAX_RECORDS),
      Schema.makeFilter((records) => {
        try {
          return JSON.stringify(records).length <= MESSAGE_CONTEXT_MAX_SERIALIZED_CHARS;
        } catch {
          return false;
        }
      }),
    )
    .pipe(Schema.decodeTo(ForwardCompatibleArray(MessageContextRecord))),
});
export type OrchestrationMessageContext = typeof OrchestrationMessageContext.Type;

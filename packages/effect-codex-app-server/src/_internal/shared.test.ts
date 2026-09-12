import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CodexError from "../errors.ts";
import * as Shared from "./shared.ts";

const decodeNestedNumberPayload = Schema.decodeUnknownEffect(
  Schema.Struct({ profile: Schema.Struct({ token: Schema.Finite }) }),
);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("preserves schema decode diagnostics without deriving the message from the cause", () =>
  Effect.gen(function* () {
    const error = yield* Shared.decodeOptionalPayload("thread/start", Schema.String, 42).pipe(
      Effect.flip,
    );

    assert.instanceOf(error, CodexError.CodexAppServerRequestError);
    assert.equal(error.code, -32602);
    assert.equal(error.method, "thread/start");
    assert.equal(error.operation, "decode-payload");
    assert.equal(
      error.message,
      "Invalid payload for method 'thread/start' during 'decode-payload'",
    );
    assert.isTrue(Schema.isSchemaError(error.cause));

    const protocolError = error.toProtocolError();
    assert.equal(protocolError.code, -32602);
    assert.equal(protocolError.message, error.message);
    assert.property(protocolError, "data");
    assert.notProperty(protocolError, "method");
    assert.notProperty(protocolError, "operation");
    assert.notProperty(protocolError, "cause");
  }),
);

it.effect("preserves schema encode diagnostics", () =>
  Effect.gen(function* () {
    const error = yield* Shared.encodeOptionalPayload(
      "thread/start",
      Schema.Finite,
      "not-a-number" as never,
    ).pipe(Effect.flip);

    assert.equal(error.method, "thread/start");
    assert.equal(error.operation, "encode-payload");
    assert.equal(
      error.message,
      "Invalid payload for method 'thread/start' during 'encode-payload'",
    );
    assert.isTrue(Schema.isSchemaError(error.cause));
  }),
);

it.effect("encodes optional undefined object properties as absent JSON fields", () =>
  Effect.gen(function* () {
    const schema = Schema.Struct({
      id: Schema.String,
      optional: Schema.optionalKey(Schema.String),
      nested: Schema.Struct({ optional: Schema.optionalKey(Schema.String) }),
    });
    const payload = {
      id: "thread",
      optional: undefined,
      nested: { optional: undefined },
    } as unknown as Schema.Schema.Type<typeof schema>;

    assert.deepStrictEqual(yield* Shared.encodeOptionalPayload("thread/start", schema, payload), {
      id: "thread",
      nested: {},
    });
  }),
);

it.effect("does not coerce undefined array entries while preparing JSON object fields", () =>
  Effect.gen(function* () {
    const schema = Schema.Struct({ values: Schema.Array(Schema.String) });
    const error = yield* Shared.encodeOptionalPayload("turn/start", schema, {
      values: [undefined],
    } as unknown as Schema.Schema.Type<typeof schema>).pipe(Effect.flip);

    assert.equal(error.operation, "encode-payload");
    assert.isTrue(Schema.isSchemaError(error.cause));
  }),
);

it.effect("does not invent a cause when a method has no payload schema", () =>
  Effect.gen(function* () {
    const secret = "unexpected-payload-secret";
    const error = yield* Shared.decodeOptionalPayload<never, never>("initialized", undefined, {
      token: secret,
    }).pipe(Effect.flip);

    assert.equal(error.method, "initialized");
    assert.equal(error.operation, "decode-payload");
    assert.equal(error.payloadKind, "object");
    assert.deepEqual(error.data, { payloadKind: "object" });
    assert.isUndefined(error.cause);
    assert.notInclude(error.message, secret);
    assert.notInclude(encodeUnknownJson(error.toProtocolError()), secret);
  }),
);

it.effect("keeps invalid payload values only in the exact schema cause", () =>
  Effect.gen(function* () {
    const secret = "codex-schema-payload-secret";
    const cause = yield* decodeNestedNumberPayload({ profile: { token: secret } }).pipe(
      Effect.flip,
    );
    const error = CodexError.CodexAppServerRequestError.invalidPayload(
      "thread/start",
      "decode-payload",
      cause,
    );
    const { cause: directCause, ...directDiagnostics } = error;

    assert.strictEqual(directCause, cause);
    assert.equal(error.method, "thread/start");
    assert.equal(error.operation, "decode-payload");
    assert.equal(error.maximumPathDepth, 2);
    assert.isAbove(error.issueCount ?? 0, 0);
    assert.include(error.issueKinds ?? [], "Pointer");
    assert.notInclude(error.message, secret);
    assert.notInclude(encodeUnknownJson(directDiagnostics), secret);
    assert.notInclude(encodeUnknownJson(error.toProtocolError()), secret);
  }),
);

it.effect("retains the request-handler error as the internal error cause", () =>
  Effect.gen(function* () {
    const rootCause = new Error("socket closed");
    const source = new CodexError.CodexAppServerTransportError({
      operation: "read-input-stream",
      cause: rootCause,
    });
    const error = yield* Shared.runHandler(
      (_payload: void) => Effect.fail(source),
      undefined,
      "thread/start",
    ).pipe(Effect.flip);

    assert.equal(error.code, -32603);
    assert.equal(error.method, "thread/start");
    assert.equal(error.operation, "handle-request");
    assert.equal(
      error.message,
      "Codex App Server request handler failed for method 'thread/start'",
    );
    assert.strictEqual(error.cause, source);
    assert.strictEqual(source.cause, rootCause);
    assert.notInclude(error.message, source.message);
  }),
);

it.effect("passes request errors through without adding a wrapper", () =>
  Effect.gen(function* () {
    const source = CodexError.CodexAppServerRequestError.invalidParams("Invalid thread id");
    const error = yield* Shared.runHandler(
      (_payload: void) => Effect.fail(source),
      undefined,
      "thread/start",
    ).pipe(Effect.flip);

    assert.strictEqual(error, source);
  }),
);

it.effect("retains the full notification payload decode cause chain", () =>
  Effect.gen(function* () {
    const error = yield* Shared.decodeNotificationPayload(
      "item/agentMessage/delta",
      Schema.String,
      42,
    ).pipe(Effect.flip);

    assert.equal(error.method, "item/agentMessage/delta");
    assert.equal(error.operation, "decode-notification-payload");
    assert.instanceOf(error.cause, CodexError.CodexAppServerRequestError);
    assert.isTrue(Schema.isSchemaError(error.cause.cause));
  }),
);

it.effect("validates known protocol fields without stripping extension fields", () =>
  Effect.gen(function* () {
    const schema = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) });
    const payload = {
      thread: { id: "thread", serverExtension: { value: 3 } },
      topLevelExtension: true,
    };
    assert.deepStrictEqual(
      yield* Shared.decodeOptionalPayload("thread/read", schema, payload),
      payload,
    );
    assert.deepStrictEqual(
      yield* Shared.encodeOptionalPayload("thread/read", schema, payload),
      payload,
    );
    const failure = yield* Shared.decodeOptionalPayload("thread/read", schema, {
      ...payload,
      thread: { id: 3 },
    }).pipe(Effect.flip);
    assert.instanceOf(failure, CodexError.CodexAppServerRequestError);
  }),
);

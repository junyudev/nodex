import { WorkApplication } from "../work-application/WorkApplication";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { createUuidV7, createUuidV7FromTimestamp } from "../../shared/uuid-v7";
import { CoreAuthority } from "../../main/core-runtime/CoreAuthority";
import { InboxApplication } from "../inbox-application/InboxApplication";
import { inboxOverRealCore } from "../inbox-application/InboxApplication.test-support";
import { live as profileFiles } from "../../main/platform/node/PhoneFiles";
import { makeMobileInbox } from "./inbox";

it.effect("captures through the mobile Inbox and reads the same Page through Core", () =>
  Effect.gen(function* () {
    const { inbox, client, projectId } = yield* inboxOverRealCore();
    const authority = {
      identity: {
        profileId: client.handshake.generation.profile_id,
        libraryId: client.handshake.library_id,
        storeEpoch: client.handshake.store_epoch,
      },
    } as CoreAuthority["Service"];
    const handlers = yield* makeMobileInbox({
      captureImages: () => Effect.succeed([]),
    }).pipe(
      Effect.provide(profileFiles),
      Effect.provideService(WorkApplication, {
        startWork: () => Effect.die("Capture does not start work"),
        acceptWork: () => Effect.die("Capture does not accept work"),
      }),
      Effect.provideService(InboxApplication, inbox),
      Effect.provideService(CoreAuthority, authority),
    );
    const issuedAt = Date.now();
    const scope = { kind: "project", projectId } as const;
    const input = {
      scope,
      operationId: createUuidV7FromTimestamp(issuedAt),
      pageId: createUuidV7(),
      documentId: createUuidV7(),
      issuedAt,
      text: "Read the capture on the phone.",
      fileRefs: [],
    };
    expect(yield* handlers["inbox.capture"](input)).toEqual({ pageId: input.pageId });
    expect(yield* handlers["inbox.capture"](input)).toEqual({ pageId: input.pageId });
    const window = yield* handlers["inbox.window"]({ scope, filter: "inbox" });
    expect(window.items.filter((item) => item.pageId === input.pageId)).toEqual([
      expect.objectContaining({ body: input.text, source: { kind: "user", label: null }, scope }),
    ]);
    expect(yield* handlers["inbox.message"]({ entryId: input.pageId })).toMatchObject({
      pageId: input.pageId,
      body: input.text,
      bodyTruncated: false,
    });
  }),
);

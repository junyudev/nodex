import { nativeHistoryItems } from "@nodex/agent-runtime/native-history-items";
import type { ThreadTurnsListResponse } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import type { CodexGateway, CodexGatewayRequestOptions } from "../codex-runtime/CodexGateway";
import { projectCodexGatewayThreadItemsList } from "../codex-runtime/CodexGatewayProtocolProjection";

/** The canonical paginated item read, shared by Session history reads and background search ingestion. */
export const readCodexHistoryItems = (
  gateway: CodexGateway["Service"],
  target: {
    readonly hostId: string;
    readonly threadId: string;
    readonly generation: number;
    readonly assertCurrent: () => void;
  },
  input: {
    readonly cursor: string | null;
    readonly direction: "asc" | "desc";
    readonly limit: number;
    readonly turnId?: string;
    readonly historyMode?: "legacy" | "paginated";
  },
  scheduling: Pick<CodexGatewayRequestOptions, "priority" | "source"> = {},
) =>
  Effect.gen(function* () {
    if (input.historyMode === "legacy") {
      const response = yield* gateway.requestOnHost(
        target.hostId,
        "thread/turns/list",
        {
          threadId: target.threadId,
          cursor: input.cursor,
          sortDirection: input.direction,
          limit: 1,
          itemsView: "full",
        },
        {
          ...scheduling,
          expectedHostId: target.hostId,
          expectedGeneration: target.generation,
          timeoutMs: 10_000,
        },
      );
      yield* Effect.try(target.assertCurrent);
      const page = response as unknown as ThreadTurnsListResponse;
      return {
        data: nativeHistoryItems(page, "legacy"),
        settledTurnIds: page.data
          .filter((turn) => turn.status !== "inProgress")
          .map((turn) => turn.id),
        nextCursor: page.nextCursor,
        backwardsCursor: page.backwardsCursor,
      };
    }
    return yield* gateway
      .requestOnHost(
        target.hostId,
        "thread/items/list",
        {
          threadId: target.threadId,
          cursor: input.cursor,
          sortDirection: input.direction,
          limit: input.limit,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        },
        {
          ...scheduling,
          expectedHostId: target.hostId,
          expectedGeneration: target.generation,
          timeoutMs: 10_000,
        },
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.try(() => {
            target.assertCurrent();
            return {
              ...projectCodexGatewayThreadItemsList(response),
              settledTurnIds: [] as readonly string[],
            };
          }),
        ),
      );
  });

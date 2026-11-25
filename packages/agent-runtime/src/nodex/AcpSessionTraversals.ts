import * as Effect from "effect/Effect";
import { AcpManagementError } from "./AcpFailures.ts";

const MAX_CURSORS = 100;
const MAX_SCOPES = 64;
const invalidRequest = (message: string) =>
  Effect.fail(new AcpManagementError({ reason: "invalid_request", message }));

type Traversal = {
  readonly source: object;
  readonly cursors: Map<string, ReadonlyArray<string>>;
};

/** Tracks opaque cursor ancestry for each instance generation and execution directory. */
export function makeAcpSessionTraversals() {
  const traversals = new Map<string, Traversal>();

  return {
    // The caller serializes each page from begin through commit. A failed page leaves
    // the traversal intact so its cursor can still be used.
    begin: (input: { instanceId: string; cwd: string; cursor?: string }, source: object) => {
      const key = JSON.stringify([input.instanceId, input.cwd]);
      const traversal: Traversal | undefined =
        input.cursor === undefined ? { source, cursors: new Map() } : traversals.get(key);
      const ancestry = input.cursor === undefined ? [] : traversal?.cursors.get(input.cursor);
      if (traversal?.source !== source || ancestry === undefined)
        return invalidRequest(
          "The Agent could not complete this request. Refresh its state and retry.",
        );

      return Effect.succeed({
        prepareCommit: (nextCursor: string | null) => {
          if (nextCursor !== null && ancestry.includes(nextCursor))
            return invalidRequest("The Agent returned a repeated session cursor.");
          if (
            nextCursor !== null &&
            (ancestry.length >= MAX_CURSORS ||
              (!traversal.cursors.has(nextCursor) && traversal.cursors.size >= MAX_CURSORS))
          )
            return invalidRequest("The Agent session listing exceeded its page budget.");

          return Effect.succeed(() => {
            if (nextCursor !== null) traversal.cursors.set(nextCursor, [...ancestry, nextCursor]);
            traversals.delete(key);
            traversals.set(key, traversal);
            if (traversals.size > MAX_SCOPES) traversals.delete(traversals.keys().next().value!);
          });
        },
      });
    },
  };
}

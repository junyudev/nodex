/** Shared question selection for Session and delegated-task access. Permission requests never qualify. */
export const pendingUserQuestionIds = <
  R extends { readonly id: string; readonly kind: string; readonly status: string },
>(
  requests: readonly R[],
) =>
  requests
    .filter((request) => request.kind === "user_input" && request.status === "pending")
    .map((request): R["id"] => request.id);

export function readUserQuestion<
  R extends { readonly id: string; readonly kind: string; readonly status: string },
  I extends { readonly type: string },
>(
  projection: { readonly runtimeRequests: readonly R[]; readonly turnItems: readonly I[] },
  requestId: string,
  requirePending = true,
):
  | { readonly error: "not_found" | "not_pending"; readonly message: string }
  | { readonly request: R; readonly item: Extract<I, { readonly type: "user_input_request" }> } {
  const request = projection.runtimeRequests.find(
    (request) => request.id === requestId && request.kind === "user_input",
  );
  const item = projection.turnItems.find(
    (item): item is Extract<I, { readonly type: "user_input_request" }> =>
      item.type === "user_input_request" && "requestId" in item && item.requestId === requestId,
  );
  if (!request || !item)
    return {
      error: "not_found",
      message: "The pending user-input request was not found.",
    } as const;
  if (requirePending && request.status !== "pending")
    return {
      error: "not_pending",
      message:
        request.status === "resolved"
          ? "The user-input request was already answered."
          : `The user-input request is no longer pending (${request.status}).`,
    } as const;
  return { request, item };
}

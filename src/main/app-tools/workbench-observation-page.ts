import { createHash } from "node:crypto";

export const workbenchObservationHandle = (
  observationId: string,
  kind: "tab" | "group",
  internalId: string,
): string =>
  `${kind}:${createHash("sha256")
    .update(JSON.stringify([observationId, kind, internalId]))
    .digest("hex")
    .slice(0, 32)}`;

export interface WorkbenchPageInput {
  readonly observationId: string;
  readonly kind: "tabs" | "groups";
  readonly panelId?: "right" | "bottom";
  readonly groupId?: string;
  readonly cursor?: string;
  readonly limit: number;
}

/** Pagination belongs to immutable observation evidence, including its filter coordinates. */
export const readWorkbenchObservationPage = <Item>(
  items: readonly Item[],
  input: WorkbenchPageInput,
): {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly total: number;
} | null => {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        input.observationId,
        input.kind,
        input.panelId ?? null,
        input.groupId ?? null,
      ]),
    )
    .digest("hex");
  const prefix = `wb1:${key}:`;
  const encoded = input.cursor?.startsWith(prefix) ? input.cursor.slice(prefix.length) : null;
  if (input.cursor && (!encoded || !/^(0|[1-9]\d*)$/.test(encoded))) return null;
  const offset = encoded === null ? 0 : Number(encoded);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) return null;
  const selected = items.slice(offset, offset + input.limit);
  const next = offset + selected.length;
  return {
    items: selected,
    nextCursor: next < items.length ? `${prefix}${next}` : null,
    complete: next >= items.length,
    total: items.length,
  };
};

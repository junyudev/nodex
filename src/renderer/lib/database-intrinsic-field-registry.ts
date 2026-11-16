import { getIntl } from "@/lib/i18n";
import type { DatabaseViewField, DatabaseViewLayout } from "../../shared/database-kernel";

export type DatabaseIntrinsicField = Extract<
  DatabaseViewField,
  { readonly kind: "intrinsic" }
>["field"];

export interface DatabaseIntrinsicFieldDescriptor {
  readonly field: DatabaseIntrinsicField;
  readonly label: string;
  readonly layouts: readonly DatabaseViewLayout[];
  readonly slot: "identity" | "metadata";
  readonly advanced?: true;
}

const DATABASE_INTRINSIC_FIELDS = [
  {
    field: "page_key",
    label: "ID",
    layouts: ["board", "list"],
    slot: "identity",
  },
  {
    field: "created_at",
    get label() {
      return getIntl().formatMessage({
        id: "lib.databaseIntrinsicFieldRegistry.created",
        defaultMessage: "Created",
      });
    },
    layouts: ["board", "list"],
    slot: "metadata",
  },
  {
    field: "updated_at",
    get label() {
      return getIntl().formatMessage({
        id: "lib.databaseIntrinsicFieldRegistry.updated",
        defaultMessage: "Updated",
      });
    },
    layouts: ["board", "list"],
    slot: "metadata",
  },
] as const satisfies readonly DatabaseIntrinsicFieldDescriptor[];

export const supportedDatabaseIntrinsicFields = (): readonly DatabaseIntrinsicField[] =>
  DATABASE_INTRINSIC_FIELDS.map(({ field }) => field);

export const databaseIntrinsicFieldsForLayout = (
  layout: DatabaseViewLayout,
): readonly DatabaseIntrinsicFieldDescriptor[] =>
  DATABASE_INTRINSIC_FIELDS.filter(({ layouts }) =>
    layouts.some((candidate) => candidate === layout),
  );

export const orderedDatabaseIdentityFields = (
  layout: DatabaseViewLayout,
  fields: readonly DatabaseViewField[],
): readonly DatabaseIntrinsicField[] => {
  const visible = new Set(
    fields.flatMap((field) => (field.kind === "intrinsic" ? [field.field] : [])),
  );
  return databaseIntrinsicFieldsForLayout(layout).flatMap((descriptor) =>
    descriptor.slot === "identity" && visible.has(descriptor.field) ? [descriptor.field] : [],
  );
};

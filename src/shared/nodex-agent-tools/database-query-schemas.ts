import { z } from "zod";
import type {
  DatabasePropertyValueType,
  DatabaseViewFilterClause,
  DatabaseViewFilterGroup,
  DatabaseViewFilterNode,
  DatabaseViewSort,
} from "../database-kernel";
import { JsonValueSchema, PropertyIdSchema } from "./base-schemas";

export const MAX_DATABASE_QUERY_PROPERTY_IDS = 200;

export const DatabasePropertyValueTypeSchema = z.enum([
  "text",
  "number",
  "checkbox",
  "select",
  "multi_select",
  "date",
  "datetime",
]) satisfies z.ZodType<DatabasePropertyValueType>;

export const DatabaseViewLayoutSchema = z.enum(["board", "list"]);

const DatabaseViewFilterOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
]);

const DatabaseViewFilterClauseSchema = z.strictObject({
  kind: z.literal("clause"),
  propertyId: PropertyIdSchema,
  operator: DatabaseViewFilterOperatorSchema,
  value: JsonValueSchema.optional(),
}) satisfies z.ZodType<DatabaseViewFilterClause>;

const DatabaseViewFilterGroupSchema: z.ZodType<DatabaseViewFilterGroup> = z.lazy(() =>
  z.strictObject({
    kind: z.literal("group"),
    operator: z.enum(["and", "or"]),
    children: z.array(DatabaseViewFilterNodeSchema).max(1_024),
  }),
);

export const DatabaseViewFilterNodeSchema: z.ZodType<DatabaseViewFilterNode> = z.lazy(() =>
  z.union([DatabaseViewFilterClauseSchema, DatabaseViewFilterGroupSchema]),
);

export type NonManualDatabaseViewSort = Omit<DatabaseViewSort, "field"> & {
  readonly field: Exclude<DatabaseViewSort["field"], { readonly kind: "manual" }>;
};

export const NonManualDatabaseViewSortSchema = z.strictObject({
  field: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("title") }),
    z.strictObject({ kind: z.literal("created") }),
    z.strictObject({ kind: z.literal("property"), propertyId: PropertyIdSchema }),
  ]),
  direction: z.enum(["asc", "desc"]),
  nulls: z.enum(["first", "last"]),
}) satisfies z.ZodType<NonManualDatabaseViewSort>;

import { z } from "zod";
import { buildPageDeepLink } from "../nodex-deeplink";
import { NODEX_AGENT_V6_TOOL_CONTRACTS as contracts } from "../nodex-agent-tools/v6-contracts";
import { pageBlockUrl, withPageUrl, withViewUrl } from "./reference-urls";

const url = z.string();

function projectOutput<Source extends z.ZodType, Result extends z.ZodType>(
  source: Source,
  outputSchema: Result,
  project: (value: z.output<Source>) => z.input<Result>,
) {
  return {
    outputSchema,
    serializeOutput: (value: unknown) => {
      const parsed = source.safeParse(value);
      return parsed.success ? outputSchema.safeParse(project(parsed.data)) : parsed;
    },
  };
}

function pageBatch<
  T extends z.ZodObject<{
    data: z.ZodObject<{ pages: z.ZodArray<z.ZodObject<{ pageId: z.ZodString }>> }>;
  }>,
>(schema: T, bounded = false) {
  const data = schema.shape.data;
  const pages = data.shape.pages.element.safeExtend({ url }).array();
  return projectOutput(
    schema,
    schema.safeExtend({
      data: data.safeExtend({
        pages: bounded ? pages.min(1).max(16) : pages,
      }),
    }),
    (output) => ({
      ...output,
      data: { ...output.data, pages: output.data.pages.map(withPageUrl) },
    }),
  );
}

const context = contracts.get_context.outputSchema;
const databases = context.shape.data.shape.databases.unwrap().element;
const fetch = contracts.fetch.outputSchema;
const query = contracts.query_database_view.outputSchema;
const duplicate = contracts.duplicate_page.outputSchema;
const update = contracts.update_page.outputSchema;

const queryResult = projectOutput(
  query,
  query.safeExtend({
    data: query.shape.data.safeExtend({
      rows: query.shape.data.shape.rows.element.safeExtend({ url }).array().max(200),
      view: query.shape.data.shape.view.unwrap().safeExtend({ url }).optional(),
    }),
  }),
  (output) => {
    const { rows, view, ...data } = output.data;
    return {
      ...output,
      data: { ...data, rows: rows.map(withPageUrl), ...(view && { view: withViewUrl(view) }) },
    };
  },
);

const updateResult = projectOutput(
  update,
  update.safeExtend({ data: update.shape.data.safeExtend({ url }) }),
  (output) => ({ ...output, data: withPageUrl(output.data) }),
);

export const appContentResults = {
  get_context: projectOutput(
    context,
    context.safeExtend({
      data: context.shape.data.safeExtend({
        databases: databases
          .safeExtend({ views: databases.shape.views.element.safeExtend({ url }).array() })
          .array()
          .optional(),
      }),
    }),
    (output) => {
      const { databases: catalog, ...data } = output.data;
      return {
        ...output,
        data: {
          ...data,
          ...(catalog && {
            databases: catalog.map((database) => ({
              ...database,
              views: database.views.map(withViewUrl),
            })),
          }),
        },
      };
    },
  ),
  fetch: projectOutput(
    fetch,
    fetch.safeExtend({
      data: fetch.shape.data.safeExtend({
        resource: fetch.shape.data.shape.resource.safeExtend({
          url: url.optional(),
          intake: fetch.shape.data.shape.resource.shape.intake.describe(
            "Inbox capture and routing status for a message Page. Use nodex page show or query_content with inbox_suggestions for the prompt, rationale and reviewed additions.",
          ),
        }),
      }),
    }),
    (output) => {
      const { resource } = output.data;
      const resourceUrl =
        resource.type === "page"
          ? buildPageDeepLink({ pageId: resource.id })
          : resource.location.kind === "page"
            ? pageBlockUrl(resource.location.pageId, resource.id)
            : undefined;
      return {
        ...output,
        data: {
          ...output.data,
          resource: { ...resource, ...(resourceUrl ? { url: resourceUrl } : {}) },
        },
      };
    },
  ),
  query_database_view: queryResult,
  query_data_source: queryResult,
  create_pages: pageBatch(contracts.create_pages.outputSchema, true),
  move_pages: pageBatch(contracts.move_pages.outputSchema, true),
  set_page_properties: pageBatch(contracts.set_page_properties.outputSchema),
  update_page: updateResult,
  advanced_update_page: updateResult,
  duplicate_page: projectOutput(
    duplicate,
    duplicate.safeExtend({ data: duplicate.shape.data.safeExtend({ url }) }),
    (output) => ({ ...output, data: withPageUrl(output.data) }),
  ),
};

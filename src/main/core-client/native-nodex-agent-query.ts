import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../shared/database-identities";
import {
  parseDatabaseModuleReadResultV2,
  parseLibraryDatabaseModuleReadResultV2,
} from "../../shared/database-module-v2-transport";
import type {
  NodexAgentV3ReadCommandResult,
  NodexAgentV3ReadRequest,
} from "../../shared/nodex-agent-tools";
import { QueryDatabaseV6OutputSchema } from "../../shared/nodex-agent-tools/v6-schemas";
import { projectNodexAgentQueryV3Data } from "../agent-tools/query-v3-projection";
import {
  projectCoreDatabaseViewQuery,
  projectCoreDataSourceQuery,
} from "../../shared/database-page-projection";
import { nativeAgentClient, type NativeNodexAgentCore } from "./native-nodex-agent-core";
import { toCoreAgentExecutionAuthorization } from "./core-agent-execution-authorization";
import { mapNativeNodexAgentCoreError } from "./native-nodex-agent-page-update";
import type { LibraryDatabaseModuleReadRequestV2 } from "../../shared/database-module-v2";
import {
  createCoreDatabaseModuleAdapter,
  createCoreLibraryDatabaseModuleAdapter,
} from "./database-module-adapter";

type QueryRequest = Extract<
  NodexAgentV3ReadRequest,
  {
    readonly tool: "query_database_view" | "query_data_source";
  }
>;

export async function readNativeDatabaseQuery(
  request: QueryRequest,
  runtime: NativeNodexAgentCore,
  signal?: AbortSignal,
): Promise<NodexAgentV3ReadCommandResult> {
  if (!request.authority) {
    return {
      ok: false,
      error: {
        code: "authorization_denied",
        message: "Native Agent Database query requires exact Turn authority",
        retryable: false,
        recovery: "start_new_task",
      },
    };
  }
  try {
    const authority = request.authority;
    const authorization = toCoreAgentExecutionAuthorization(
      runtime.identity.profileId,
      authority,
      request.callId ?? `nodex-agent:${request.tool}`,
      request.resourceAccess,
    );
    const commonQuery = {
      authorization,
      cursor: request.input.page?.cursor ?? null,
      limit: request.input.page?.limit ?? null,
      projection_property_ids: request.input.select?.propertyIds ?? null,
    };
    const read =
      request.tool === "query_database_view"
        ? {
            kind: "agent_view_query" as const,
            view_id: request.input.viewId,
            query: commonQuery,
          }
        : {
            kind: "agent_data_source_query" as const,
            data_source_id: request.input.dataSourceId,
            query: {
              ...commonQuery,
              filter: request.input.filter ?? {
                kind: "group",
                operator: "and",
                children: [],
              },
              sort: request.input.sort ?? [],
            },
          };
    const client = nativeAgentClient(runtime, request.projectId);
    const snapshot = signal
      ? await client.databaseRead(read, { class: "background", signal })
      : await client.databaseRead(read);
    if (
      snapshot.value.kind !== "agent_view_query" &&
      snapshot.value.kind !== "agent_data_source_query"
    ) {
      throw new Error("Core returned the wrong Agent Database query variant");
    }
    const window = snapshot.value.value;
    const descriptorInput = {
      client,
      libraryId: authority.libraryId,
      storeEpoch: snapshot.store_epoch,
      ...(signal ? { requestOptions: { class: "background" as const, signal } } : {}),
    };
    const actorProjectId = request.projectId;
    const readDescriptor =
      actorProjectId === null
        ? createCoreLibraryDatabaseModuleAdapter(descriptorInput).read
        : (read: LibraryDatabaseModuleReadRequestV2) =>
            createCoreDatabaseModuleAdapter({
              ...descriptorInput,
              projectId: actorProjectId,
            }).read({ ...read, projectId: actorProjectId });
    const [databaseResult, sourceResult] = await Promise.all([
      readDescriptor({
        read: {
          target: {
            kind: "database",
            databaseId: parseDatabaseId(window.database_id),
          },
          mode: "database",
        },
      }),
      readDescriptor({
        read: {
          target: {
            kind: "data_source",
            dataSourceId: parseDataSourceId(window.data_source_id),
          },
          mode: "data_source",
        },
      }),
    ]);
    if (!databaseResult.ok) {
      throw new Error(
        `Core could not hydrate the Agent Database descriptor: ${databaseResult.error.message}`,
      );
    }
    if (databaseResult.value.value.kind !== "database") {
      throw new Error("Core returned a non-Database Agent descriptor");
    }
    if (!sourceResult.ok) {
      throw new Error(
        `Core could not hydrate the Agent Data Source descriptor: ${sourceResult.error.message}`,
      );
    }
    if (sourceResult.value.value.kind !== "data_source") {
      throw new Error("Core returned a non-Data Source Agent descriptor");
    }
    let projectedValue;
    if (request.tool === "query_database_view") {
      if (snapshot.value.kind !== "agent_view_query") {
        throw new Error("Core returned the wrong Agent View query variant");
      }
      const viewResult = await readDescriptor({
        read: {
          target: {
            kind: "view",
            viewId: parseDatabaseViewId(snapshot.value.value.view_id),
          },
          mode: "view",
        },
      });
      if (!viewResult.ok) {
        throw new Error(
          `Core could not hydrate the Agent View descriptor: ${viewResult.error.message}`,
        );
      }
      if (viewResult.value.value.kind !== "view") {
        throw new Error("Core returned a non-View Agent descriptor");
      }
      projectedValue = {
        kind: "query" as const,
        value: projectCoreDatabaseViewQuery(
          snapshot.value.value,
          authority.libraryId,
          databaseResult.value.value.value,
          sourceResult.value.value.value,
          viewResult.value.value.value,
        ),
      };
    } else {
      if (snapshot.value.kind !== "agent_data_source_query") {
        throw new Error("Core returned the wrong Agent Data Source query variant");
      }
      projectedValue = {
        kind: "data_source_query" as const,
        value: projectCoreDataSourceQuery(
          snapshot.value.value,
          authority.libraryId,
          databaseResult.value.value.value,
          sourceResult.value.value.value,
        ),
      };
    }
    const parse =
      actorProjectId === null
        ? parseLibraryDatabaseModuleReadResultV2
        : parseDatabaseModuleReadResultV2;
    const parsed = parse({
      ok: true,
      value: {
        ...(actorProjectId === null
          ? { accessContext: { kind: "library" } }
          : { projectId: actorProjectId }),
        libraryId: authority.libraryId,
        storeEpoch: snapshot.store_epoch,
        commitSeq: snapshot.commit_head,
        authorization: snapshot.authorization,
        value: projectedValue,
      },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const query = parsed.value.value;
    if (query.kind !== "query" && query.kind !== "data_source_query") {
      throw new Error("Core returned an incompatible Agent Database projection");
    }
    return {
      ok: true,
      tool: request.tool,
      output: QueryDatabaseV6OutputSchema.parse({
        data: projectNodexAgentQueryV3Data(query, request.input.select),
        page: {
          hasMore: window.rows.next_cursor !== null,
          ...(window.rows.next_cursor ? { nextCursor: window.rows.next_cursor } : {}),
        },
      }),
    };
  } catch (error) {
    return { ok: false, error: mapNativeNodexAgentCoreError(error) };
  }
}

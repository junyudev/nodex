import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  visualCheckSchema,
  visualSnapshotSchema,
} from "../../shared/nodex-app-tools/visual-schemas";
import { libraryContentRoute, projectContentRoute } from "../../shared/content-routing-context";
import {
  nodexAgentAuthorityFingerprint,
  type NodexAgentTurnContext,
} from "../../shared/nodex-agent-authority";
import { MainConfig } from "../app/MainConfig";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { toCoreAgentExecutionAuthorization } from "../core-client/core-agent-execution-authorization";
import { LibraryModule } from "../library-application/LibraryModule";
import { renderVisualJob } from "../platform/node/VisualWorkerClient";
import { readVisualPage, readVisualPageBlock, visualPageReader } from "../visual/VisualPageSources";
import { noVisualPage } from "../visual/VisualSources";
import type { VisualWorkerResult } from "../visual/VisualWorkerProtocol";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import type { AppToolCaller } from "./AppToolCaller";
import { parseAppToolArguments, toolFailure } from "./app-tool-result";

export function isVisualTool(name: string) {
  return name === "visual_check" || name === "visual_snapshot";
}

function toolResult(result: VisualWorkerResult, includeSvg: boolean): CallToolResult {
  const { captures, diagnostics } = result;
  const structuredContent = {
    valid: !diagnostics.some(({ severity }) => severity === "error"),
    diagnostics,
    captures: captures.map(({ appearance, hash, width, height, svg }) => ({
      appearance,
      hash,
      width,
      height,
      ...(includeSvg ? { svg } : {}),
    })),
  };
  const output: CallToolResult = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          valid: structuredContent.valid,
          diagnostics,
          captures: captures.map(({ appearance, width, height }) => ({
            appearance,
            width,
            height,
          })),
        }),
      },
      ...captures.map(({ png }) => ({ type: "image" as const, mimeType: "image/png", data: png })),
    ],
    structuredContent,
  };
  if (Buffer.byteLength(JSON.stringify(output)) > 768 * 1024)
    return toolFailure("result_too_large", "Use nodex visual with --out to save these captures.");
  return output;
}

export const makeVisualAppTools = (
  capture: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(MainConfig);
    const modules = yield* CoreModules;
    const library = yield* LibraryModule;
    const core = yield* CoreAuthority;
    return Effect.fn("VisualAppTools.execute")(function* (input: AppToolInvocation) {
      const check = input.name === "visual_check";
      const parsed = check
        ? parseAppToolArguments(visualCheckSchema, input.arguments)
        : parseAppToolArguments(visualSnapshotSchema, input.arguments);
      if (!parsed.success) return parsed.result;
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const authority = yield* capture(input.caller);
      if (!authority) return toolFailure("authority_unavailable");
      const { blockId } = parsed.data;
      let source = "source" in parsed.data ? parsed.data.source : undefined;
      const appearances =
        "theme" in parsed.data && parsed.data.theme
          ? [parsed.data.theme]
          : (["light", "dark"] as const);
      let read = noVisualPage;
      if (blockId) {
        const target = yield* modules.library
          .read({
            kind: "agent_block_target",
            block_id: blockId,
            authorization: toCoreAgentExecutionAuthorization(
              core.identity.profileId,
              authority,
              input.caller.callId,
            ),
          })
          .pipe(Effect.option);
        const value =
          target._tag === "Some" && target.value.value.kind === "agent_block_target"
            ? target.value.value.value
            : undefined;
        if (!value) return toolFailure("scope_not_found", "The Block is unavailable");
        const pageId = value.owner_page_id;
        const page = yield* readVisualPage(modules, pageId).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (!page) return toolFailure("scope_not_found", "The Block's Page is unavailable");
        source ??= readVisualPageBlock(page, blockId);
        read = visualPageReader({
          page,
          pageId,
          library,
          modules,
          route: authority.actorProjectId
            ? projectContentRoute(authority.actorProjectId)
            : libraryContentRoute,
        });
      }
      if (source === undefined) return toolFailure("invalid_arguments", "Provide a Visual block");
      if (Option.isNone(config)) return toolFailure("visual_unavailable");
      const rendered = yield* Effect.result(
        renderVisualJob(config.value, { source, appearances: [...appearances] }, read),
      );
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const current = yield* capture(input.caller);
      if (
        !current ||
        nodexAgentAuthorityFingerprint(current) !== nodexAgentAuthorityFingerprint(authority)
      )
        return toolFailure("authority_unavailable");
      return rendered._tag === "Success"
        ? toolResult(rendered.success, !check)
        : toolFailure(
            "visual_unavailable",
            rendered.failure instanceof Error
              ? rendered.failure.message
              : "Visual rendering failed",
          );
    });
  });

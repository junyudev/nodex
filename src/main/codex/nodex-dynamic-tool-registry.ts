import type { z } from "zod";
import { NODEX_APP_TOOL_NAMESPACE } from "../../shared/nodex-agent-tools/identity";
import {
  NODEX_APP_V6_TOOLS,
  NODEX_APP_V6_TOOLSET_REVISION,
  type NodexAgentV6ToolName,
} from "../../shared/nodex-agent-tools/identity";
import { NODEX_AGENT_V6_TOOL_CONTRACTS } from "../../shared/nodex-agent-tools/v6-contracts";
import { NODEX_MARKDOWN_COMPACT_HINT } from "../../shared/nodex-markdown/agent-guide";
import {
  DynamicToolRegistry,
  DynamicToolRegistryError,
  type DynamicToolExecutionRequest,
} from "./dynamic-tool-registry";

export const NODEX_APP_V3_TOOL_NAMESPACE_DESCRIPTION = [
  NODEX_MARKDOWN_COMPACT_HINT,
  "Page keys are human locators: resolve them with search, then use the returned canonical Page ID for fetches and every mutation.",
  "Outputs are JSON text. In Code Mode, compose dependent calls in one JavaScript pipeline, parse each result, throw on result.error, keep intermediate rows, Markdown, cursors, and ETags inside JavaScript, serialize dependent writes, and emit only a bounded summary with text().",
].join(" ");

type NodexAgentV3ToolContracts = typeof NODEX_AGENT_V6_TOOL_CONTRACTS;

export type NodexAgentV3ToolInput<TTool extends NodexAgentV6ToolName> = z.output<
  NodexAgentV3ToolContracts[TTool]["inputSchema"]
>;

export type NodexAgentV3ToolOutput<TTool extends NodexAgentV6ToolName> = z.input<
  NodexAgentV3ToolContracts[TTool]["outputSchema"]
>;

export type NodexAgentV3ToolHandlers<TContext> = {
  readonly [TTool in NodexAgentV6ToolName]: (
    request: DynamicToolExecutionRequest<NodexAgentV3ToolInput<TTool>, TContext>,
  ) => Promise<NodexAgentV3ToolOutput<TTool>> | NodexAgentV3ToolOutput<TTool>;
};

function catalogOnlyHandler(): never {
  throw new Error("Catalog-only Nodex tool handlers cannot execute");
}

interface CatalogContract {
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly deferLoading: boolean;
}

function registerNodexAgentV3Tool<TContext, TTool extends NodexAgentV6ToolName>(
  registry: DynamicToolRegistry<TContext>,
  handlers: NodexAgentV3ToolHandlers<TContext>,
  tool: TTool,
): void {
  const contract = NODEX_AGENT_V6_TOOL_CONTRACTS[tool];
  registry.register({
    namespace: NODEX_APP_TOOL_NAMESPACE,
    namespaceDescription: NODEX_APP_V3_TOOL_NAMESPACE_DESCRIPTION,
    toolsetRevision: NODEX_APP_V6_TOOLSET_REVISION,
    tool,
    description: contract.description,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    deferLoading: contract.deferLoading,
    classifyEffect: (input) => contract.classifyEffect(input as never),
    execute: (request) => handlers[tool](request as never),
  });
}

export function createNodexV3DynamicToolRegistry<TContext>(
  handlers: NodexAgentV3ToolHandlers<TContext>,
): DynamicToolRegistry<TContext> {
  const registry = new DynamicToolRegistry<TContext>();
  for (const tool of NODEX_APP_V6_TOOLS) {
    registerNodexAgentV3Tool(registry, handlers, tool);
  }
  return registry;
}

/**
 * Build the exact production catalog without importing the Agent service or
 * constructing any runtime/store dependencies.
 */
function createNodexCatalogOnlyRegistry(input: {
  readonly tools: readonly string[];
  readonly contracts: Readonly<Record<string, CatalogContract>>;
  readonly namespaceDescription: string;
  readonly toolsetRevision: number;
}) {
  const registry = new DynamicToolRegistry<never>();
  for (const tool of input.tools) {
    const contract = input.contracts[tool];
    if (!contract) throw new Error(`Missing Nodex catalog contract: ${tool}`);
    registry.register({
      namespace: NODEX_APP_TOOL_NAMESPACE,
      namespaceDescription: input.namespaceDescription,
      toolsetRevision: input.toolsetRevision,
      tool,
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      deferLoading: contract.deferLoading,
      classifyEffect: () => "read",
      execute: catalogOnlyHandler,
    });
  }
  return registry;
}

const nodexAgentV3CatalogRegistry = createNodexCatalogOnlyRegistry({
  tools: NODEX_APP_V6_TOOLS,
  contracts: NODEX_AGENT_V6_TOOL_CONTRACTS,
  namespaceDescription: NODEX_APP_V3_TOOL_NAMESPACE_DESCRIPTION,
  toolsetRevision: NODEX_APP_V6_TOOLSET_REVISION,
});

export function buildNodexAgentV3DynamicToolCatalog() {
  return nodexAgentV3CatalogRegistry.buildCatalog([
    {
      namespace: NODEX_APP_TOOL_NAMESPACE,
      toolsetRevision: NODEX_APP_V6_TOOLSET_REVISION,
    },
  ]);
}

export function validateNodexAgentV3DynamicToolCall(input: {
  readonly toolsetRevision: number;
  readonly tool: string;
  readonly arguments: unknown;
}) {
  return nodexAgentV3CatalogRegistry.validate(
    {
      namespace: NODEX_APP_TOOL_NAMESPACE,
      toolsetRevision: input.toolsetRevision,
      tool: input.tool,
    },
    input.arguments,
  );
}

export function validateNodexAgentV3DynamicToolOutput(input: {
  readonly tool: NodexAgentV6ToolName;
  readonly output: unknown;
}): unknown {
  const parsed = NODEX_AGENT_V6_TOOL_CONTRACTS[input.tool].outputSchema.safeParse(input.output);
  if (parsed.success) return parsed.data;
  throw new DynamicToolRegistryError(
    "invalid_output",
    `Invalid output from ${NODEX_APP_TOOL_NAMESPACE}.${input.tool}`,
    parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    }),
  );
}

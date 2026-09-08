export interface BrowserWebMcpTool {
  name: string;
  description: string;
  title?: string;
  inputSchema?: object;
  annotations?: Record<string, unknown>;
  execute: (input: object, context: { requestUserInteraction: () => Promise<never> }) => unknown;
}

export interface BrowserWebMcpRegistrationOptions {
  signal?: Pick<AbortSignal, "aborted" | "reason" | "addEventListener">;
}

interface RegisteredTool extends Omit<BrowserWebMcpTool, "inputSchema"> {
  inputSchema?: string;
  registrationId: string;
  signal?: BrowserWebMcpRegistrationOptions["signal"];
}

export interface BrowserWebMcpDescriptor {
  name: string;
  description: string;
  inputSchema: string | null;
  title?: string;
  annotations?: Record<string, unknown>;
  origin?: string;
  pageUrl?: string;
}

export interface BrowserWebMcpModelContext {
  registerTool: (
    tool: BrowserWebMcpTool,
    options?: BrowserWebMcpRegistrationOptions,
  ) => Promise<void>;
  getTools: () => Promise<BrowserWebMcpDescriptor[]>;
  executeTool: (tool: { name: string }, input: object) => Promise<string>;
  codexGetTools: () => Array<BrowserWebMcpDescriptor & { registrationId: string }>;
  codexExecuteTool: (
    tool: { name: string; registrationId: string },
    input: string,
  ) => Promise<string>;
}

function validateToolName(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value)) return value;
  throw new DOMException(
    "WebMCP tool names must contain 1-128 ASCII letters, digits, underscores, hyphens, or periods.",
    "InvalidStateError",
  );
}

/** One document owns registrations; registration IDs fence stale tool snapshots. */
export function createBrowserWebMcpModelContext(options: {
  location: Pick<Location, "href" | "origin" | "protocol">;
  isSecureContext: () => boolean;
  isOriginAgentCluster: () => boolean;
  onToolsChanged?: () => void;
}): BrowserWebMcpModelContext {
  const tools = new Map<string, RegisteredTool>();
  const parseJson = JSON.parse;
  const stringifyJson = JSON.stringify;
  const randomValues = crypto.getRandomValues.bind(crypto);
  const schedule = globalThis.setTimeout.bind(globalThis);
  const executionContext = {
    async requestUserInteraction(): Promise<never> {
      throw new Error("requestUserInteraction is not supported by the WebMCP shim.");
    },
  };
  const requireSecureDocument = () => {
    if (!options.isSecureContext()) {
      throw new DOMException("WebMCP requires a secure context.", "SecurityError");
    }
    if (options.location.protocol !== "file:" && !options.isOriginAgentCluster()) {
      throw new DOMException("WebMCP requires an origin-keyed agent cluster.", "SecurityError");
    }
  };
  const notifyToolsChanged = () => {
    try {
      options.onToolsChanged?.();
    } catch {
      // Presentation listeners cannot invalidate a completed registration change.
    }
  };
  const describe = (tool: RegisteredTool): BrowserWebMcpDescriptor => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? null,
    ...(tool.title == null ? {} : { title: tool.title }),
    ...(tool.annotations == null ? {} : { annotations: { ...tool.annotations } }),
    origin: options.location.origin,
    pageUrl: options.location.href,
  });
  const registeredTools = () => {
    requireSecureDocument();
    return [...tools.values()].filter((tool) => !tool.signal?.aborted);
  };
  const execute = async (
    descriptor: { name: string; registrationId?: string },
    input: unknown,
    requireRegistrationId: boolean,
  ): Promise<string> => {
    requireSecureDocument();
    if (typeof input !== "object" || !input) {
      throw new Error("WebMCP executeTool requires an object input.");
    }
    const name = validateToolName(descriptor?.name);
    const tool = tools.get(name);
    const staleMessage = `WebMCP tool ${JSON.stringify(name)} is stale. Call fetchTools() again.`;
    if (!tool || tool.signal?.aborted) {
      throw new Error(requireRegistrationId ? staleMessage : `WebMCP tool not found: ${name}`);
    }
    if (requireRegistrationId && tool.registrationId !== descriptor.registrationId) {
      throw new Error(staleMessage);
    }
    const result = await tool.execute(input, executionContext);
    try {
      const serialized = stringifyJson(result === undefined ? null : result);
      if (serialized === undefined) throw new Error();
      return serialized;
    } catch {
      throw new Error("WebMCP tool result is not JSON-serializable.");
    }
  };
  return Object.freeze({
    async registerTool(tool: BrowserWebMcpTool, registration?: BrowserWebMcpRegistrationOptions) {
      requireSecureDocument();
      const name = validateToolName(tool?.name);
      if (tools.has(name)) {
        throw new DOMException(
          `WebMCP tool ${JSON.stringify(name)} is already registered.`,
          "InvalidStateError",
        );
      }
      if (typeof tool.description !== "string" || tool.description.length === 0) {
        throw new DOMException(
          "WebMCP tools must have a non-empty description.",
          "InvalidStateError",
        );
      }
      if (typeof tool.execute !== "function")
        throw new Error(`WebMCP tool ${name} is missing an execute callback.`);
      if (
        tool.inputSchema !== undefined &&
        (typeof tool.inputSchema !== "object" || !tool.inputSchema)
      ) {
        throw new TypeError("WebMCP tool inputSchema must be an object.");
      }
      const inputSchema =
        tool.inputSchema === undefined ? undefined : stringifyJson(tool.inputSchema);
      if (tool.inputSchema !== undefined && inputSchema === undefined) {
        throw new Error("WebMCP tool inputSchema must be JSON-serializable.");
      }
      const signal = registration?.signal;
      if (signal?.aborted) throw signal.reason;
      if (signal && typeof signal.addEventListener !== "function") {
        throw new Error("WebMCP tool registration signal must support abort events.");
      }
      const record: RegisteredTool = {
        name,
        description: tool.description,
        execute: tool.execute,
        registrationId: [...randomValues(new Uint32Array(4))].join("-"),
        ...(signal ? { signal } : {}),
        ...(inputSchema === undefined ? {} : { inputSchema }),
        ...(tool.title == null ? {} : { title: tool.title }),
        ...(tool.annotations == null ? {} : { annotations: { ...tool.annotations } }),
      };
      return new Promise<void>((resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(signal.reason);
            if (tools.get(name) !== record) return;
            tools.delete(name);
            notifyToolsChanged();
          },
          { once: true },
        );
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        tools.set(name, record);
        notifyToolsChanged();
        schedule(resolve, 0);
      });
    },
    async getTools() {
      return registeredTools().map(describe);
    },
    codexGetTools() {
      return registeredTools().map((tool) => ({
        ...describe(tool),
        registrationId: tool.registrationId,
      }));
    },
    async executeTool(tool: { name: string }, input: object) {
      let copy: unknown;
      try {
        const serialized = stringifyJson(input);
        if (serialized === undefined) throw new Error();
        copy = parseJson(serialized);
      } catch {
        throw new Error("WebMCP executeTool requires a JSON-serializable object input.");
      }
      return execute(tool, copy, false);
    },
    async codexExecuteTool(tool: { name: string; registrationId: string }, input: string) {
      let parsed: unknown;
      try {
        parsed = parseJson(input);
      } catch {
        throw new Error("WebMCP executeTool requires a JSON-stringified input.");
      }
      return execute(tool, parsed, true);
    },
  });
}

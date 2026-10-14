import {
  McpAppRuntime,
  type McpAppRuntimeConfig,
  type McpAppRuntimeSnapshot,
} from "./mcp-app-runtime";
import { resolveMcpAppSandboxOriginScope } from "../../../shared/mcp-app/mcp-app-scope";
import { moveNativeSubtree } from "../move-native-subtree";

export type McpAppSurfaceMode = "fullscreen" | "inline" | "side-panel";

interface McpAppSurface {
  element: HTMLElement;
  mode: McpAppSurfaceMode;
  visible: boolean;
}

interface McpAppRuntimeEntry {
  config: McpAppRuntimeConfig;
  runtime: McpAppRuntimePort;
  surfaces: Map<HTMLElement, McpAppSurface>;
  teardownTimer: ReturnType<typeof setTimeout> | null;
}

const RUNTIME_TEARDOWN_GRACE_MS = 500;

export interface McpAppRuntimePort {
  readonly element: HTMLElement;
  dispose(): Promise<void>;
  getSnapshot(): McpAppRuntimeSnapshot;
  setDisplayMode(mode: McpAppSurfaceMode): void;
  subscribe(listener: () => void): () => void;
  update(config: McpAppRuntimeConfig): void;
}

const SURFACE_PRIORITY: Record<McpAppSurfaceMode, number> = {
  fullscreen: 3,
  "side-panel": 2,
  inline: 1,
};

function requiresSandboxRestart(previous: McpAppRuntimeConfig, next: McpAppRuntimeConfig): boolean {
  const restartKey = (config: McpAppRuntimeConfig) =>
    JSON.stringify({
      csp: config.resource.metadata.csp,
      currentToolName: config.currentToolName,
      modelContextIdentity: config.modelContext?.identity ?? null,
      html: config.resource.html,
      originScope: resolveMcpAppSandboxOriginScope({
        currentToolName: config.currentToolName,
        instanceFallbackId: config.capabilityId,
        server: config.server,
        statuses: config.statuses,
      }),
      resourceUri: config.resource.uri,
      server: config.server,
      threadId: config.threadId,
      widgetDomain: config.resource.metadata.domain,
    });
  return restartKey(previous) !== restartKey(next);
}

export class McpAppRuntimeManager {
  readonly #entries = new Map<string, McpAppRuntimeEntry>();
  readonly #runtimeListeners = new Map<string, Set<() => void>>();
  readonly #createRuntime: (config: McpAppRuntimeConfig) => McpAppRuntimePort;

  constructor(
    createRuntime: (config: McpAppRuntimeConfig) => McpAppRuntimePort = (config) =>
      new McpAppRuntime(config),
  ) {
    this.#createRuntime = createRuntime;
  }

  upsert(config: McpAppRuntimeConfig): McpAppRuntimePort {
    const existing = this.#entries.get(config.capabilityId);
    if (existing) {
      if (requiresSandboxRestart(existing.config, config)) {
        const previous = existing.runtime;
        existing.config = config;
        existing.runtime = this.#createRuntime(config);
        void previous.dispose();
        this.#placeRuntime(existing);
        this.#notifyRuntime(config.capabilityId);
        return existing.runtime;
      }
      existing.config = config;
      existing.runtime.update(config);
      return existing.runtime;
    }
    const runtime = this.#createRuntime(config);
    this.#entries.set(config.capabilityId, {
      config,
      runtime,
      surfaces: new Map(),
      teardownTimer: null,
    });
    this.#notifyRuntime(config.capabilityId);
    return runtime;
  }

  retry(capabilityId: string): McpAppRuntimePort | null {
    const entry = this.#entries.get(capabilityId);
    if (!entry) return null;
    const previous = entry.runtime;
    entry.runtime = this.#createRuntime(entry.config);
    void previous.dispose();
    this.#placeRuntime(entry);
    this.#notifyRuntime(capabilityId);
    return entry.runtime;
  }

  /** Observe the capability's runtime identity; each runtime owns its own presentation snapshots. */
  subscribeRuntime(capabilityId: string, listener: () => void): () => void {
    const listeners = this.#runtimeListeners.get(capabilityId) ?? new Set<() => void>();
    listeners.add(listener);
    this.#runtimeListeners.set(capabilityId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.#runtimeListeners.get(capabilityId) === listeners) {
        this.#runtimeListeners.delete(capabilityId);
      }
    };
  }

  get(capabilityId: string): McpAppRuntimePort | null {
    return this.#entries.get(capabilityId)?.runtime ?? null;
  }

  getSnapshot(capabilityId: string): McpAppRuntimeSnapshot {
    return (
      this.get(capabilityId)?.getSnapshot() ?? {
        diagnostic: null,
        error: new Error("MCP App runtime is unavailable."),
        requestedDisplayMode: null,
        status: "error",
      }
    );
  }

  registerSurface(input: {
    capabilityId: string;
    element: HTMLElement;
    mode: McpAppSurfaceMode;
    visible: boolean;
  }): () => void {
    const entry = this.#entries.get(input.capabilityId);
    if (!entry) return () => undefined;
    if (entry.teardownTimer) {
      clearTimeout(entry.teardownTimer);
      entry.teardownTimer = null;
    }
    entry.surfaces.set(input.element, input);
    this.#placeRuntime(entry);
    return () => {
      entry.surfaces.delete(input.element);
      this.#placeRuntime(entry);
      if (entry.surfaces.size > 0) return;
      entry.teardownTimer = setTimeout(() => {
        if (entry.surfaces.size > 0) return;
        this.#entries.delete(input.capabilityId);
        void entry.runtime.dispose();
        this.#notifyRuntime(input.capabilityId);
      }, RUNTIME_TEARDOWN_GRACE_MS);
    };
  }

  #notifyRuntime(capabilityId: string): void {
    for (const listener of [...(this.#runtimeListeners.get(capabilityId) ?? [])]) listener();
  }

  #placeRuntime(entry: McpAppRuntimeEntry): void {
    const surface = [...entry.surfaces.values()]
      .filter((candidate) => candidate.visible && candidate.element.isConnected)
      .sort((left, right) => SURFACE_PRIORITY[right.mode] - SURFACE_PRIORITY[left.mode])[0];
    if (!surface) {
      entry.runtime.element.remove();
      return;
    }
    if (entry.runtime.element.parentElement !== surface.element) {
      moveNativeSubtree(entry.runtime.element, surface.element);
    }
    entry.runtime.setDisplayMode(surface.mode);
  }
}

export const mcpAppRuntimeManager = new McpAppRuntimeManager();

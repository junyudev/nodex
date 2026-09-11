import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";

/** Renderer local identity is an alias; native requests require the configured physical host. */
export const resolveRendererHostId = (hostId: string, localHostId: string): string =>
  hostId === DEFAULT_CODEX_HOST_ID ? localHostId : hostId;

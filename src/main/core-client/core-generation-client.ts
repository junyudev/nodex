import type { components } from "@nodex/core-protocol";
import type { CoreClientPort, CoreHandshakeResponse } from "./types";

type HealthResponse = components["schemas"]["HealthResponse"];
type ShutdownResponse = components["schemas"]["ShutdownResponse"];

/** Promise-facing Core generation contract at the HTTP transport frontier. */
export interface CoreGenerationClient extends CoreClientPort {
  readonly handshake: CoreHandshakeResponse;
  readonly spaceName?: string;
  forProject(projectId: string): CoreGenerationClient;
  forInvocation?(credential: string): CoreGenerationClient;
  health(): Promise<HealthResponse>;
  shutdown(): Promise<ShutdownResponse>;
}

export type DesktopCoreClient = CoreGenerationClient;

export interface CoreAuthorityIdentity {
  readonly libraryId: string;
  readonly profileId: string;
  readonly storeEpoch: string;
}

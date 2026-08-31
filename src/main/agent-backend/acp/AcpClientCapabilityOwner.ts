import type {
  ClientCapabilities,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AcpRuntimeError } from "./AcpRuntimeError";
import { AcpInteractionAuthority } from "./AcpInteractionAuthority";
import { AcpTerminalOwner } from "./AcpTerminalOwner";
import { AcpWorkspaceFileOwner } from "./AcpWorkspaceFileOwner";

export interface AcpStableClientCapabilityProfile {
  readonly fs: {
    readonly readTextFile: boolean;
    readonly writeTextFile: boolean;
  };
  readonly terminal: boolean;
  readonly auth: {
    /** Terminal auth stays disabled until Nodex has an interactive invocation presenter. */
    readonly terminal: false;
  };
  readonly elicitation: {
    readonly form: boolean;
    readonly url: boolean;
  };
}

export const noAcpClientCapabilities: AcpStableClientCapabilityProfile = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
  elicitation: { form: false, url: false },
};

export const workspaceAcpClientCapabilities: AcpStableClientCapabilityProfile = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: false },
  elicitation: { form: false, url: false },
};

export const interactiveWorkspaceAcpClientCapabilities: AcpStableClientCapabilityProfile = {
  ...workspaceAcpClientCapabilities,
  elicitation: { form: true, url: true },
};

export interface AcpClientCapabilityHandlers {
  readonly requestPermission: (
    request: RequestPermissionRequest,
  ) => Effect.Effect<RequestPermissionResponse, AcpRuntimeError>;
  readonly readTextFile?: (
    request: ReadTextFileRequest,
  ) => Effect.Effect<ReadTextFileResponse, AcpRuntimeError>;
  readonly writeTextFile?: (
    request: WriteTextFileRequest,
  ) => Effect.Effect<WriteTextFileResponse, AcpRuntimeError>;
  readonly createTerminal?: (
    request: CreateTerminalRequest,
  ) => Effect.Effect<CreateTerminalResponse, AcpRuntimeError>;
  readonly terminalOutput?: (
    request: TerminalOutputRequest,
  ) => Effect.Effect<TerminalOutputResponse, AcpRuntimeError>;
  readonly waitForTerminalExit?: (
    request: WaitForTerminalExitRequest,
  ) => Effect.Effect<WaitForTerminalExitResponse, AcpRuntimeError>;
  readonly killTerminal?: (
    request: KillTerminalRequest,
  ) => Effect.Effect<KillTerminalResponse, AcpRuntimeError>;
  readonly releaseTerminal?: (
    request: ReleaseTerminalRequest,
  ) => Effect.Effect<ReleaseTerminalResponse, AcpRuntimeError>;
  readonly createElicitation?: (
    request: CreateElicitationRequest,
  ) => Effect.Effect<CreateElicitationResponse, AcpRuntimeError>;
  readonly completeElicitation?: (
    notification: CompleteElicitationNotification,
  ) => Effect.Effect<void, AcpRuntimeError>;
}

export class AcpClientCapabilityOwner extends Context.Service<
  AcpClientCapabilityOwner,
  {
    readonly profile: AcpStableClientCapabilityProfile;
    readonly advertised: ClientCapabilities;
    readonly handlers: AcpClientCapabilityHandlers;
  }
>()("nodex/main/agent-backend/acp/AcpClientCapabilityOwner") {}

const advertisedCapabilities = (profile: AcpStableClientCapabilityProfile): ClientCapabilities => ({
  ...(profile.fs.readTextFile || profile.fs.writeTextFile
    ? {
        fs: {
          readTextFile: profile.fs.readTextFile,
          writeTextFile: profile.fs.writeTextFile,
        },
      }
    : {}),
  ...(profile.terminal ? { terminal: true } : {}),
  auth: { terminal: false },
  ...(profile.elicitation.form || profile.elicitation.url
    ? {
        elicitation: {
          ...(profile.elicitation.form ? { form: {} } : {}),
          ...(profile.elicitation.url ? { url: {} } : {}),
        },
      }
    : {}),
});

export const live = (
  profile: AcpStableClientCapabilityProfile,
): Layer.Layer<
  AcpClientCapabilityOwner,
  never,
  AcpInteractionAuthority | AcpWorkspaceFileOwner | AcpTerminalOwner
> =>
  Layer.effect(
    AcpClientCapabilityOwner,
    Effect.gen(function* () {
      const interaction = yield* AcpInteractionAuthority;
      const files = yield* AcpWorkspaceFileOwner;
      const terminals = yield* AcpTerminalOwner;
      return AcpClientCapabilityOwner.of({
        profile,
        advertised: advertisedCapabilities(profile),
        handlers: {
          requestPermission: interaction.requestPermission,
          ...(profile.fs.readTextFile ? { readTextFile: files.readTextFile } : {}),
          ...(profile.fs.writeTextFile ? { writeTextFile: files.writeTextFile } : {}),
          ...(profile.terminal
            ? {
                createTerminal: terminals.create,
                terminalOutput: terminals.output,
                waitForTerminalExit: terminals.waitForExit,
                killTerminal: terminals.kill,
                releaseTerminal: terminals.release,
              }
            : {}),
          ...(profile.elicitation.form || profile.elicitation.url
            ? {
                createElicitation: (request: CreateElicitationRequest) => {
                  if (request.mode === "form" && profile.elicitation.form) {
                    return interaction.createElicitation(request);
                  }
                  if (request.mode === "url" && profile.elicitation.url) {
                    return interaction.createElicitation(request);
                  }
                  return Effect.succeed({ action: "cancel" as const });
                },
              }
            : {}),
          ...(profile.elicitation.url
            ? { completeElicitation: interaction.completeElicitation }
            : {}),
        },
      });
    }),
  );

/** Builds a permission-only client with no ambient filesystem, terminal, auth, or elicitation. */
export const permissionOnly = (
  requestPermission: AcpClientCapabilityHandlers["requestPermission"],
): Layer.Layer<AcpClientCapabilityOwner> =>
  Layer.succeed(
    AcpClientCapabilityOwner,
    AcpClientCapabilityOwner.of({
      profile: noAcpClientCapabilities,
      advertised: advertisedCapabilities(noAcpClientCapabilities),
      handlers: { requestPermission },
    }),
  );

/** Test/bootstrap owner that rejects every permission request. */
export const denied: Layer.Layer<AcpClientCapabilityOwner> = permissionOnly(() =>
  Effect.succeed({ outcome: { outcome: "cancelled" } }),
);

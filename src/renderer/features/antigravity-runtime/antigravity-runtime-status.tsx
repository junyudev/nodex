import { useEffect, useState } from "react";
import { NodexButton } from "@/components/ui/button";
import { NodexSettingsRow } from "@/components/ui/settings";
import { useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  antigravityExecutableDescription,
  antigravityRuntimeView,
} from "./antigravity-runtime-model";
import {
  antigravityRuntimeOwner,
  type AntigravityRuntimeOwner,
  useAntigravityRuntime,
} from "./antigravity-runtime-owner";

interface RuntimeStatusProps {
  readonly owner?: AntigravityRuntimeOwner;
  /** Pass the Settings disclosure state when its contents stay mounted while closed. */
  readonly open?: boolean;
}

/**
 * The one runtime every Antigravity profile runs: its state, one next step and its removal. With
 * no profile left the row only remains while there is a download to remove.
 */
export function AntigravityRuntimeRow({
  owner = antigravityRuntimeOwner,
  open = true,
  profileCount,
}: RuntimeStatusProps & { readonly profileCount: number }) {
  const intl = useIntl();
  const snapshot = useAntigravityRuntime(owner, open);
  const view = antigravityRuntimeView(snapshot, intl);
  const [confirming, setConfirming] = useState(false);
  const hasProfiles = profileCount > 0;
  useEffect(() => {
    if (open && hasProfiles) void owner.run("check");
  }, [hasProfiles, open, owner]);
  if (!hasProfiles && !snapshot.state?.inspection?.managed) return null;
  const primary = view.primary;
  const removing = confirming && view.canRemove;
  return (
    <NodexSettingsRow
      label={intl.formatMessage({ id: "antigravityRuntime.label", defaultMessage: "Runtime" })}
      description={
        removing ? (
          intl.formatMessage({
            id: "antigravityRuntime.confirmRemoval",
            defaultMessage:
              "Remove the downloaded Antigravity runtime? Sign-ins and chats are kept.",
          })
        ) : (
          <span
            role="status"
            className={cn(
              view.tone === "danger" && "text-danger",
              view.tone === "warning" && "text-warning",
            )}
          >
            {view.text}
          </span>
        )
      }
    >
      {removing ? (
        <>
          <NodexButton
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              void owner.run("remove");
            }}
          >
            {intl.formatMessage({ id: "antigravityRuntime.remove", defaultMessage: "Remove" })}
          </NodexButton>
          <NodexButton size="sm" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
            {intl.formatMessage({ id: "antigravityRuntime.keep", defaultMessage: "Keep" })}
          </NodexButton>
        </>
      ) : (
        <>
          {view.canRemove && primary?.kind !== "remove" ? (
            <NodexButton size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              {intl.formatMessage({ id: "antigravityRuntime.remove", defaultMessage: "Remove" })}
            </NodexButton>
          ) : null}
          {primary ? (
            <NodexButton
              size="sm"
              variant={primary.kind === "cancel" || primary.optional ? "ghost" : "secondary"}
              disabled={snapshot.pending !== null}
              focusableWhenDisabled
              onClick={() => {
                if (primary.kind === "remove") setConfirming(true);
                else void owner.run(primary.kind);
              }}
            >
              {primary.label}
            </NodexButton>
          ) : null}
        </>
      )}
    </NodexSettingsRow>
  );
}

/** A saved profile's effective executable, with an optional path from the current Settings draft. */
export function AntigravityProfileExecutable({
  profileId,
  binaryPath,
  owner,
  open = true,
}: RuntimeStatusProps & { readonly profileId: string; readonly binaryPath?: string }) {
  const intl = useIntl();
  const inspection = useAntigravityRuntime(owner, open).state?.inspection;
  const instanceId = profileId;
  const choice = inspection?.instances.find((entry) => entry.instanceId === instanceId);
  return <span>{antigravityExecutableDescription(choice, inspection, binaryPath, intl)}</span>;
}

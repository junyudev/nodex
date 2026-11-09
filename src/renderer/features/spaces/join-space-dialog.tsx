import { readableIpcError } from "@/lib/ipc-error-message";
import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { ShieldCheck } from "@/components/shared/icons/generic-icons";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
  NodexDialogBody,
  NodexDialogFooter,
  NodexDialogAction,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useScopeHandle, appScope } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";
import {
  JoinSpaceInputSchema,
  parseSpaceInvite,
  type JoinSpaceInput,
} from "../../../shared/space-connection";
import { joinSpace, switchSpace } from "./spaces-runtime";

type JoinField = Exclude<keyof JoinSpaceInput, "inviteUrl" | "fingerprint">;

const PERSON_FIELDS: readonly (readonly [JoinField, string, "text" | "password"])[] = [
  ["code", "One-time code", "password"],
  ["displayName", "Your name", "text"],
  ["deviceLabel", "Device label", "text"],
];

/** The fingerprint the invite pins, or null while the URL is incomplete or carries none. */
function invitedFingerprint(inviteUrl: string): string | null {
  try {
    return parseSpaceInvite(inviteUrl).fingerprint || null;
  } catch {
    return null;
  }
}

const shortFingerprint = (fingerprint: string): string =>
  `${fingerprint.slice(0, 8)}…${fingerprint.slice(-8)}`.toUpperCase();

function TextField({
  label,
  name,
  type,
  value,
  onBlur,
  onChange,
}: {
  label: string;
  name: string;
  type: "url" | "text" | "password";
  value: string;
  onBlur: () => void;
  onChange: (value: string) => void;
}) {
  return (
  );
}

export function JoinSpaceDialog({ onClose }: ModalCloseProps) {
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const form = useForm({
    defaultValues: {
      inviteUrl: "",
      fingerprint: "",
      code: "",
      displayName: "",
      deviceLabel: "Desktop",
    } satisfies JoinSpaceInput,
    validators: { onSubmit: JoinSpaceInputSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        const space = await joinSpace(value);
        onClose();
        await switchSpace(space.spaceId);
      } catch (cause) {
        setError(readableIpcError(cause, "Could not join this Space"));
      }
    },
  });
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="compact">
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>Join a Space</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody className="space-y-3">
            <div className="space-y-1.5">
              <form.Field name="inviteUrl">
                {(field) => (
                  <TextField
                    label="Invite URL"
                    name="inviteUrl"
                    type="url"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(value) => {
                      field.handleChange(value);
                      const fingerprint = invitedFingerprint(value);
                      // A pin belongs to the invite that carried it; never keep a stale one.
                      if (fingerprint || pinned)
                        form.setFieldValue("fingerprint", fingerprint ?? "");
                      setPinned(fingerprint);
                    }}
                  />
                )}
              </form.Field>
              {pinned ? (
                <p className="flex items-center gap-1.5 text-xs text-token-description-foreground">
                  <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
                  <span>Certificate pinned</span>
                  <span className="font-mono">{shortFingerprint(pinned)}</span>
                </p>
              ) : null}
            </div>
            {pinned ? null : (
              <form.Field name="fingerprint">
                {(field) => (
                  <TextField
                    label="Certificate fingerprint"
                    name="fingerprint"
                    type="text"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            )}
            {PERSON_FIELDS.map(([name, label, type]) => (
                {(field) => (
                  <TextField
                    label={label}
                    name={name}
                    type={type}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            ))}
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, pending]) => (
                <NodexDialogAction type="submit" tone="primary" disabled={!canSubmit || pending}>
                  {pending ? "Joining…" : "Join"}
                </NodexDialogAction>
              )}
            </form.Subscribe>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function useOpenJoinSpace(): () => void {
  const scope = useScopeHandle(appScope);
  return () => openModal(scope, JoinSpaceDialog, {});
}

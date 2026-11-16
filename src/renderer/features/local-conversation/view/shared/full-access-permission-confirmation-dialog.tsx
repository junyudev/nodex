import { FormattedMessage, defineMessage, useIntl } from "@/lib/i18n";
import {
  PermissionFilesCapabilityIcon,
  PermissionFullAccessWarningIcon,
  PermissionInternetCapabilityIcon,
  PermissionTerminalCapabilityIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import type { ModalCloseProps } from "@/lib/modal-registry";

const FULL_ACCESS_CAPABILITIES = [
  {
    title: defineMessage({
      id: "conversation.fullAccessPermissionConfirmationDialog.files",
      defaultMessage: "Files and folders",
    }),
    description: defineMessage({
      id: "conversation.fullAccessPermissionConfirmationDialog.filesDescription",
      defaultMessage: "Read, create, change, or delete files anywhere on this computer",
    }),
    icon: PermissionFilesCapabilityIcon,
  },
  {
    title: defineMessage({
      id: "conversation.fullAccessPermissionConfirmationDialog.terminal",
      defaultMessage: "Terminal commands",
    }),
    description: defineMessage({
      id: "conversation.fullAccessPermissionConfirmationDialog.terminalDescription",
      defaultMessage: "Run commands, install software, and change system settings",
    }),
    icon: PermissionTerminalCapabilityIcon,
  },
  {
    title: defineMessage({
      id: "conversation.fullAccessPermissionConfirmationDialog.connectedApps",
      defaultMessage: "Internet and connected apps",
    }),
    description: defineMessage({
      id: "conversation.fullAccessPermissionConfirmationDialog.connectedAppsDescription",
      defaultMessage: "Reach websites, send data, and use enabled tools",
    }),
    icon: PermissionInternetCapabilityIcon,
  },
] as const;

export function FullAccessPermissionConfirmationDialog({
  onClose,
  onConfirm,
}: ModalCloseProps & {
  readonly onConfirm: () => void;
}) {
  const intl = useIntl();
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
            onClose();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle className="flex items-center gap-2">
              <PermissionFullAccessWarningIcon />
              <span>
                <FormattedMessage
                  id="conversation.fullAccessPermissionConfirmationDialog.title"
                  defaultMessage="Turn on Full access?"
                />
              </span>
            </NodexDialogTitle>
            <NodexDialogDescription className="text-pretty">
              <FormattedMessage
                id="conversation.fullAccessPermissionConfirmationDialog.description"
                defaultMessage="The Agent will act on this computer without asking first, including:"
              />
            </NodexDialogDescription>
          </NodexDialogHeader>

          <NodexDialogBody>
            <div className="flex flex-col">
              {FULL_ACCESS_CAPABILITIES.map((capability) => {
                const CapabilityIcon = capability.icon;
                return (
                  <div
                    key={capability.title.id}
                    className="flex items-center gap-3 border-b-[0.5px] border-token-border/70 py-2 first:pt-0 last:border-b-0 last:pb-0"
                  >
                    <CapabilityIcon />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-token-foreground">
                        {intl.formatMessage(capability.title)}
                      </div>
                      <div className="text-xs text-token-description-foreground">
                        {intl.formatMessage(capability.description)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </NodexDialogBody>

          <NodexDialogBody>
            <p className="text-pretty text-sm text-token-description-foreground">
              <FormattedMessage
                id="conversation.fullAccessPermissionConfirmationDialog.risks"
                defaultMessage="Risks include data loss, exposure of sensitive data, and instructions hidden in content the Agent reads. Its access to your Pages and chats is the same in every mode."
              />
            </p>
          </NodexDialogBody>

          <NodexDialogFooter>
            <NodexDialogAction autoFocus onClick={onClose}>
              <FormattedMessage
                id="conversation.fullAccessPermissionConfirmationDialog.cancel"
                defaultMessage="Cancel"
              />
            </NodexDialogAction>
            <NodexDialogAction type="submit" tone="danger">
              <FormattedMessage
                id="conversation.fullAccessPermissionConfirmationDialog.enable"
                defaultMessage="Turn on"
              />
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

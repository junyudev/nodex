import type { IpcApi } from "../../../shared/ipc-api";
import {
  DEFAULT_BROWSER_USE_POLICY,
  MAX_BROWSER_USE_POLICY_ORIGINS,
  normalizeBrowserUsePolicyOrigin,
  type BrowserUseOriginRuleUpdate,
  type BrowserUsePolicyModesUpdate,
  type BrowserUsePolicyResource,
  type BrowserUsePolicySnapshot,
} from "../../../shared/browser-use-policy";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import {
  createLatestReturnedValueOwner,
  type LatestReturnedValueOwner,
  type LatestReturnedValuePort,
} from "@/lib/latest-returned-value-owner";
import type { RendererCausalTrace } from "@/lib/renderer-causal-trace";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokePlainCommandWithTrace,
  invokeRendererQuery,
} from "@/lib/renderer-command";

type IpcArgs<Channel extends keyof IpcApi> = IpcApi[Channel]["args"] extends readonly unknown[]
  ? IpcApi[Channel]["args"]
  : never;

const clearBrowserDataCommand = defineRendererCommand({
  key: "browser_profile.clear_data",
  channel: "browser-browsing-data-clear",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const runBrowserDownloadActionCommand = defineRendererCommand({
  key: "browser_profile.run_download_action",
  channel: "browser-download-action",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const clearBrowserDownloadHistoryCommand = defineRendererCommand({
  key: "browser_profile.clear_download_history",
  channel: "browser-download-history-clear",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const updateBrowserUseModesCommand = defineRendererCommand({
  key: "browser_use.update_policy",
  channel: "browser-use-policy-update-modes",
  authority: "main",
  owner: "BrowserUsePolicyOwner",
  protocol: { kind: "returned_value" },
});

const updateBrowserUseOriginRuleCommand = defineRendererCommand({
  key: "browser_use.update_policy",
  channel: "browser-use-policy-update-origin-rule",
  authority: "main",
  owner: "BrowserUsePolicyOwner",
  protocol: { kind: "returned_value" },
});

type BrowserUsePolicyCommand =
  | { readonly kind: "modes"; readonly input: BrowserUsePolicyModesUpdate }
  | { readonly kind: "origin_rule"; readonly input: BrowserUseOriginRuleUpdate };

type BrowserUsePolicyOriginListKey =
  | "allowedOrigins"
  | "deniedOrigins"
  | "allowedDownloadOrigins"
  | "deniedDownloadOrigins"
  | "allowedUploadOrigins"
  | "deniedUploadOrigins"
  | "allowedFullCdpOrigins"
  | "deniedFullCdpOrigins";

const browserUsePolicyRuleKeys: Record<
  BrowserUsePolicyResource,
  {
    readonly allowed: BrowserUsePolicyOriginListKey;
    readonly denied: BrowserUsePolicyOriginListKey;
  }
> = {
  origin: { allowed: "allowedOrigins", denied: "deniedOrigins" },
  download: { allowed: "allowedDownloadOrigins", denied: "deniedDownloadOrigins" },
  upload: { allowed: "allowedUploadOrigins", denied: "deniedUploadOrigins" },
  fullCdp: { allowed: "allowedFullCdpOrigins", denied: "deniedFullCdpOrigins" },
};

const browserUsePolicyOriginListKeys = [
  "allowedOrigins",
  "deniedOrigins",
  "allowedDownloadOrigins",
  "deniedDownloadOrigins",
  "allowedUploadOrigins",
  "deniedUploadOrigins",
  "allowedFullCdpOrigins",
  "deniedFullCdpOrigins",
] as const satisfies readonly BrowserUsePolicyOriginListKey[];

const equalBrowserUsePolicy = (
  left: BrowserUsePolicySnapshot,
  right: BrowserUsePolicySnapshot,
): boolean =>
  left.fullCdpAccessEnabled === right.fullCdpAccessEnabled &&
  left.approvalMode === right.approvalMode &&
  left.historyApprovalMode === right.historyApprovalMode &&
  left.downloadApprovalMode === right.downloadApprovalMode &&
  left.uploadApprovalMode === right.uploadApprovalMode &&
  browserUsePolicyOriginListKeys.every(
    (key) =>
      left[key].length === right[key].length &&
      left[key].every((origin, index) => origin === right[key][index]),
  );

const projectBrowserUsePolicy = (
  current: BrowserUsePolicySnapshot,
  command: BrowserUsePolicyCommand,
): BrowserUsePolicySnapshot => {
  if (command.kind === "modes") return { ...current, ...command.input };

  const origin = normalizeBrowserUsePolicyOrigin(command.input.origin);
  const keys = browserUsePolicyRuleKeys[command.input.resource];
  const selectedKey = keys[command.input.kind];
  const oppositeKey = command.input.kind === "allowed" ? keys.denied : keys.allowed;
  const selected = current[selectedKey];
  const nextSelected =
    command.input.action === "remove"
      ? selected.filter((entry) => entry !== origin)
      : selected.includes(origin)
        ? selected
        : [...selected, origin].slice(0, MAX_BROWSER_USE_POLICY_ORIGINS);
  if (command.input.action === "remove") return { ...current, [selectedKey]: nextSelected };
  return {
    ...current,
    [selectedKey]: nextSelected,
    [oppositeKey]: current[oppositeKey].filter((entry) => entry !== origin),
  };
};

export interface BrowserUsePolicyOwner extends LatestReturnedValueOwner<
  BrowserUsePolicySnapshot,
  BrowserUsePolicyCommand
> {
  readonly updateModes: (input: BrowserUsePolicyModesUpdate) => Promise<BrowserUsePolicySnapshot>;
  readonly updateOriginRule: (
    input: BrowserUseOriginRuleUpdate,
  ) => Promise<BrowserUsePolicySnapshot>;
}

export type BrowserUsePolicyPort = LatestReturnedValuePort<
  BrowserUsePolicySnapshot,
  BrowserUsePolicyCommand
>;

const removeBrowserCredentialCommand = defineRendererCommand({
  key: "browser_profile.remove_credential",
  channel: "browser-credential-remove",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const actOnBrowserCredentialCandidateCommand = defineRendererCommand({
  key: "browser_profile.act_on_credential_candidate",
  channel: "browser-credential-candidate-action",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const saveBrowserContactInfoCommand = defineRendererCommand({
  key: "browser_profile.save_contact_info",
  channel: "browser-contact-info-upsert",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const removeBrowserContactInfoCommand = defineRendererCommand({
  key: "browser_profile.remove_contact_info",
  channel: "browser-contact-info-remove",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const fillBrowserCredentialCommand = defineRendererCommand({
  key: "browser_profile.fill_credential",
  channel: "browser-credential-fill",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const generateAndFillBrowserCredentialCommand = defineRendererCommand({
  key: "browser_profile.generate_and_fill_credential",
  channel: "browser-credential-generate-fill",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const fillBrowserContactInfoCommand = defineRendererCommand({
  key: "browser_profile.fill_contact_info",
  channel: "browser-contact-info-fill",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const removeBrowserHistoryEntryCommand = defineRendererCommand({
  key: "browser_profile.remove_history_entry",
  channel: "browser-history-delete",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const loadBrowserExtensionCommand = defineRendererCommand({
  key: "browser_profile.load_extension",
  channel: "browser-extension-load",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const removeBrowserExtensionCommand = defineRendererCommand({
  key: "browser_profile.remove_extension",
  channel: "browser-extension-remove",
  authority: "main",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

const importBrowserProfileCommand = defineRendererCommand({
  key: "browser_profile.import",
  channel: "browser-profile-import",
  authority: "external",
  owner: "BrowserProfileRuntime",
  protocol: { kind: "returned_value" },
});

export const readBrowserProfileCapabilities = () =>
  invokeRendererQuery("browser-profile-capabilities");
export const readImportableBrowserProfiles = () =>
  invokeRendererQuery("browser-profile-import-profiles");
export const readBrowserDownloads = () => invokeRendererQuery("browser-downloads-list");
export const readAllBrowserCredentials = () => invokeRendererQuery("browser-credentials-list-all");
export const readBrowserContactInfo = () => invokeRendererQuery("browser-contact-info-list");
export const readBrowserExtensions = () => invokeRendererQuery("browser-extensions-list");

export const readBrowserHistory = (...args: IpcArgs<"browser-history-list">) =>
  invokeRendererQuery("browser-history-list", ...args);
export const readBrowserSiteInfo = (...args: IpcArgs<"browser-site-info">) =>
  invokeRendererQuery("browser-site-info", ...args);
export const readBrowserCredentials = (...args: IpcArgs<"browser-credentials-list">) =>
  invokeRendererQuery("browser-credentials-list", ...args);
export const captureBrowserAnnotationEvidence = (
  ...args: IpcArgs<"browser-annotation-capture-evidence">
) => invokeRendererQuery("browser-annotation-capture-evidence", ...args);

const electronBrowserUsePolicyPort: BrowserUsePolicyPort = {
  read: () => invokeRendererQuery("browser-use-policy-get"),
  update: (command, trace) => {
    if (command.kind === "modes") {
      return invokePlainCommandWithTrace(updateBrowserUseModesCommand, trace, command.input);
    }
    return invokePlainCommandWithTrace(updateBrowserUseOriginRuleCommand, trace, command.input);
  },
};

/** One latest-wins policy lane spans mode and origin-rule edits. */
export const createBrowserUsePolicyOwner = ({
  initialValue = DEFAULT_BROWSER_USE_POLICY,
  operationId = () => createBoundedOperationId("renderer.browser-use-policy.update"),
  port = electronBrowserUsePolicyPort,
  trace,
}: {
  readonly initialValue?: BrowserUsePolicySnapshot;
  readonly operationId?: () => string;
  readonly port?: BrowserUsePolicyPort;
  readonly trace?: RendererCausalTrace;
} = {}): BrowserUsePolicyOwner => {
  let transportTail: Promise<void> | null = null;
  const orderedPort: BrowserUsePolicyPort = {
    read: port.read,
    update: (command, trace) => {
      const result = transportTail
        ? transportTail.then(() => port.update(command, trace))
        : port.update(command, trace);
      const nextTail = result.then(
        () => undefined,
        () => undefined,
      );
      transportTail = nextTail;
      void nextTail.then(() => {
        if (transportTail === nextTail) transportTail = null;
      });
      return result;
    },
  };
  const owner = createLatestReturnedValueOwner({
    initialValue,
    equals: equalBrowserUsePolicy,
    operationId,
    port: orderedPort,
    project: projectBrowserUsePolicy,
    semanticKey: updateBrowserUseModesCommand.key,
    owner: updateBrowserUseModesCommand.owner,
    scopeKind: "application",
    trace,
  });
  return {
    ...owner,
    updateModes: (input) => owner.update({ kind: "modes", input }),
    updateOriginRule: (input) => owner.update({ kind: "origin_rule", input }),
  };
};

export const clearBrowserData = (...args: IpcArgs<"browser-browsing-data-clear">) =>
  invokePlainCommand(clearBrowserDataCommand, ...args);
export const runBrowserDownloadAction = (...args: IpcArgs<"browser-download-action">) =>
  invokePlainCommand(runBrowserDownloadActionCommand, ...args);
export const clearBrowserDownloadHistory = () =>
  invokePlainCommand(clearBrowserDownloadHistoryCommand);
export const removeBrowserCredential = (...args: IpcArgs<"browser-credential-remove">) =>
  invokePlainCommand(removeBrowserCredentialCommand, ...args);
export const actOnBrowserCredentialCandidate = (
  ...args: IpcArgs<"browser-credential-candidate-action">
) => invokePlainCommand(actOnBrowserCredentialCandidateCommand, ...args);
export const saveBrowserContactInfo = (...args: IpcArgs<"browser-contact-info-upsert">) =>
  invokePlainCommand(saveBrowserContactInfoCommand, ...args);
export const removeBrowserContactInfo = (...args: IpcArgs<"browser-contact-info-remove">) =>
  invokePlainCommand(removeBrowserContactInfoCommand, ...args);
export const fillBrowserCredential = (...args: IpcArgs<"browser-credential-fill">) =>
  invokePlainCommand(fillBrowserCredentialCommand, ...args);
export const generateAndFillBrowserCredential = (
  ...args: IpcArgs<"browser-credential-generate-fill">
) => invokePlainCommand(generateAndFillBrowserCredentialCommand, ...args);
export const fillBrowserContactInfo = (...args: IpcArgs<"browser-contact-info-fill">) =>
  invokePlainCommand(fillBrowserContactInfoCommand, ...args);
export const removeBrowserHistoryEntry = (...args: IpcArgs<"browser-history-delete">) =>
  invokePlainCommand(removeBrowserHistoryEntryCommand, ...args);
export const loadBrowserExtension = () => invokePlainCommand(loadBrowserExtensionCommand);
export const removeBrowserExtension = (...args: IpcArgs<"browser-extension-remove">) =>
  invokePlainCommand(removeBrowserExtensionCommand, ...args);
export const importBrowserProfile = (...args: IpcArgs<"browser-profile-import">) =>
  invokePlainCommand(importBrowserProfileCommand, ...args);

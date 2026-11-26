import { cn } from "@/lib/utils";
import {
  defineMessage,
  getIntl,
  useIntl,
  type MessageDescriptor,
  type IntlShape,
} from "@/lib/i18n";
import { readSettingsHostPresentation } from "@/lib/settings-host-presentation";
import {
  AppComponentRequirement,
  useAppComponentRequirementDescription,
} from "@/features/app-components/app-component-requirement";
import { DeleteIcon, DownloadIcon, RefreshIcon, SearchIcon } from "@/components/shared/icons";
import { LinkDestinationSettingRows } from "@/components/workbench/link-opening-settings-controls";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Puzzle } from "@/components/shared/icons/generic-icons";
import { Input, NODEX_SETTINGS_FIELD_CHROME_CLASS_NAME } from "@/components/ui/input";
import { ToolbarBreadcrumb } from "@/components/ui/toolbar-breadcrumb";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import {
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
} from "@/components/ui/settings";
import {
  readChromeControlSettings,
  updateChromeControlSettings,
} from "@/lib/chrome-control-settings";
import {
  isChromeControlRuntimeSnapshot,
  type ChromeControlRuntimeSnapshot,
  type ChromeControlSettingsAction,
} from "../../../shared/chrome-control-settings";
import type {
  BrowserDownloadAction,
  BrowserDownloadRecord,
  BrowserDownloadsSnapshot,
} from "../../../shared/browser-download";
import type {
  BrowserCapabilityStatus,
  BrowserContactInfo,
  BrowserContactInfoUpsertInput,
  BrowserCredentialSummary,
  BrowserExtensionsSnapshot,
  BrowserHistoryRecord,
  BrowserProfileCapabilities,
} from "../../../shared/browser-profile";
import {
  type BrowserUseApprovalMode,
  type BrowserUseOriginRuleUpdate,
  type BrowserUsePolicyResource,
  type BrowserUsePolicySnapshot,
} from "../../../shared/browser-use-policy";
import { BrowserProfileImportDialog } from "./browser-profile-import-dialog";
import type {
  BrowserSettingsAnchor,
  BrowserSettingsDestination,
  BrowserSettingsDetail,
} from "@/components/workbench/workbench-settings-routes";
import {
  clearBrowserData,
  clearBrowserDownloadHistory,
  createBrowserUsePolicyOwner,
  loadBrowserExtension,
  readAllBrowserCredentials,
  readBrowserContactInfo,
  readBrowserDownloads,
  readBrowserExtensions,
  readBrowserHistory,
  readBrowserProfileCapabilities,
  removeBrowserContactInfo,
  removeBrowserCredential,
  removeBrowserExtension,
  removeBrowserHistoryEntry,
  runBrowserDownloadAction,
  saveBrowserContactInfo,
} from "./browser-profile-runtime";

export type { BrowserSettingsDestination } from "@/components/workbench/workbench-settings-routes";

const EMPTY_CAPABILITY: BrowserCapabilityStatus = {
  available: false,
  provider: "unavailable",
};
const CHECKING_AVAILABILITY = defineMessage({
  id: "browser.browserSettingsPages.checkingAvailability",
  defaultMessage: "Checking availability…",
});
const EMPTY_CAPABILITIES: BrowserProfileCapabilities = {
  contactInfo: EMPTY_CAPABILITY,
  credentialVault: EMPTY_CAPABILITY,
  extensions: EMPTY_CAPABILITY,
  history: EMPTY_CAPABILITY,
  profileImport: EMPTY_CAPABILITY,
  siteInfo: EMPTY_CAPABILITY,
};

const BROWSER_USE_RESOURCE_OPTIONS = [
  {
    value: "origin",
    label: defineMessage({
      id: "browser.browserSettingsPages.websiteOption",
      defaultMessage: "Website",
    }),
  },
  {
    value: "download",
    label: defineMessage({
      id: "browser.browserSettingsPages.downloadOption",
      defaultMessage: "Download",
    }),
  },
  {
    value: "upload",
    label: defineMessage({
      id: "browser.browserSettingsPages.uploadOption",
      defaultMessage: "Upload",
    }),
  },
  {
    value: "fullCdp",
    label: defineMessage({
      id: "browser.browserSettingsPages.fullCdpOption",
      defaultMessage: "Full CDP",
    }),
  },
] as const;

const BROWSER_USE_DECISION_OPTIONS = [
  {
    value: "allowed",
    label: defineMessage({
      id: "browser.browserSettingsPages.allowOption",
      defaultMessage: "Allow",
    }),
  },
  {
    value: "denied",
    label: defineMessage({ id: "browser.browserSettingsPages.denyOption", defaultMessage: "Deny" }),
  },
] as const;

const BROWSER_USE_APPROVAL_OPTIONS = [
  {
    value: "alwaysAsk",
    label: defineMessage({
      id: "browser.browserSettingsPages.alwaysAskOption",
      defaultMessage: "Always ask",
    }),
  },
  {
    value: "neverAsk",
    label: defineMessage({
      id: "browser.browserSettingsPages.neverAskOption",
      defaultMessage: "Never ask",
    }),
  },
] as const;

export function BrowserSettingsPage({
  browserAnchor,
  browserDetail,
  onOpenBrowserDetail,
  open,
}: {
  browserAnchor: BrowserSettingsAnchor | null;
  browserDetail: BrowserSettingsDetail | null;
  onOpenBrowserDetail: (
    destination: BrowserSettingsDestination,
    anchor?: BrowserSettingsAnchor,
  ) => void;
  open: boolean;
}) {
  if (browserDetail) {
    return (
      <BrowserSettingsDetailPage
        detail={browserDetail}
        onBack={() =>
          onOpenBrowserDetail("browser", browserAnchor ?? BROWSER_DETAIL_ANCHORS[browserDetail])
        }
        open={open}
      />
    );
  }

  return (
    <BrowserSettingsOverview
      anchor={browserAnchor}
      onOpenBrowserDetail={onOpenBrowserDetail}
      open={open}
    />
  );
}

function BrowserSettingsOverview({
  anchor,
  onOpenBrowserDetail,
  open,
}: {
  anchor: BrowserSettingsAnchor | null;
  onOpenBrowserDetail: (
    destination: BrowserSettingsDestination,
    anchor?: BrowserSettingsAnchor,
  ) => void;
  open: boolean;
}) {
  const intl = useIntl();
  const host = readSettingsHostPresentation();
  const [capabilities, setCapabilities] = useState<BrowserProfileCapabilities>(EMPTY_CAPABILITIES);
  const [chromeControl, setChromeControl] = useState<ChromeControlRuntimeSnapshot | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [usePolicyOwner] = useState(createBrowserUsePolicyOwner);
  const usePolicySnapshot = useSyncExternalStore(
    usePolicyOwner.subscribe,
    usePolicyOwner.getSnapshot,
    usePolicyOwner.getSnapshot,
  );
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    void Promise.all([
      readBrowserProfileCapabilities(),
      usePolicyOwner.readCanonical(),
      host.browserControl ? readChromeControlSettings().catch(() => null) : null,
    ]).then(([nextCapabilities, _policy, nextChromeControl]) => {
      setCapabilities(nextCapabilities);
      setChromeControl(nextChromeControl);
    });
  }, [host.browserControl, open, usePolicyOwner]);

  useEffect(() => {
    if (!open || !host.browserControl) return;
    return window.api?.on("chrome-control-settings-changed", (snapshot) => {
      if (isChromeControlRuntimeSnapshot(snapshot)) setChromeControl(snapshot);
    });
  }, [host.browserControl, open]);

  useLayoutEffect(() => {
    if (usePolicySnapshot.renderToken === null) return;
    usePolicyOwner.markRendered(usePolicySnapshot.renderToken);
  }, [usePolicyOwner, usePolicySnapshot.renderToken]);

  useEffect(() => {
    if (!open || !anchor) return;
    document.getElementById(anchor)?.scrollIntoView({ block: "start" });
  }, [anchor, open]);

  const clearData = async (kind: "cache" | "cookies" | "downloads" | "history" | "site-data") => {
    const result = await clearBrowserData(kind);
    setStatus(
      result.ok
        ? intl.formatMessage({
            id: "browser.browserSettingsPages.dataCleared",
            defaultMessage: "Built-in Browser Profile data cleared.",
          })
        : result.message,
    );
  };

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage({
        id: "browser.browserSettingsPages.browser",
        defaultMessage: "Browser",
      })}
      subtitle={intl.formatMessage({
        id: "browser.browserSettingsPages.description",
        defaultMessage: "Manage the built-in Browser and its shared Profile.",
      })}
    >
      <BrowserOverviewSection
        anchor="general"
        title={intl.formatMessage({
          id: "browser.browserSettingsPages.general",
          defaultMessage: "General",
        })}
      >
        <LinkDestinationSettingRows />
        {host.browserProfileImport ? (
          <>
            <CapabilityRow
              label={intl.formatMessage({
                id: "browser.browserSettingsPages.profileImport",
                defaultMessage: "Profile import",
              })}
              capability={capabilities.profileImport}
            />
            <NodexSettingsRow
              label={intl.formatMessage({
                id: "browser.browserSettingsPages.importData",
                defaultMessage: "Import browser data",
              })}
              description={intl.formatMessage({
                id: "browser.browserSettingsPages.importDataDescription",
                defaultMessage:
                  "Import cookies and saved passwords from a local Chrome or ChatGPT Atlas Profile.",
              })}
            >
              <NodexButton
                size="toolbar"
                variant="secondary"
                disabled={!capabilities.profileImport.available}
                onClick={() => setImportOpen(true)}
              >
                <DownloadIcon />
                {intl.formatMessage({
                  id: "browser.browserSettingsPages.import",
                  defaultMessage: "Import",
                })}
              </NodexButton>
            </NodexSettingsRow>
          </>
        ) : null}
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.cookies",
            defaultMessage: "Cookies",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.cookiesDescription",
            defaultMessage: "Signs out sites across every built-in Browser window.",
          })}
        >
          <NodexButton size="toolbar" variant="secondary" onClick={() => void clearData("cookies")}>
            {intl.formatMessage({
              id: "browser.browserSettingsPages.clear",
              defaultMessage: "Clear",
            })}
          </NodexButton>
        </NodexSettingsRow>
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.siteData",
            defaultMessage: "Site data",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.siteDataDescription",
            defaultMessage:
              "Clears local storage, IndexedDB, service workers, and site files from the shared Profile.",
          })}
        >
          <NodexButton
            size="toolbar"
            variant="secondary"
            onClick={() => void clearData("site-data")}
          >
            {intl.formatMessage({
              id: "browser.browserSettingsPages.clear",
              defaultMessage: "Clear",
            })}
          </NodexButton>
        </NodexSettingsRow>
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.cache",
            defaultMessage: "Cache",
          })}
        >
          <NodexButton size="toolbar" variant="secondary" onClick={() => void clearData("cache")}>
            {intl.formatMessage({
              id: "browser.browserSettingsPages.clear",
              defaultMessage: "Clear",
            })}
          </NodexButton>
        </NodexSettingsRow>
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.history",
            defaultMessage: "Browsing history",
          })}
          description={
            capabilities.history.available
              ? intl.formatMessage({
                  id: "browser.browserSettingsPages.historyDescription",
                  defaultMessage: "Review and remove visits from the shared Browser Profile.",
                })
              : ((capabilities.history === EMPTY_CAPABILITY
                  ? intl.formatMessage(CHECKING_AVAILABILITY)
                  : capabilities.history.reason) ??
                intl.formatMessage({
                  id: "browser.browserSettingsPages.historyUnavailable",
                  defaultMessage: "Browsing history is unavailable.",
                }))
          }
        >
          <NodexButton
            size="toolbar"
            variant="secondary"
            aria-label={intl.formatMessage({
              id: "browser.browserSettingsPages.manageHistory",
              defaultMessage: "Manage Browsing history",
            })}
            disabled={!capabilities.history.available}
            onClick={() => onOpenBrowserDetail("history", "general")}
          >
            {intl.formatMessage({
              id: "browser.browserSettingsPages.manage",
              defaultMessage: "Manage",
            })}
          </NodexButton>
          <NodexButton size="toolbar" variant="ghost" onClick={() => void clearData("history")}>
            {intl.formatMessage({
              id: "browser.browserSettingsPages.clear",
              defaultMessage: "Clear",
            })}
          </NodexButton>
        </NodexSettingsRow>
      </BrowserOverviewSection>
      <BrowserOverviewSection
        anchor="autofill-and-passwords"
        title={intl.formatMessage({
          id: "browser.browserSettingsPages.autofill",
          defaultMessage: "Autofill and passwords",
        })}
      >
        <CapabilityRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.credentials",
            defaultMessage: "Credential storage",
          })}
          capability={capabilities.credentialVault}
        />
        <CapabilityRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.contacts",
            defaultMessage: "Contact info",
          })}
          capability={capabilities.contactInfo}
        />
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.passwordManager",
            defaultMessage: "Password manager",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.passwordManagerDescription",
            defaultMessage: "Review saved passwords without revealing their secret values.",
          })}
        >
          <NodexButton
            size="toolbar"
            variant="secondary"
            aria-label={intl.formatMessage({
              id: "browser.browserSettingsPages.managePasswords",
              defaultMessage: "Manage Password manager",
            })}
            disabled={!capabilities.credentialVault.available}
            onClick={() => onOpenBrowserDetail("passwords", "autofill-and-passwords")}
          >
            {intl.formatMessage({
              id: "browser.browserSettingsPages.manage",
              defaultMessage: "Manage",
            })}
          </NodexButton>
        </NodexSettingsRow>
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.contacts",
            defaultMessage: "Contact info",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.contactsDescription",
            defaultMessage: "Manage saved autofill contact information.",
          })}
        >
          <NodexButton
            size="toolbar"
            variant="secondary"
            aria-label={intl.formatMessage({
              id: "browser.browserSettingsPages.manageContacts",
              defaultMessage: "Manage Contact info",
            })}
            disabled={!capabilities.contactInfo.available}
            onClick={() => onOpenBrowserDetail("contact-info", "autofill-and-passwords")}
          >
            {intl.formatMessage({
              id: "browser.browserSettingsPages.manage",
              defaultMessage: "Manage",
            })}
          </NodexButton>
        </NodexSettingsRow>
      </BrowserOverviewSection>
      <BrowserOverviewSection
        anchor="extensions"
        title={intl.formatMessage({
          id: "browser.browserSettingsPages.extensions",
          defaultMessage: "Extensions",
        })}
      >
        <CapabilityRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.extensionManager",
            defaultMessage: "Extension manager",
          })}
          capability={capabilities.extensions}
        />
        {host.browserControl ? (
          <ChromeControlReadiness snapshot={chromeControl} onUpdate={setChromeControl} />
        ) : null}
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.manageExtensions",
            defaultMessage: "Manage extensions",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.extensionsDescription",
            defaultMessage: "Load and remove unpacked extensions from the shared Browser Profile.",
          })}
        >
          <NodexButton
            size="toolbar"
            variant="secondary"
            aria-label={intl.formatMessage({
              id: "browser.browserSettingsPages.manageExtensions",
              defaultMessage: "Manage extensions",
            })}
            disabled={!capabilities.extensions.available}
            onClick={() => onOpenBrowserDetail("extensions", "extensions")}
          >
            {intl.formatMessage({
              id: "browser.browserSettingsPages.manage",
              defaultMessage: "Manage",
            })}
          </NodexButton>
        </NodexSettingsRow>
      </BrowserOverviewSection>
      <BrowserOverviewSection
        anchor="downloads"
        title={intl.formatMessage({
          id: "browser.browserSettingsPages.downloads",
          defaultMessage: "Downloads",
        })}
      >
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.downloadHistory",
            defaultMessage: "Download history",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.downloadsDescription",
            defaultMessage: "Review active and completed downloads from the built-in Browser.",
          })}
        >
          <NodexButton
            size="toolbar"
            variant="secondary"
            aria-label={intl.formatMessage({
              id: "browser.browserSettingsPages.manageDownloads",
              defaultMessage: "Manage Download history",
            })}
            onClick={() => onOpenBrowserDetail("downloads", "downloads")}
          >
            {intl.formatMessage({
              id: "browser.browserSettingsPages.manage",
              defaultMessage: "Manage",
            })}
          </NodexButton>
          <NodexButton size="toolbar" variant="ghost" onClick={() => void clearData("downloads")}>
            {intl.formatMessage({
              id: "browser.browserSettingsPages.clear",
              defaultMessage: "Clear",
            })}
          </NodexButton>
        </NodexSettingsRow>
      </BrowserOverviewSection>
      <BrowserUsePolicySettings
        policy={usePolicySnapshot.value}
        siteInfo={capabilities.siteInfo}
        onUpdateModes={usePolicyOwner.updateModes}
        onUpdateOriginRule={usePolicyOwner.updateOriginRule}
        onStatus={setStatus}
      />
      {status ? <SettingsStatus>{status}</SettingsStatus> : null}
      {host.browserProfileImport ? (
        <BrowserProfileImportDialog open={importOpen} onOpenChange={setImportOpen} />
      ) : null}
    </NodexSettingsPageSurface>
  );
}

const CHROME_CONTROL_STATUS_LABELS: Record<
  ChromeControlRuntimeSnapshot["status"],
  MessageDescriptor
> = {
  disabled: defineMessage({ id: "browser.browserSettingsPages.chromeOff", defaultMessage: "Off" }),
  "extension-disconnected": defineMessage({
    id: "browser.browserSettingsPages.chromeWaiting",
    defaultMessage: "Waiting for extension",
  }),
  faulted: defineMessage({
    id: "browser.browserSettingsPages.chromeNeedsRepair",
    defaultMessage: "Needs repair",
  }),
  ready: defineMessage({ id: "browser.browserSettingsPages.chromeReady", defaultMessage: "Ready" }),
  "registration-disabled": defineMessage({
    id: "browser.browserSettingsPages.chromeUnregistered",
    defaultMessage: "Not registered (development instance)",
  }),
  "registration-in-use": defineMessage({
    id: "browser.browserSettingsPages.chromeRegisteredElsewhere",
    defaultMessage: "Registered elsewhere",
  }),
  "runtime-unavailable": defineMessage({
    id: "browser.browserSettingsPages.chromeUnavailable",
    defaultMessage: "Unavailable",
  }),
};

function ChromeControlReadiness({
  snapshot,
  onUpdate,
}: {
  readonly snapshot: ChromeControlRuntimeSnapshot | null;
  readonly onUpdate: (snapshot: ChromeControlRuntimeSnapshot) => void;
}) {
  const intl = useIntl();
  const ready = snapshot?.providerReady === true;
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const windows = snapshot?.windows;
  const state = snapshot?.status;
  const needsDesktopTools = snapshot?.browserRuntimeUnavailableReason === "not-installed";
  const desktopToolsDescription = useAppComponentRequirementDescription("desktop-tools");
  const label =
    windows?.owner === "app"
      ? intl.formatMessage({
          id: "browser.browserSettingsPages.chromeUsedByApp",
          defaultMessage: "In use by another app",
        })
      : windows?.owner === "profile"
        ? intl.formatMessage({
            id: "browser.browserSettingsPages.chromeUsedByProfile",
            defaultMessage: "In use by another Nodex Profile",
          })
        : snapshot
          ? intl.formatMessage(CHROME_CONTROL_STATUS_LABELS[snapshot.status])
          : intl.formatMessage({
              id: "browser.browserSettingsPages.chromeCheckingStatus",
              defaultMessage: "Checking…",
            });
  const description =
    (failed
      ? intl.formatMessage({
          id: "browser.browserSettingsPages.chromeUpdateFailed",
          defaultMessage: "Couldn’t update browser control. Try again.",
        })
      : null) ??
    (windows?.manifestPaths.length
      ? windows.manifestPaths.map((path) => (
          <span key={path} className="block break-all select-text">
            {path}
          </span>
        ))
      : null) ??
    (windows && state === "extension-disconnected"
      ? intl.formatMessage({
          id: "browser.browserSettingsPages.chromeOpenBrowser",
          defaultMessage: "Open Chrome or Edge with the ChatGPT extension.",
        })
      : null) ??
    (windows && state === "disabled"
      ? intl.formatMessage({
          id: "browser.browserSettingsPages.chromeConnectExtension",
          defaultMessage: "Turn on to connect the ChatGPT extension.",
        })
      : null) ??
    (state === "registration-disabled"
      ? intl.formatMessage(
          {
            id: "browser.browserSettingsPages.chromeRegisterDevelopment",
            defaultMessage: "To register with your browsers, launch with {command}.",
          },
          { command: "vp run dev --register-browser-host" },
        )
      : null) ??
    (needsDesktopTools ? desktopToolsDescription : null) ??
    snapshot?.reason ??
    (ready
      ? intl.formatMessage({
          id: "browser.browserSettingsPages.chromeDescription",
          defaultMessage: "Nodex can control tabs in a connected supported browser profile.",
        })
      : intl.formatMessage({
          id: "browser.browserSettingsPages.chromeChecking",
          defaultMessage: "Checking the signed browser-control runtime and extension connection.",
        }));

  const update = async (action: ChromeControlSettingsAction) => {
    setPending(true);
    setFailed(false);
    try {
      onUpdate(await updateChromeControlSettings(action));
    } catch {
      setFailed(true);
    }
    setPending(false);
  };
  const token = windows?.takeoverToken;
  const canTurnOff = windows && snapshot?.requested;

  return (
    <NodexSettingsRow
      label={intl.formatMessage({
        id: "browser.browserSettingsPages.chromeControl",
        defaultMessage: "Control existing browsers",
      })}
      description={description}
    >
      {needsDesktopTools ? (
        <AppComponentRequirement
          id="desktop-tools"
          onInstalled={() => void readChromeControlSettings().then(onUpdate, () => undefined)}
        />
      ) : (
        <span className="inline-flex items-center gap-2 text-sm text-token-text-secondary">
          <span
            aria-hidden="true"
            className={
              ready
                ? "size-2 rounded-full bg-(--color-background-success-indicator)"
                : "size-2 rounded-full bg-token-text-tertiary"
            }
          />
          {label}
        </span>
      )}
      {token ? (
        <NodexButton
          size="toolbar"
          variant="secondary"
          disabled={pending}
          onClick={() => void update({ kind: "takeover", token })}
        >
          {intl.formatMessage({
            id: "browser.browserSettingsPages.chromeUse",
            defaultMessage: "Use with Nodex",
          })}
        </NodexButton>
      ) : null}
      {windows && state === "disabled" ? (
        <NodexButton
          size="toolbar"
          variant="secondary"
          disabled={pending}
          onClick={() => void update({ kind: "enable" })}
        >
          {intl.formatMessage({
            id: "browser.browserSettingsPages.chromeTurnOn",
            defaultMessage: "Turn on",
          })}
        </NodexButton>
      ) : null}
      {windows && state === "faulted" ? (
        <NodexButton
          size="toolbar"
          variant="secondary"
          disabled={pending}
          onClick={() => void update({ kind: "repair" })}
        >
          {intl.formatMessage({
            id: "browser.browserSettingsPages.chromeRepair",
            defaultMessage: "Repair",
          })}
        </NodexButton>
      ) : null}
      {canTurnOff ? (
        <NodexButton
          size="toolbar"
          variant="secondary"
          disabled={pending}
          onClick={() => void update({ kind: "disable" })}
        >
          {windows.canGiveBack
            ? intl.formatMessage({
                id: "browser.browserSettingsPages.chromeGiveBack",
                defaultMessage: "Give back",
              })
            : intl.formatMessage({
                id: "browser.browserSettingsPages.chromeTurnOff",
                defaultMessage: "Turn off",
              })}
        </NodexButton>
      ) : null}
    </NodexSettingsRow>
  );
}

function BrowserOverviewSection({
  anchor,
  children,
  title,
}: {
  anchor: BrowserSettingsAnchor;
  children: ReactNode;
  title: string;
}) {
  return (
    <NodexSettingsSection id={anchor} title={title}>
      {children}
    </NodexSettingsSection>
  );
}

const BROWSER_DETAIL_LABELS: Record<BrowserSettingsDetail, MessageDescriptor> = {
  passwords: defineMessage({
    id: "browser.browserSettingsPages.passwordsDetail",
    defaultMessage: "Password manager",
  }),
  "contact-info": defineMessage({
    id: "browser.browserSettingsPages.contactsDetail",
    defaultMessage: "Contact info",
  }),
  history: defineMessage({
    id: "browser.browserSettingsPages.historyDetail",
    defaultMessage: "Browsing history",
  }),
  extensions: defineMessage({
    id: "browser.browserSettingsPages.extensionsDetail",
    defaultMessage: "Extension manager",
  }),
  downloads: defineMessage({
    id: "browser.browserSettingsPages.downloadsDetail",
    defaultMessage: "Download history",
  }),
};

const BROWSER_DETAIL_ANCHORS: Record<BrowserSettingsDetail, BrowserSettingsAnchor> = {
  passwords: "autofill-and-passwords",
  "contact-info": "autofill-and-passwords",
  history: "general",
  extensions: "extensions",
  downloads: "downloads",
};

function BrowserSettingsDetailPage({
  detail,
  onBack,
  open,
}: {
  detail: BrowserSettingsDetail;
  onBack: () => void;
  open: boolean;
}) {
  const intl = useIntl();
  const backSlot = (
    <ToolbarBreadcrumb
      variant="settings"
      ancestors={[
        {
          id: "browser",
          label: intl.formatMessage({
            id: "browser.browserSettingsPages.browser",
            defaultMessage: "Browser",
          }),
          onSelect: onBack,
        },
      ]}
      current={intl.formatMessage(BROWSER_DETAIL_LABELS[detail])}
    />
  );

  if (detail === "passwords") {
    return <BrowserPasswordsSettingsPage backSlot={backSlot} open={open} />;
  }
  if (detail === "contact-info") {
    return <BrowserContactInfoSettingsPage backSlot={backSlot} open={open} />;
  }
  if (detail === "history") {
    return <BrowserHistorySettingsPage backSlot={backSlot} open={open} />;
  }
  if (detail === "extensions") {
    return <BrowserExtensionsSettingsPage backSlot={backSlot} open={open} />;
  }
  return <BrowserDownloadsSettingsPage backSlot={backSlot} open={open} />;
}

function BrowserDownloadsSettingsPage({ backSlot, open }: { backSlot: ReactNode; open: boolean }) {
  const intl = useIntl();
  const [snapshot, setSnapshot] = useState<BrowserDownloadsSnapshot>({ downloads: [] });
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(() => readBrowserDownloads().then(setSnapshot), []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const runAction = async (downloadId: string, action: BrowserDownloadAction) => {
    const result = await runBrowserDownloadAction({
      downloadId,
      action,
    });
    setStatus(result.ok ? null : result.message);
    if (result.ok) await refresh();
  };

  const clearHistory = async () => {
    const result = await clearBrowserDownloadHistory();
    setStatus(
      result.ok
        ? intl.formatMessage({
            id: "browser.browserSettingsPages.downloadHistoryCleared",
            defaultMessage: "Download history cleared.",
          })
        : result.message,
    );
    if (result.ok) await refresh();
  };

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage({
        id: "browser.browserSettingsPages.downloadHistory",
        defaultMessage: "Download history",
      })}
      subtitle={intl.formatMessage({
        id: "browser.browserSettingsPages.downloadHistoryDescription",
        defaultMessage: "Active and completed downloads from the built-in Browser.",
      })}
      backSlot={backSlot}
      action={
        <NodexButton
          size="toolbar"
          variant="secondary"
          disabled={snapshot.downloads.length === 0}
          onClick={() => void clearHistory()}
        >
          {intl.formatMessage({
            id: "browser.browserSettingsPages.clearHistory",
            defaultMessage: "Clear history",
          })}
        </NodexButton>
      }
    >
      <NodexSettingsSection>
        {snapshot.downloads.length === 0 ? (
          <EmptySettingsRow
            message={intl.formatMessage({
              id: "browser.browserSettingsPages.downloadsEmpty",
              defaultMessage: "Downloaded files will appear here.",
            })}
          />
        ) : (
          snapshot.downloads.map((download) => (
            <BrowserDownloadSettingsRow
              key={download.id}
              download={download}
              onAction={runAction}
            />
          ))
        )}
      </NodexSettingsSection>
      {status ? <SettingsStatus>{status}</SettingsStatus> : null}
    </NodexSettingsPageSurface>
  );
}

function BrowserDownloadSettingsRow({
  download,
  onAction,
}: {
  download: BrowserDownloadRecord;
  onAction: (downloadId: string, action: BrowserDownloadAction) => Promise<void>;
}) {
  const intl = useIntl();
  const active =
    download.status === "starting" ||
    download.status === "progressing" ||
    download.status === "paused";

  return (
    <NodexSettingsRow
      label={download.fileName}
      description={`${download.sourceOrigin} · ${formatDownloadStatus(download, intl)}`}
    >
      {download.status === "completed" ? (
        <>
          <NodexButton
            size="toolbar"
            variant="ghost"
            onClick={() => void onAction(download.id, "open")}
          >
            {intl.formatMessage({
              id: "browser.browserSettingsPages.open",
              defaultMessage: "Open",
            })}
          </NodexButton>
          <NodexButton
            size="toolbar"
            variant="ghost"
            onClick={() => void onAction(download.id, "show-in-folder")}
          >
            {intl.formatMessage({
              id: "browser.browserSettingsPages.showInFolder",
              defaultMessage: "Show in folder",
            })}
          </NodexButton>
        </>
      ) : null}
      {active ? (
        <NodexButton
          size="toolbar"
          variant="ghost"
          onClick={() =>
            void onAction(download.id, download.status === "paused" ? "resume" : "pause")
          }
        >
          {download.status === "paused"
            ? intl.formatMessage({
                id: "browser.browserSettingsPages.resume",
                defaultMessage: "Resume",
              })
            : intl.formatMessage({
                id: "browser.browserSettingsPages.pause",
                defaultMessage: "Pause",
              })}
        </NodexButton>
      ) : null}
      {active ? (
        <NodexButton
          size="toolbar"
          variant="ghost"
          onClick={() => void onAction(download.id, "cancel")}
        >
          {intl.formatMessage({
            id: "browser.browserSettingsPages.cancel",
            defaultMessage: "Cancel",
          })}
        </NodexButton>
      ) : null}
      <NodexButton
        size="toolbar"
        variant="ghost"
        onClick={() => void onAction(download.id, "remove")}
      >
        {intl.formatMessage({
          id: "browser.browserSettingsPages.remove",
          defaultMessage: "Remove",
        })}
      </NodexButton>
    </NodexSettingsRow>
  );
}

function formatDownloadStatus(
  download: BrowserDownloadRecord,
  intl: IntlShape = getIntl(),
): string {
  if (download.status === "completed" && download.completedAt) {
    return intl.formatMessage(
      { id: "browser.browserSettingsPages.downloadCompleted", defaultMessage: "Completed {date}" },
      {
        date: new Intl.DateTimeFormat(intl.locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(download.completedAt)),
      },
    );
  }
  if (download.status === "interrupted" && download.interruptReason) {
    return intl.formatMessage(
      {
        id: "browser.browserSettingsPages.downloadInterrupted",
        defaultMessage: "Interrupted: {reason}",
      },
      { reason: download.interruptReason },
    );
  }
  return intl.formatMessage(
    {
      id: "browser.browserSettingsPages.downloadStatus",
      defaultMessage:
        "{status, select, starting {starting} progressing {progressing} paused {paused} cancelled {cancelled} completed {completed} interrupted {interrupted} other {{status}}}",
    },
    { status: download.status },
  );
}

function BrowserUsePolicySettings({
  policy,
  siteInfo,
  onUpdateModes,
  onUpdateOriginRule,
  onStatus,
}: {
  policy: BrowserUsePolicySnapshot;
  siteInfo: BrowserCapabilityStatus;
  onUpdateModes: (
    input: Partial<
      Pick<
        BrowserUsePolicySnapshot,
        | "approvalMode"
        | "historyApprovalMode"
        | "downloadApprovalMode"
        | "uploadApprovalMode"
        | "fullCdpAccessEnabled"
      >
    >,
  ) => Promise<BrowserUsePolicySnapshot>;
  onUpdateOriginRule: (input: BrowserUseOriginRuleUpdate) => Promise<BrowserUsePolicySnapshot>;
  onStatus: (status: string) => void;
}) {
  const intl = useIntl();
  const [origin, setOrigin] = useState("");
  const [resource, setResource] = useState<BrowserUsePolicyResource>("origin");
  const [kind, setKind] = useState<BrowserUseOriginRuleUpdate["kind"]>("allowed");

  const updateModes = async (
    input: Partial<
      Pick<
        BrowserUsePolicySnapshot,
        | "approvalMode"
        | "historyApprovalMode"
        | "downloadApprovalMode"
        | "uploadApprovalMode"
        | "fullCdpAccessEnabled"
      >
    >,
  ) => {
    try {
      await onUpdateModes(input);
      onStatus(
        intl.formatMessage({
          id: "browser.browserSettingsPages.browserUseUpdated",
          defaultMessage: "Browser Use policy updated.",
        }),
      );
    } catch (error) {
      onStatus(
        readErrorMessage(
          error,
          intl.formatMessage({
            id: "browser.browserSettingsPages.browserUseUpdateFailed",
            defaultMessage: "Unable to update Browser Use policy.",
          }),
        ),
      );
    }
  };
  const updateRule = async (input: BrowserUseOriginRuleUpdate) => {
    try {
      await onUpdateOriginRule(input);
      if (input.action === "add") setOrigin("");
      onStatus(
        intl.formatMessage({
          id: "browser.browserSettingsPages.originPolicyUpdated",
          defaultMessage: "Browser Use origin policy updated.",
        }),
      );
    } catch (error) {
      onStatus(
        readErrorMessage(
          error,
          intl.formatMessage({
            id: "browser.browserSettingsPages.originPolicyUpdateFailed",
            defaultMessage: "Unable to update origin policy.",
          }),
        ),
      );
    }
  };

  return (
    <>
      <NodexSettingsSection
        id="permissions"
        title={intl.formatMessage({
          id: "browser.browserSettingsPages.permissions",
          defaultMessage: "Permissions",
        })}
      >
        <CapabilityRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.siteInfo",
            defaultMessage: "Site information",
          })}
          capability={siteInfo}
        />
        <ApprovalModeRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.websiteAccess",
            defaultMessage: "Website access",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.websiteAccessDescription",
            defaultMessage: "Ask before Browser Use accesses a site without a remembered decision.",
          })}
          value={policy.approvalMode}
          onChange={(approvalMode) => void updateModes({ approvalMode })}
        />
        <ApprovalModeRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.history",
            defaultMessage: "Browsing history",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.historyPermissionDescription",
            defaultMessage: "Control whether Browser Use asks before reading user history.",
          })}
          value={policy.historyApprovalMode}
          onChange={(historyApprovalMode) => void updateModes({ historyApprovalMode })}
        />
        <ApprovalModeRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.downloads",
            defaultMessage: "Downloads",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.downloadsPermissionDescription",
            defaultMessage: "Control approval prompts before an agent downloads a file.",
          })}
          value={policy.downloadApprovalMode}
          onChange={(downloadApprovalMode) => void updateModes({ downloadApprovalMode })}
        />
        <ApprovalModeRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.uploads",
            defaultMessage: "Uploads",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.uploadsPermissionDescription",
            defaultMessage: "Control approval prompts before an agent uploads a file.",
          })}
          value={policy.uploadApprovalMode}
          onChange={(uploadApprovalMode) => void updateModes({ uploadApprovalMode })}
        />
      </NodexSettingsSection>
      <NodexSettingsSection
        id="site-permissions"
        title={intl.formatMessage({
          id: "browser.browserSettingsPages.sitePermissions",
          defaultMessage: "Site permissions",
        })}
      >
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Input
            variant="settings"
            className="h-8 min-w-48 flex-1 px-2 text-sm"
            value={origin}
            placeholder="example.com"
            onChange={(event) => setOrigin(event.target.value)}
          />
          <PolicySelect
            ariaLabel={intl.formatMessage({
              id: "browser.browserSettingsPages.resourceAria",
              defaultMessage: "Browser Use resource",
            })}
            className="min-w-28"
            options={BROWSER_USE_RESOURCE_OPTIONS}
            value={resource}
            onChange={(value) => setResource(value as BrowserUsePolicyResource)}
          />
          <PolicySelect
            ariaLabel={intl.formatMessage({
              id: "browser.browserSettingsPages.originDecisionAria",
              defaultMessage: "Browser Use origin decision",
            })}
            className="min-w-20"
            options={BROWSER_USE_DECISION_OPTIONS}
            value={kind}
            onChange={(value) => setKind(value as BrowserUseOriginRuleUpdate["kind"])}
          />
          <NodexButton
            size="toolbar"
            disabled={!origin.trim()}
            onClick={() =>
              void updateRule({
                action: "add",
                kind,
                origin,
                resource,
              })
            }
          >
            {intl.formatMessage({ id: "browser.browserSettingsPages.add", defaultMessage: "Add" })}
          </NodexButton>
        </div>
        <OriginRuleRows policy={policy} onRemove={updateRule} />
      </NodexSettingsSection>
      <NodexSettingsSection
        id="developer-mode"
        title={intl.formatMessage({
          id: "browser.browserSettingsPages.developerMode",
          defaultMessage: "Developer mode",
        })}
      >
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "browser.browserSettingsPages.fullCdpAccess",
            defaultMessage: "Full CDP access",
          })}
          description={intl.formatMessage({
            id: "browser.browserSettingsPages.fullCdpDescription",
            defaultMessage:
              "Expose raw Chrome DevTools Protocol only when the bundled runtime and enterprise policy also allow it.",
          })}
        >
          <NodexSwitch
            ariaLabel={intl.formatMessage({
              id: "browser.browserSettingsPages.fullCdpAccess",
              defaultMessage: "Full CDP access",
            })}
            checked={policy.fullCdpAccessEnabled}
            onCheckedChange={(fullCdpAccessEnabled) => void updateModes({ fullCdpAccessEnabled })}
          />
        </NodexSettingsRow>
      </NodexSettingsSection>
    </>
  );
}

function ApprovalModeRow({
  description,
  label,
  onChange,
  value,
}: {
  description: string;
  label: string;
  onChange: (mode: BrowserUseApprovalMode) => void;
  value: BrowserUseApprovalMode;
}) {
  const intl = useIntl();
  return (
    <NodexSettingsRow label={label} description={description}>
      <PolicySelect
        ariaLabel={intl.formatMessage(
          {
            id: "browser.browserSettingsPages.approvalMode",
            defaultMessage: "{label} approval mode",
          },
          { label },
        )}
        className="min-w-28"
        options={BROWSER_USE_APPROVAL_OPTIONS}
        value={value}
        onChange={(nextValue) => onChange(nextValue as BrowserUseApprovalMode)}
      />
    </NodexSettingsRow>
  );
}

function PolicySelect({
  ariaLabel,
  className,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  className?: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: MessageDescriptor }>;
  value: string;
}) {
  const intl = useIntl();
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected ? intl.formatMessage(selected.label) : value;

  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="xs"
      triggerButton={
        <NodexSettingsDropdownTrigger aria-label={ariaLabel} className={className}>
          <span className="truncate">{selectedLabel}</span>
        </NodexSettingsDropdownTrigger>
      }
    >
      {options.map((option) => (
        <NodexDropdownItem
          key={option.value}
          onSelect={() => onChange(option.value)}
          rightSlot={option.value === value ? <NodexDropdownSelectedIcon /> : null}
        >
          {intl.formatMessage(option.label)}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

function OriginRuleRows({
  onRemove,
  policy,
}: {
  onRemove: (input: BrowserUseOriginRuleUpdate) => Promise<void>;
  policy: BrowserUsePolicySnapshot;
}) {
  const intl = useIntl();
  const groups: Array<{
    kind: BrowserUseOriginRuleUpdate["kind"];
    origins: string[];
    resource: BrowserUsePolicyResource;
  }> = [
    { kind: "allowed", origins: policy.allowedOrigins, resource: "origin" },
    { kind: "denied", origins: policy.deniedOrigins, resource: "origin" },
    {
      kind: "allowed",
      origins: policy.allowedDownloadOrigins,
      resource: "download",
    },
    {
      kind: "denied",
      origins: policy.deniedDownloadOrigins,
      resource: "download",
    },
    {
      kind: "allowed",
      origins: policy.allowedUploadOrigins,
      resource: "upload",
    },
    {
      kind: "denied",
      origins: policy.deniedUploadOrigins,
      resource: "upload",
    },
    {
      kind: "allowed",
      origins: policy.allowedFullCdpOrigins,
      resource: "fullCdp",
    },
    {
      kind: "denied",
      origins: policy.deniedFullCdpOrigins,
      resource: "fullCdp",
    },
  ];
  const rules = groups.flatMap((group) => group.origins.map((origin) => ({ ...group, origin })));
  if (rules.length === 0) {
    return (
      <EmptySettingsRow
        message={intl.formatMessage({
          id: "browser.browserSettingsPages.noDecisions",
          defaultMessage: "No remembered Browser Use decisions.",
        })}
      />
    );
  }
  return rules.map(({ kind, origin, resource }) => (
    <NodexSettingsRow
      key={`${resource}:${kind}:${origin}`}
      label={origin}
      description={`${resourceLabel(resource, intl)} · ${kind === "allowed" ? intl.formatMessage({ id: "browser.browserSettingsPages.originAllowed", defaultMessage: "Allowed" }) : intl.formatMessage({ id: "browser.browserSettingsPages.originDenied", defaultMessage: "Denied" })}`}
    >
      <NodexButton
        size="icon-xs"
        variant="ghost"
        aria-label={intl.formatMessage(
          {
            id: "browser.browserSettingsPages.removeOriginPolicy",
            defaultMessage: "Remove {origin} {resource} policy",
          },
          { origin, resource: resourceLabel(resource, intl) },
        )}
        onClick={() =>
          void onRemove({
            action: "remove",
            kind,
            origin,
            resource,
          })
        }
      >
        <DeleteIcon />
      </NodexButton>
    </NodexSettingsRow>
  ));
}

function resourceLabel(resource: BrowserUsePolicyResource, intl: IntlShape = getIntl()): string {
  if (resource === "origin")
    return intl.formatMessage({
      id: "browser.browserSettingsPages.website",
      defaultMessage: "Website",
    });
  if (resource === "download")
    return intl.formatMessage({
      id: "browser.browserSettingsPages.download",
      defaultMessage: "Download",
    });
  if (resource === "upload")
    return intl.formatMessage({
      id: "browser.browserSettingsPages.upload",
      defaultMessage: "Upload",
    });
  return intl.formatMessage({
    id: "browser.browserSettingsPages.fullCdp",
    defaultMessage: "Full CDP",
  });
}

export function BrowserPasswordsSettingsPage({
  backSlot,
  open,
}: {
  backSlot?: ReactNode;
  open: boolean;
}) {
  const intl = useIntl();
  const [credentials, setCredentials] = useState<BrowserCredentialSummary[]>([]);
  const [capability, setCapability] = useState<BrowserCapabilityStatus>(EMPTY_CAPABILITY);
  const [importOpen, setImportOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const refresh = useCallback(
    () =>
      Promise.all([readBrowserProfileCapabilities(), readAllBrowserCredentials()]).then(
        ([capabilities, credentials]) => {
          setCapability(capabilities.credentialVault);
          setCredentials(credentials);
        },
      ),
    [],
  );
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const remove = async (credentialId: string) => {
    const result = await removeBrowserCredential(credentialId);
    setStatus(
      result.ok
        ? intl.formatMessage({
            id: "browser.browserSettingsPages.passwordRemoved",
            defaultMessage: "Password removed.",
          })
        : (result.message ??
            intl.formatMessage({
              id: "browser.browserSettingsPages.passwordRemoveFailed",
              defaultMessage: "Unable to remove password.",
            })),
    );
    if (result.ok) await refresh();
  };

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage({
        id: "browser.browserSettingsPages.passwordManager",
        defaultMessage: "Password manager",
      })}
      subtitle={intl.formatMessage({
        id: "browser.browserSettingsPages.passwordsDescription",
        defaultMessage:
          "Saved passwords stay encrypted and are revealed only to the selected site’s guest page.",
      })}
      backSlot={backSlot}
      action={
        <NodexButton
          size="toolbar"
          variant="secondary"
          disabled={!capability.available}
          onClick={() => setImportOpen(true)}
        >
          <DownloadIcon />
          {intl.formatMessage({
            id: "browser.browserSettingsPages.import",
            defaultMessage: "Import",
          })}
        </NodexButton>
      }
    >
      {!capability.available ? (
        <UnavailableCapability capability={capability} />
      ) : (
        <NodexSettingsSection
          title={intl.formatMessage({
            id: "browser.browserSettingsPages.savedPasswords",
            defaultMessage: "Saved passwords",
          })}
        >
          {credentials.length === 0 ? (
            <EmptySettingsRow
              message={intl.formatMessage({
                id: "browser.browserSettingsPages.noPasswords",
                defaultMessage: "No saved passwords.",
              })}
            />
          ) : (
            credentials.map((credential) => (
              <NodexSettingsRow
                key={credential.id}
                label={credential.label}
                description={`${credential.username || intl.formatMessage({ id: "browser.browserSettingsPages.noUsername", defaultMessage: "No username" })} · ${credential.origin}`}
              >
                <NodexButton
                  size="icon-xs"
                  variant="ghost"
                  aria-label={intl.formatMessage(
                    {
                      id: "browser.browserSettingsPages.removePassword",
                      defaultMessage: "Remove password for {origin}",
                    },
                    { origin: credential.origin },
                  )}
                  onClick={() => void remove(credential.id)}
                >
                  <DeleteIcon />
                </NodexButton>
              </NodexSettingsRow>
            ))
          )}
        </NodexSettingsSection>
      )}
      {status ? <SettingsStatus>{status}</SettingsStatus> : null}
      <BrowserProfileImportDialog
        open={importOpen}
        onOpenChange={(nextOpen) => {
          setImportOpen(nextOpen);
          if (!nextOpen) void refresh();
        }}
      />
    </NodexSettingsPageSurface>
  );
}

export function BrowserContactInfoSettingsPage({
  backSlot,
  open,
}: {
  backSlot?: ReactNode;
  open: boolean;
}) {
  const intl = useIntl();
  const [contacts, setContacts] = useState<BrowserContactInfo[]>([]);
  const [capability, setCapability] = useState<BrowserCapabilityStatus>(EMPTY_CAPABILITY);
  const [draft, setDraft] = useState<BrowserContactInfoUpsertInput | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const refresh = useCallback(
    () =>
      Promise.all([readBrowserProfileCapabilities(), readBrowserContactInfo()]).then(
        ([capabilities, contacts]) => {
          setCapability(capabilities.contactInfo);
          setContacts(contacts);
        },
      ),
    [],
  );
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const save = async () => {
    if (!draft) return;
    try {
      await saveBrowserContactInfo(draft);
      setDraft(null);
      setStatus(
        intl.formatMessage({
          id: "browser.browserSettingsPages.contactsSaved",
          defaultMessage: "Contact info saved.",
        }),
      );
      await refresh();
    } catch (error) {
      setStatus(
        readErrorMessage(
          error,
          intl.formatMessage({
            id: "browser.browserSettingsPages.contactsSaveFailed",
            defaultMessage: "Unable to save contact info.",
          }),
        ),
      );
    }
  };
  const remove = async (contactInfoId: string) => {
    const result = await removeBrowserContactInfo(contactInfoId);
    setStatus(
      result.ok
        ? intl.formatMessage({
            id: "browser.browserSettingsPages.contactsRemoved",
            defaultMessage: "Contact info removed.",
          })
        : (result.message ??
            intl.formatMessage({
              id: "browser.browserSettingsPages.contactsRemoveFailed",
              defaultMessage: "Unable to remove contact info.",
            })),
    );
    if (result.ok) await refresh();
  };

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage({
        id: "browser.browserSettingsPages.contacts",
        defaultMessage: "Contact info",
      })}
      subtitle={intl.formatMessage({
        id: "browser.browserSettingsPages.contactsPageDescription",
        defaultMessage:
          "Choose a saved contact from Browser chrome to fill recognized form fields.",
      })}
      backSlot={backSlot}
      action={
        capability.available ? (
          <NodexButton
            size="toolbar"
            variant="secondary"
            onClick={() => setDraft(emptyContactDraft())}
          >
            {intl.formatMessage({
              id: "browser.browserSettingsPages.addContact",
              defaultMessage: "Add contact",
            })}
          </NodexButton>
        ) : null
      }
    >
      {!capability.available ? (
        <UnavailableCapability capability={capability} />
      ) : (
        <>
          {draft ? (
            <ContactInfoEditor
              draft={draft}
              onChange={setDraft}
              onCancel={() => setDraft(null)}
              onSave={() => void save()}
            />
          ) : null}
          <NodexSettingsSection
            title={intl.formatMessage({
              id: "browser.browserSettingsPages.savedContacts",
              defaultMessage: "Saved contact info",
            })}
          >
            {contacts.length === 0 ? (
              <EmptySettingsRow
                message={intl.formatMessage({
                  id: "browser.browserSettingsPages.noContacts",
                  defaultMessage: "No saved contact info.",
                })}
              />
            ) : (
              contacts.map((contact) => (
                <NodexSettingsRow
                  key={contact.id}
                  label={contact.label}
                  description={[
                    contact.fullName,
                    contact.email,
                    contact.phone,
                    contact.city,
                    contact.country,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <NodexButton
                    size="toolbar"
                    variant="ghost"
                    onClick={() => setDraft(contactToDraft(contact))}
                  >
                    {intl.formatMessage({
                      id: "browser.browserSettingsPages.edit",
                      defaultMessage: "Edit",
                    })}
                  </NodexButton>
                  <NodexButton
                    size="icon-xs"
                    variant="ghost"
                    aria-label={intl.formatMessage(
                      {
                        id: "browser.browserSettingsPages.removeContact",
                        defaultMessage: "Remove {contact}",
                      },
                      { contact: contact.label },
                    )}
                    onClick={() => void remove(contact.id)}
                  >
                    <DeleteIcon />
                  </NodexButton>
                </NodexSettingsRow>
              ))
            )}
          </NodexSettingsSection>
        </>
      )}
      {status ? <SettingsStatus>{status}</SettingsStatus> : null}
    </NodexSettingsPageSurface>
  );
}

export function BrowserHistorySettingsPage({
  backSlot,
  open,
}: {
  backSlot?: ReactNode;
  open: boolean;
}) {
  const intl = useIntl();
  const [entries, setEntries] = useState<BrowserHistoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const refresh = useCallback(async (nextQuery: string) => {
    const snapshot = await readBrowserHistory({
      ...(nextQuery.trim() ? { query: nextQuery.trim() } : {}),
      limit: 500,
    });
    setEntries(snapshot.entries);
  }, []);
  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => void refresh(query), 120);
    return () => window.clearTimeout(timeout);
  }, [open, query, refresh]);

  const remove = async (historyId: string) => {
    const result = await removeBrowserHistoryEntry(historyId);
    setStatus(
      result.ok
        ? intl.formatMessage({
            id: "browser.browserSettingsPages.visitRemoved",
            defaultMessage: "History entry removed.",
          })
        : (result.message ??
            intl.formatMessage({
              id: "browser.browserSettingsPages.visitRemoveFailed",
              defaultMessage: "Unable to remove history entry.",
            })),
    );
    if (result.ok) await refresh(query);
  };
  const clear = async () => {
    const result = await clearBrowserData("history");
    setStatus(
      result.ok
        ? intl.formatMessage({
            id: "browser.browserSettingsPages.historyCleared",
            defaultMessage: "Browser history cleared.",
          })
        : (result.message ??
            intl.formatMessage({
              id: "browser.browserSettingsPages.historyClearFailed",
              defaultMessage: "Unable to clear history.",
            })),
    );
    if (result.ok) await refresh(query);
  };

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage({
        id: "browser.browserSettingsPages.history",
        defaultMessage: "Browsing history",
      })}
      subtitle={intl.formatMessage({
        id: "browser.browserSettingsPages.historyPageDescription",
        defaultMessage: "Visits from the shared built-in Browser Profile.",
      })}
      backSlot={backSlot}
      action={
        <NodexButton size="toolbar" variant="secondary" onClick={() => void clear()}>
          <DeleteIcon />
          {intl.formatMessage({
            id: "browser.browserSettingsPages.clear",
            defaultMessage: "Clear",
          })}
        </NodexButton>
      }
    >
      <label
        className={cn("flex h-9 items-center gap-2 px-3", NODEX_SETTINGS_FIELD_CHROME_CLASS_NAME)}
      >
        <SearchIcon className="size-4 text-token-text-tertiary" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-token-text-tertiary"
          value={query}
          placeholder={intl.formatMessage({
            id: "browser.browserSettingsPages.searchHistory",
            defaultMessage: "Search history",
          })}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <NodexSettingsSection>
        {entries.length === 0 ? (
          <EmptySettingsRow
            message={
              query
                ? intl.formatMessage({
                    id: "browser.browserSettingsPages.noMatchingVisits",
                    defaultMessage: "No matching visits.",
                  })
                : intl.formatMessage({
                    id: "browser.browserSettingsPages.noHistory",
                    defaultMessage: "No Browser history yet.",
                  })
            }
          />
        ) : (
          entries.map((entry) => (
            <NodexSettingsRow
              key={entry.id}
              label={entry.title || entry.url}
              description={`${entry.url} · ${formatVisitTime(entry.lastVisitedAt, intl)}`}
            >
              <NodexButton
                size="icon-xs"
                variant="ghost"
                aria-label={intl.formatMessage(
                  {
                    id: "browser.browserSettingsPages.removeVisit",
                    defaultMessage: "Remove {entry} from history",
                  },
                  { entry: entry.title || entry.url },
                )}
                onClick={() => void remove(entry.id)}
              >
                <DeleteIcon />
              </NodexButton>
            </NodexSettingsRow>
          ))
        )}
      </NodexSettingsSection>
      {status ? <SettingsStatus>{status}</SettingsStatus> : null}
    </NodexSettingsPageSurface>
  );
}

export function BrowserExtensionsSettingsPage({
  backSlot,
  open,
}: {
  backSlot?: ReactNode;
  open: boolean;
}) {
  const intl = useIntl();
  const [snapshot, setSnapshot] = useState<BrowserExtensionsSnapshot>({
    capability: EMPTY_CAPABILITY,
    extensions: [],
  });
  const [status, setStatus] = useState<string | null>(null);
  const refresh = useCallback(() => readBrowserExtensions().then(setSnapshot), []);
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const load = async () => {
    try {
      const extension = await loadBrowserExtension();
      if (!extension) return;
      setStatus(`${extension.name} loaded.`);
      await refresh();
    } catch (error) {
      setStatus(
        readErrorMessage(
          error,
          intl.formatMessage({
            id: "browser.browserSettingsPages.extensionLoadFailed",
            defaultMessage: "Unable to load extension.",
          }),
        ),
      );
    }
  };
  const remove = async (extensionId: string) => {
    const result = await removeBrowserExtension(extensionId);
    setStatus(
      result.ok
        ? intl.formatMessage({
            id: "browser.browserSettingsPages.extensionRemoved",
            defaultMessage: "Extension removed.",
          })
        : (result.message ??
            intl.formatMessage({
              id: "browser.browserSettingsPages.extensionRemoveFailed",
              defaultMessage: "Unable to remove extension.",
            })),
    );
    if (result.ok) await refresh();
  };

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage({
        id: "browser.browserSettingsPages.extensionManager",
        defaultMessage: "Extension manager",
      })}
      subtitle={intl.formatMessage({
        id: "browser.browserSettingsPages.extensionsPageDescription",
        defaultMessage: "Unpacked extensions loaded into the shared built-in Browser Profile.",
      })}
      backSlot={backSlot}
      action={
        snapshot.capability.available ? (
          <NodexButton size="toolbar" variant="secondary" onClick={() => void load()}>
            <Puzzle />
            {intl.formatMessage({
              id: "browser.browserSettingsPages.loadUnpacked",
              defaultMessage: "Load unpacked",
            })}
          </NodexButton>
        ) : null
      }
    >
      {!snapshot.capability.available ? (
        <UnavailableCapability capability={snapshot.capability} />
      ) : (
        <NodexSettingsSection>
          {snapshot.extensions.length === 0 ? (
            <EmptySettingsRow
              message={intl.formatMessage({
                id: "browser.browserSettingsPages.noExtensions",
                defaultMessage: "No extensions loaded.",
              })}
            />
          ) : (
            snapshot.extensions.map((extension) => (
              <NodexSettingsRow
                key={extension.id}
                label={`${extension.name} ${extension.version}`}
                description={extension.path}
              >
                <NodexButton
                  size="icon-xs"
                  variant="ghost"
                  aria-label={intl.formatMessage(
                    {
                      id: "browser.browserSettingsPages.removeExtension",
                      defaultMessage: "Remove {name}",
                    },
                    { name: extension.name },
                  )}
                  onClick={() => void remove(extension.id)}
                >
                  <DeleteIcon />
                </NodexButton>
              </NodexSettingsRow>
            ))
          )}
        </NodexSettingsSection>
      )}
      {status ? <SettingsStatus>{status}</SettingsStatus> : null}
    </NodexSettingsPageSurface>
  );
}

/**
 * Says why a Browser capability can't work on this computer. A working or still-checking one
 * shows nothing: the controls that use it are the evidence.
 */
function CapabilityRow({
  capability,
  label,
}: {
  capability: BrowserCapabilityStatus;
  label: string;
}) {
  const intl = useIntl();
  if (capability.available || capability === EMPTY_CAPABILITY) return null;
  return (
    <NodexSettingsRow
      label={label}
      description={
        capability.reason ??
        intl.formatMessage({
          id: "browser.browserSettingsPages.unavailablePeriod",
          defaultMessage: "Unavailable.",
        })
      }
    >
      <span className="text-xs text-token-text-tertiary">
        {intl.formatMessage({
          id: "browser.browserSettingsPages.unavailable",
          defaultMessage: "Unavailable",
        })}
      </span>
    </NodexSettingsRow>
  );
}

function ContactInfoEditor({
  draft,
  onCancel,
  onChange,
  onSave,
}: {
  draft: BrowserContactInfoUpsertInput;
  onCancel: () => void;
  onChange: (draft: BrowserContactInfoUpsertInput) => void;
  onSave: () => void;
}) {
  const intl = useIntl();
  const setField = (field: keyof BrowserContactInfoUpsertInput, value: string) => {
    onChange({ ...draft, [field]: value });
  };
  const fields: Array<{
    field: Exclude<keyof BrowserContactInfoUpsertInput, "id">;
    label: string;
    placeholder?: string;
  }> = [
    {
      field: "label",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.contactLabel",
        defaultMessage: "Label",
      }),
      placeholder: intl.formatMessage({
        id: "browser.browserSettingsPages.contactLabelPlaceholder",
        defaultMessage: "Home",
      }),
    },
    {
      field: "fullName",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.fullName",
        defaultMessage: "Full name",
      }),
    },
    {
      field: "email",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.email",
        defaultMessage: "Email",
      }),
    },
    {
      field: "phone",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.phone",
        defaultMessage: "Phone",
      }),
    },
    {
      field: "addressLine1",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.addressLine1",
        defaultMessage: "Address line 1",
      }),
    },
    {
      field: "addressLine2",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.addressLine2",
        defaultMessage: "Address line 2",
      }),
    },
    {
      field: "city",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.city",
        defaultMessage: "City",
      }),
    },
    {
      field: "region",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.region",
        defaultMessage: "State or region",
      }),
    },
    {
      field: "postalCode",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.postalCode",
        defaultMessage: "Postal code",
      }),
    },
    {
      field: "country",
      label: intl.formatMessage({
        id: "browser.browserSettingsPages.country",
        defaultMessage: "Country",
      }),
    },
  ];
  const hasValue = [
    draft.fullName,
    draft.email,
    draft.phone,
    draft.addressLine1,
    draft.addressLine2,
    draft.city,
    draft.region,
    draft.postalCode,
    draft.country,
  ].some((value) => value.trim());
  return (
    <NodexSettingsSection
      title={
        draft.id
          ? intl.formatMessage({
              id: "browser.browserSettingsPages.editContact",
              defaultMessage: "Edit contact",
            })
          : intl.formatMessage({
              id: "browser.browserSettingsPages.newContact",
              defaultMessage: "New contact",
            })
      }
    >
      {fields.map(({ field, label, placeholder }) => (
        <NodexSettingsRow key={field} label={label}>
          <Input
            variant="settings"
            className="h-8 w-64 max-w-[45vw] px-2 text-sm"
            value={draft[field]}
            placeholder={placeholder}
            onChange={(event) => setField(field, event.target.value)}
          />
        </NodexSettingsRow>
      ))}
      <div className="flex justify-end gap-2 p-3">
        <NodexButton size="toolbar" variant="ghost" onClick={onCancel}>
          {intl.formatMessage({
            id: "browser.browserSettingsPages.cancel",
            defaultMessage: "Cancel",
          })}
        </NodexButton>
        <NodexButton size="toolbar" disabled={!hasValue} onClick={onSave}>
          {intl.formatMessage({ id: "browser.browserSettingsPages.save", defaultMessage: "Save" })}
        </NodexButton>
      </div>
    </NodexSettingsSection>
  );
}

function UnavailableCapability({ capability }: { capability: BrowserCapabilityStatus }) {
  const intl = useIntl();
  return (
    <NodexSettingsSection>
      <NodexSettingsRow
        label={intl.formatMessage({
          id: "browser.browserSettingsPages.unavailable",
          defaultMessage: "Unavailable",
        })}
        description={
          (capability === EMPTY_CAPABILITY
            ? intl.formatMessage(CHECKING_AVAILABILITY)
            : capability.reason) ??
          intl.formatMessage({
            id: "browser.browserSettingsPages.providerUnavailable",
            defaultMessage: "This provider is not available in the current runtime.",
          })
        }
      >
        <RefreshIcon className="size-4 text-token-text-tertiary" />
      </NodexSettingsRow>
    </NodexSettingsSection>
  );
}

function EmptySettingsRow({ message }: { message: string }) {
  return <div className="p-3 text-sm text-token-text-secondary">{message}</div>;
}

function SettingsStatus({ children }: { children: ReactNode }) {
  return <div className="py-2 text-sm text-token-text-secondary">{children}</div>;
}

function formatVisitTime(value: number, intl: IntlShape = getIntl()): string {
  return new Intl.DateTimeFormat(intl.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function emptyContactDraft(): BrowserContactInfoUpsertInput {
  return {
    label: "",
    fullName: "",
    email: "",
    phone: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
  };
}

function contactToDraft(contact: BrowserContactInfo): BrowserContactInfoUpsertInput {
  return {
    id: contact.id,
    label: contact.label,
    fullName: contact.fullName,
    email: contact.email,
    phone: contact.phone,
    addressLine1: contact.addressLine1,
    addressLine2: contact.addressLine2,
    city: contact.city,
    region: contact.region,
    postalCode: contact.postalCode,
    country: contact.country,
  };
}

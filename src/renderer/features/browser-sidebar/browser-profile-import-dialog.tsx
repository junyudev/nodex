import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import type {
  BrowserProfileCapabilities,
  BrowserProfileImportResult,
  ImportableBrowserProfile,
} from "../../../shared/browser-profile";
import {
  importBrowserProfile,
  readBrowserProfileCapabilities,
  readImportableBrowserProfiles,
} from "./browser-profile-runtime";

const EMPTY_CAPABILITIES: BrowserProfileCapabilities = {
  contactInfo: {
    available: false,
    provider: "unavailable",
    reason: "Contact info storage is unavailable",
  },
  credentialVault: {
    available: false,
    provider: "unavailable",
    reason: "Secure credential storage is unavailable",
  },
  extensions: {
    available: false,
    provider: "unavailable",
    reason: "Extensions are unavailable",
  },
  history: {
    available: false,
    provider: "unavailable",
    reason: "History is unavailable",
  },
  profileImport: {
    available: false,
    provider: "unavailable",
    reason: "Browser Profile import is unavailable",
  },
  siteInfo: {
    available: false,
    provider: "unavailable",
    reason: "Site information is unavailable",
  },
};

export function BrowserProfileImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<ImportableBrowserProfile[]>([]);
  const [capabilities, setCapabilities] = useState<BrowserProfileCapabilities>(EMPTY_CAPABILITIES);
  const [selectedProfilePath, setSelectedProfilePath] = useState("");
  const [importPasswords, setImportPasswords] = useState(true);
  const [importCookies, setImportCookies] = useState(true);
  const [domainAllowlist, setDomainAllowlist] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BrowserProfileImportResult | null>(null);
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.profilePath === selectedProfilePath) ?? null,
    [profiles, selectedProfilePath],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setResult(null);
    setLoading(true);
    void Promise.all([readBrowserProfileCapabilities(), readImportableBrowserProfiles()])
      .then(([nextCapabilities, nextProfiles]) => {
        if (cancelled) return;
        setCapabilities(nextCapabilities);
        setProfiles(nextProfiles);
        setSelectedProfilePath((current) => {
          if (nextProfiles.some((profile) => profile.profilePath === current)) {
            return current;
          }
          return nextProfiles[0]?.profilePath ?? "";
        });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(readErrorMessage(reason, "Unable to inspect browser profiles"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!selectedProfile) return;
    setImportCookies(selectedProfile.hasCookies);
    setImportPasswords(selectedProfile.hasPasswords && capabilities.credentialVault.available);
  }, [capabilities.credentialVault.available, selectedProfile]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProfile || (!importCookies && !importPasswords)) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const imported = await importBrowserProfile({
        source: selectedProfile.source,
        profilePath: selectedProfile.profilePath,
        importCookies,
        importPasswords,
        ...(importCookies ? { cookieDomainAllowlist: parseDomainAllowlist(domainAllowlist) } : {}),
      });
      setResult(imported);
    } catch (reason) {
      setError(readErrorMessage(reason, "Browser Profile import failed"));
    } finally {
      setLoading(false);
    }
  };

  const importDisabled =
    loading ||
    !capabilities.profileImport.available ||
    !selectedProfile ||
    (!importCookies && !importPasswords) ||
    selectedProfile.sourceBrowserOpen;
  const selectedProfileLabel = selectedProfile
    ? `${selectedProfile.appName} — ${selectedProfile.profileName}${selectedProfile.userName ? ` (${selectedProfile.userName})` : ""}`
    : "No importable profiles found";

  return (
    <NodexDialog open={open} onOpenChange={onOpenChange}>
      <NodexDialogContent size="default">
        <NodexDialogForm onSubmit={(event) => void submit(event)}>
          <NodexDialogHeader>
            <NodexDialogTitle>Import from your browser</NodexDialogTitle>
            <NodexDialogDescription>
              Bring cookies and saved passwords into the built-in Browser Profile.
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody className="gap-4">
            {!capabilities.profileImport.available ? (
              <BrowserImportNotice tone="warning">
                {capabilities.profileImport.reason ??
                  "Browser Profile import is unavailable on this device."}
              </BrowserImportNotice>
            ) : null}
            <label className="flex flex-col gap-1.5 text-sm text-token-text-primary">
              Profile
              <NodexDropdownMenu
                disabled={loading || profiles.length === 0}
                contentWidth="menu"
                triggerButton={
                  <NodexSettingsDropdownTrigger aria-label="Profile" className="h-9 w-full">
                    <span className="truncate">{selectedProfileLabel}</span>
                  </NodexSettingsDropdownTrigger>
                }
              >
                {profiles.map((profile) => {
                  const profileLabel = `${profile.appName} — ${profile.profileName}${profile.userName ? ` (${profile.userName})` : ""}`;

                  return (
                    <NodexDropdownItem
                      key={`${profile.source}:${profile.profilePath}`}
                      onSelect={() => setSelectedProfilePath(profile.profilePath)}
                      rightSlot={
                        profile.profilePath === selectedProfilePath ? (
                          <NodexDropdownSelectedIcon />
                        ) : null
                      }
                    >
                      {profileLabel}
                    </NodexDropdownItem>
                  );
                })}
              </NodexDropdownMenu>
            </label>
            {selectedProfile?.sourceBrowserOpen ? (
              <BrowserImportNotice tone="warning">
                Close {selectedProfile.appName} completely before importing this Profile.
              </BrowserImportNotice>
            ) : null}
            <div className="overflow-hidden rounded-xl border border-token-border">
              <BrowserImportChoice
                checked={importPasswords}
                disabled={
                  loading ||
                  !selectedProfile?.hasPasswords ||
                  !capabilities.credentialVault.available
                }
                label="Passwords"
                description={
                  capabilities.credentialVault.available
                    ? "Decrypt with the source browser’s macOS key, then store immediately in Nodex encrypted storage."
                    : (capabilities.credentialVault.reason ??
                      "Secure credential storage is unavailable.")
                }
                onChange={setImportPasswords}
              />
              <BrowserImportChoice
                checked={importCookies}
                disabled={loading || !selectedProfile?.hasCookies}
                label="Cookies"
                description="Import sign-in cookies into the shared built-in Browser Profile."
                onChange={setImportCookies}
              />
            </div>
            {importCookies ? (
              <label className="flex flex-col gap-1.5 text-sm text-token-text-primary">
                Cookie domains
                <textarea
                  className="min-h-20 resize-y rounded-lg border border-token-border bg-token-main-surface-primary px-3 py-2 text-sm outline-none placeholder:text-token-text-tertiary focus-visible:ring-1 focus-visible:ring-token-focus"
                  value={domainAllowlist}
                  placeholder="Optional. One domain per line, for example example.com"
                  onChange={(event) => setDomainAllowlist(event.target.value)}
                />
                <span className="text-xs text-token-text-secondary">
                  Leave empty to import every valid cookie in this Profile.
                </span>
              </label>
            ) : null}
            {error ? <BrowserImportNotice tone="danger">{error}</BrowserImportNotice> : null}
            {result ? <BrowserImportResultView result={result} /> : null}
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={() => onOpenChange(false)}>
              {result ? "Done" : "Cancel"}
            </NodexDialogAction>
            {!result ? (
              <NodexDialogAction type="submit" tone="primary" disabled={importDisabled}>
                {loading ? "Importing…" : "Import"}
              </NodexDialogAction>
            ) : null}
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function BrowserImportChoice({
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-interaction items-start gap-3 border-b border-token-border p-3 last:border-b-0 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-current"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-sm text-token-text-primary">{label}</span>
        <span className="text-xs leading-5 text-token-text-secondary">{description}</span>
      </span>
    </label>
  );
}

function BrowserImportNotice({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "danger" | "warning";
}) {
  return (
    <div
      className={
        tone === "danger"
          ? "rounded-lg bg-token-error-background px-3 py-2 text-sm text-token-error-foreground"
          : "rounded-lg bg-token-warning-background px-3 py-2 text-sm text-token-warning-foreground"
      }
    >
      {children}
    </div>
  );
}

function BrowserImportResultView({ result }: { result: BrowserProfileImportResult }) {
  const rows = [
    result.passwords ? (["Passwords", result.passwords] as const) : null,
    result.cookies ? (["Cookies", result.cookies] as const) : null,
  ].filter((row): row is NonNullable<typeof row> => row !== null);
  return (
    <div className="overflow-hidden rounded-xl border border-token-border">
      {rows.map(([label, data]) => (
        <div
          key={label}
          className="flex items-start justify-between gap-3 border-b border-token-border p-3 last:border-b-0"
        >
          <div>
            <div className="text-sm text-token-text-primary">{label}</div>
            <div className="mt-1 text-xs text-token-text-secondary">
              {data.imported} imported
              {data.skippedExisting > 0 ? ` · ${data.skippedExisting} already present` : ""}
              {data.failed > 0 ? ` · ${data.failed} failed` : ""}
            </div>
          </div>
          <div className="text-xs capitalize text-token-text-secondary">
            {data.status.replace("-", " ")}
          </div>
        </div>
      ))}
    </div>
  );
}

function parseDomainAllowlist(value: string): string[] | undefined {
  const domains = Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  return domains.length > 0 ? domains : undefined;
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

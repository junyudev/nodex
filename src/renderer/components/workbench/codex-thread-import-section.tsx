import { useEffect, useId, useRef, useState } from "react";
import { parseCodexThreadImportReference } from "../../../shared/codex-thread-import-reference";
import type {
  CodexThreadImportInput,
  CodexThreadImportPreview,
  CodexThreadImportPreviewInput,
  CodexThreadImportResult,
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import { acceptCodexThreadImport } from "../../lib/native-session-catalog";
import { NodexButton } from "../ui/button";
import { NodexCompactFramedInput } from "../ui/input";
import { NodexSettingsSection } from "../ui/settings";
import {
  NativeSessionCatalogList,
  NativeSessionCatalogRow,
  NativeSessionDestinationPicker,
  NativeSessionPath,
  NativeSessionUpdatedAt,
  nativeSessionErrorMessage,
  nativeSessionTitle,
  useNativeSessionCatalog,
  type NativeSessionDestinations,
} from "./native-session-catalog-browser";
import type { SettingsOpenThread } from "./workbench-settings-page-registry";

export interface CodexThreadImportRuntime {
  readonly list: (input: NativeSessionCatalogInput) => Promise<NativeSessionCatalogPage>;
  readonly previewCodexImport: (
    input: CodexThreadImportPreviewInput,
  ) => Promise<CodexThreadImportPreview>;
  readonly importCodex: (input: CodexThreadImportInput) => Promise<CodexThreadImportResult>;
  readonly pickDirectory: () => Promise<string | null>;
}

type ReferenceLookup =
  | { readonly kind: "idle" }
  | { readonly kind: "invalid" }
  | { readonly kind: "loading"; readonly nativeSessionId: string }
  | { readonly kind: "failed"; readonly nativeSessionId: string; readonly message: string }
  | { readonly kind: "ready"; readonly preview: CodexThreadImportPreview };

const CODEX_CATALOG: NativeSessionCatalogInput = { backendKind: "codex" };

const lookupIdentity = (lookup: ReferenceLookup) =>
  lookup.kind === "ready"
    ? lookup.preview.nativeSessionId
    : lookup.kind === "loading" || lookup.kind === "failed"
      ? lookup.nativeSessionId
      : null;

export function CodexThreadImportSection({
  open,
  runtime,
  destinations,
  onOpenThread,
}: {
  open: boolean;
  runtime: CodexThreadImportRuntime;
  destinations: NativeSessionDestinations;
  onOpenThread?: SettingsOpenThread;
}) {
  const [reference, setReference] = useState("");
  const [lookup, setLookup] = useState<ReferenceLookup>({ kind: "idle" });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // A running import owns its source: nothing here may replace the form until it settles.
  const [importing, setImporting] = useState(false);
  const catalog = useNativeSessionCatalog(runtime.list, open);
  const lookupGeneration = useRef(0);
  const pasted = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    return () => {
      lookupGeneration.current += 1;
    };
  }, [open]);

  const lookUp = async (nativeSessionId: string, value: string) => {
    const ownGeneration = ++lookupGeneration.current;
    setExpandedId(null);
    setLookup({ kind: "loading", nativeSessionId });
    try {
      const preview = await runtime.previewCodexImport({ reference: value.trim() });
      if (lookupGeneration.current === ownGeneration) setLookup({ kind: "ready", preview });
    } catch (cause) {
      if (lookupGeneration.current === ownGeneration)
        setLookup({ kind: "failed", nativeSessionId, message: nativeSessionErrorMessage(cause) });
    }
  };

  const changeReference = (value: string) => {
    const wasPasted = pasted.current;
    pasted.current = false;
    setReference(value);
    const nativeSessionId = parseCodexThreadImportReference(value);
    if (nativeSessionId) {
      if (lookupIdentity(lookup) !== nativeSessionId) void lookUp(nativeSessionId, value);
      return;
    }
    lookupGeneration.current += 1;
    setLookup(wasPasted && value.trim() ? { kind: "invalid" } : { kind: "idle" });
  };

  const submitReference = () => {
    const nativeSessionId = parseCodexThreadImportReference(reference);
    if (!nativeSessionId) {
      if (reference.trim()) setLookup({ kind: "invalid" });
      return;
    }
    if (lookup.kind !== "loading" && lookup.kind !== "ready")
      void lookUp(nativeSessionId, reference);
  };

  const clearReference = () => {
    lookupGeneration.current += 1;
    setReference("");
    setLookup({ kind: "idle" });
  };

  return (
    <NodexSettingsSection title="Import from Codex">
      <div className="flex items-center gap-2 px-4 py-3">
        <NodexCompactFramedInput
          ref={input}
          aria-label="Codex conversation link or ID"
          placeholder="Paste a codex://threads link or conversation ID"
          spellCheck={false}
          autoComplete="off"
          className="h-8 flex-1 px-2.5"
          readOnly={importing}
          value={reference}
          onPaste={() => {
            pasted.current = true;
          }}
          onChange={(event) => changeReference(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submitReference();
          }}
        />
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={catalog.loading || importing}
          onClick={() => void catalog.browse(CODEX_CATALOG)}
        >
          {catalog.loading ? "Loading…" : "Browse"}
        </NodexButton>
      </div>

      {lookup.kind === "invalid" ? (
        <div role="alert" className="px-4 py-2.5 text-xs text-danger">
          Paste a codex://threads link or a conversation ID.
        </div>
      ) : lookup.kind === "loading" ? (
        <div role="status" className="px-4 py-2.5 text-xs text-token-text-secondary">
          Looking up conversation…
        </div>
      ) : lookup.kind === "failed" ? (
        <div className="flex items-center gap-3 px-4 py-2">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger">
            {lookup.message}
          </p>
          <NodexButton size="sm" variant="ghost" onClick={submitReference}>
            Try again
          </NodexButton>
        </div>
      ) : lookup.kind === "ready" ? (
        <CodexThreadImportForm
          key={`${lookup.preview.nativeHome}\n${lookup.preview.nativeSessionId}`}
          source={lookup.preview}
          open={open}
          runtime={runtime}
          destinations={destinations}
          onOpenThread={onOpenThread}
          onImportingChange={setImporting}
          onCancel={() => {
            clearReference();
            input.current?.focus();
          }}
        />
      ) : null}

      <NativeSessionCatalogList
        catalog={catalog}
        input={CODEX_CATALOG}
        disabled={importing}
        emptyMessage="No Codex conversations found."
        renderEntry={(entry, page) =>
          entry.nativeSessionId === expandedId ? (
            <CodexThreadImportForm
              key={`${page.nativeHome}\n${entry.nativeSessionId}`}
              source={{
                nativeSessionId: entry.nativeSessionId,
                nativeHome: page.nativeHome,
                title: entry.title,
                cwd: entry.cwd,
                cwdAvailable: entry.cwdAvailable !== false,
                updatedAt: entry.updatedAt,
              }}
              open={open}
              runtime={runtime}
              destinations={destinations}
              onOpenThread={onOpenThread}
              onImportingChange={setImporting}
              onCancel={() => setExpandedId(null)}
            />
          ) : (
            <NativeSessionCatalogRow
              key={entry.nativeSessionId}
              entry={entry}
              action={
                <NodexButton
                  aria-label={`Import ${nativeSessionTitle(entry.title)}`}
                  size="sm"
                  variant="secondary"
                  disabled={importing}
                  onClick={() => {
                    clearReference();
                    setExpandedId(entry.nativeSessionId);
                  }}
                >
                  Import
                </NodexButton>
              }
            />
          )
        }
      />
    </NodexSettingsSection>
  );
}

function CodexThreadImportForm({
  source,
  open,
  runtime,
  destinations,
  onOpenThread,
  onImportingChange,
  onCancel,
}: {
  source: CodexThreadImportPreview;
  open: boolean;
  runtime: CodexThreadImportRuntime;
  destinations: NativeSessionDestinations;
  onOpenThread?: SettingsOpenThread;
  onImportingChange: (importing: boolean) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [projectChoice, setProjectChoice] = useState<string | null | undefined>(undefined);
  const projectId = projectChoice === undefined ? destinations.defaultProjectId : projectChoice;
  const [replacementCwd, setReplacementCwd] = useState<string | null>(null);
  const cwd = replacementCwd ?? (source.cwdAvailable ? source.cwd : null);
  const [accepted, setAccepted] = useState<CodexThreadImportInput | null>(null);
  const [imported, setImported] = useState<CodexThreadImportResult | null>(null);
  const [pending, setPending] = useState<"directory" | "import" | "open" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = pending !== null || imported !== null;
  const importing = pending === "import" || pending === "open";
  // Each visible stay of this form; closing Settings or replacing the form ends it.
  const visit = useRef(0);

  useEffect(() => {
    if (!open) return;
    return () => {
      visit.current += 1;
    };
  }, [open]);

  useEffect(() => {
    if (!importing) return;
    onImportingChange(true);
    return () => onImportingChange(false);
  }, [importing, onImportingChange]);

  const openImported = async (result: CodexThreadImportResult) => {
    if (!onOpenThread) return;
    setPending("open");
    try {
      await onOpenThread(result.threadId, { runtimeSessionId: result.sessionId });
    } catch (cause) {
      setError(nativeSessionErrorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const importChat = async () => {
    if (!cwd || locked) return;
    const request = acceptCodexThreadImport(accepted, {
      nativeSessionId: source.nativeSessionId,
      expectedHome: source.nativeHome,
      projectId,
      cwd,
    });
    const ownVisit = visit.current;
    setAccepted(request);
    setPending("import");
    setError(null);
    let result: CodexThreadImportResult;
    try {
      result = await runtime.importCodex(request);
    } catch (cause) {
      setError(nativeSessionErrorMessage(cause));
      setPending(null);
      return;
    }
    setImported(result);
    // The chat exists either way; only a user still looking at this form is taken to it.
    if (visit.current !== ownVisit || !onOpenThread) {
      setPending(null);
      return;
    }
    await openImported(result);
  };

  const chooseDirectory = async () => {
    if (locked) return;
    setPending("directory");
    try {
      const picked = await runtime.pickDirectory();
      if (picked) {
        setReplacementCwd(picked);
        setError(null);
      }
    } catch (cause) {
      setError(nativeSessionErrorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div
          id={titleId}
          className="min-w-0 flex-1 truncate text-sm font-medium text-token-text-primary"
        >
          {nativeSessionTitle(source.title)}
        </div>
        <NativeSessionUpdatedAt updatedAt={source.updatedAt} />
      </div>
      <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-6 gap-y-2 text-sm">
        <span className="text-token-text-secondary">Destination</span>
        <div className="flex min-w-0">
          <NativeSessionDestinationPicker
            destinations={destinations}
            value={projectId}
            onValueChange={setProjectChoice}
            disabled={locked}
            ariaLabel="Import destination"
          />
        </div>
        <span className="self-start pt-1.5 text-token-text-secondary">Working directory</span>
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <NativeSessionPath
              path={cwd ?? source.cwd}
              className={cwd ? "text-token-text-primary" : "text-token-text-secondary"}
            />
            {!cwd ? (
              <span className="text-xs text-danger">
                Folder not found. Choose a replacement to import.
              </span>
            ) : cwd !== source.cwd ? (
              <span className="flex min-w-0 gap-1 text-xs text-token-description-foreground">
                <span className="shrink-0">Originally</span>
                <NativeSessionPath path={source.cwd} />
              </span>
            ) : null}
          </div>
          <NodexButton
            size="sm"
            variant={cwd ? "ghost" : "secondary"}
            disabled={locked}
            aria-label={cwd ? "Change working directory" : undefined}
            onClick={() => void chooseDirectory()}
          >
            {cwd ? "Change" : "Choose folder"}
          </NodexButton>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-48 flex-1 text-xs text-token-description-foreground">
          Copies the history into a new chat. The Codex conversation stays unchanged.
        </p>
        <div className="ml-auto flex gap-2">
          <NodexButton size="sm" variant="ghost" disabled={pending !== null} onClick={onCancel}>
            {imported ? "Close" : "Cancel"}
          </NodexButton>
          {imported ? (
            <NodexButton
              size="sm"
              variant="primary"
              disabled={pending !== null || !onOpenThread}
              onClick={() => void openImported(imported)}
            >
              {pending === "open" ? "Opening…" : "Open chat"}
            </NodexButton>
          ) : (
            <NodexButton
              size="sm"
              variant="primary"
              disabled={!cwd || locked}
              onClick={() => void importChat()}
            >
              {pending === "import" ? "Importing…" : "Import and open"}
            </NodexButton>
          )}
        </div>
      </div>
    </div>
  );
}

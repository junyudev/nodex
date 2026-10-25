import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  BackIcon,
  OpenExternalIcon,
  SearchIcon,
  SettingsAgentIcon,
} from "@/components/shared/icons";
import { NodexIconButton } from "@/components/ui/button";
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
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { NodexTabsList, NodexTabsPanel, NodexTabsRoot, NodexTabsTab } from "@/components/ui/tabs";
import { openExternalUrl } from "@/lib/file-system-operations";
import type { ModalCloseProps } from "@/lib/modal-registry";
import { cn } from "@/lib/utils";
import type { AcpFailure } from "../../../shared/acp-api";
import {
  AcpAgentInstanceFields,
  AcpAgentSourceSchema,
  type AcpAgentInstanceInput,
} from "../../../shared/acp-agent-settings";
import {
  ACP_ADD_AGENT_ID,
  ACP_REGISTRY_ID_PATTERN,
  acpAvailabilityText,
  acpDistributionLabel,
  acpFailureText,
  acpInstanceName,
  acpLocalAgentIdentity,
  acpRegistryIconUrl,
  acpRegistryUnavailableText,
  acpRunnerLabel,
  type AcpDistributionChoice,
  type AcpInstallPreview,
  type AcpRegistryAgent,
} from "./acp-agent-model";
import { acpArgumentProblem, type AcpArgumentDraft } from "./acp-agent-draft";
import type { AcpAgentsOwner } from "./acp-agents-owner";
import { AcpArgumentsEditor } from "./acp-arguments-editor";
import { useAcpAgents } from "./use-acp-agents";

export interface AcpAgentAddDialogProps extends ModalCloseProps {
  readonly owner: AcpAgentsOwner;
  /** Called with the saved instance so Settings can reveal its progress. */
  readonly onAdded?: (instanceId: string) => void;
}

type Storage = { readonly kind: "shared" } | { readonly kind: "separate"; readonly home: string };

const storageCredentials = (storage: Storage): AcpAgentInstanceInput["credentials"] =>
  storage.kind === "separate"
    ? { kind: "isolated-home", home: storage.home.trim() }
    : { kind: "inherit-host-profile" };

type Field = "name" | "executable" | "arguments" | "home" | "identity";
type FieldProblem = { readonly field: Field; readonly message: string };

const storageProblem = (storage: Storage): FieldProblem | null =>
  storage.kind === "separate" &&
  !AcpAgentInstanceFields.credentials.safeParse(storageCredentials(storage)).success
    ? { field: "home", message: "Use an absolute folder path for the separate account." }
    : null;

/**
 * A form's first problem stays quiet until the first submit; from then on it shows under its
 * field, which is marked invalid and described by it, and each blocked submit focuses that field.
 */
function useFieldProblem(problem: FieldProblem | null) {
  const [shown, setShown] = useState(false);
  const messageId = useId();
  const visible = shown ? problem : null;
  return {
    /** Props for the control of `field`; `name` lets a blocked submit find it. */
    control: (field: Field) =>
      visible?.field === field
        ? { name: field, "aria-invalid": true, "aria-describedby": messageId }
        : { name: field },
    message: (field: Field) =>
      visible?.field === field ? (
        <span id={messageId} role="alert" className="text-xs text-danger">
          {visible.message}
        </span>
      ) : null,
    /** Whether `form` may submit; otherwise reveals the problem and focuses its field. */
    allows: (form: HTMLFormElement) => {
      if (!problem) return true;
      setShown(true);
      const control = form.elements.namedItem(problem.field);
      if (control instanceof HTMLElement) control.focus();
      return false;
    },
  };
}

function Labeled({
  label,
  hint,
  problem,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  /** Replaces the hint while the field has a problem. */
  readonly problem?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-token-text-secondary">{label}</span>
      {children}
      {problem ??
        (hint ? <span className="text-xs text-token-description-foreground">{hint}</span> : null)}
    </label>
  );
}

/** Where the instance keeps the Agent's own login and history; fixed once it is saved. */
function StorageField({
  storage,
  disabled,
  problems,
  onChange,
}: {
  readonly storage: Storage;
  readonly disabled: boolean;
  readonly problems: ReturnType<typeof useFieldProblem>;
  readonly onChange: (storage: Storage) => void;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-token-text-secondary">Account storage</span>
      <div className="flex items-center gap-2">
        <NodexOptionPicker
          value={storage.kind}
          disabled={disabled}
          options={[
            {
              value: "shared",
              label: "Shared with your user account",
              subText: "Uses the Agent's existing sign-in and history, like its own command line.",
              allowWrap: true,
            },
            {
              value: "separate",
              label: "Separate folder",
              subText:
                "Gives this instance its own home folder for the Agent's sign-in and history.",
              allowWrap: true,
            },
          ]}
          onValueChange={(value) =>
            onChange(value === "separate" ? { kind: "separate", home: "" } : { kind: "shared" })
          }
          triggerButton={
            <NodexSettingsDropdownTrigger aria-label="Account storage" className="shrink-0">
              {storage.kind === "separate" ? "Separate folder" : "Shared with your user account"}
            </NodexSettingsDropdownTrigger>
          }
        />
        {storage.kind === "separate" ? (
          <Input
            {...problems.control("home")}
            aria-label="Separate account folder"
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            placeholder="/absolute/path"
            spellCheck={false}
            value={storage.home}
            disabled={disabled}
            onChange={(event) => onChange({ kind: "separate", home: event.target.value })}
          />
        ) : null}
      </div>
      {problems.message("home")}
      <span className="text-xs text-token-description-foreground">
        Can't be changed later. Add another instance for another account.
      </span>
    </div>
  );
}

function RegistryIcon({ agent }: { readonly agent: AcpRegistryAgent }) {
  const [failed, setFailed] = useState(false);
  const url = acpRegistryIconUrl(agent.icon);
  return url && !failed ? (
    <img
      src={url}
      alt=""
      className="size-5 shrink-0 rounded-[4px] dark:invert"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <SettingsAgentIcon className="icon-sm shrink-0 text-token-text-secondary" />
  );
}

function RegistryResults({
  owner,
  onChoose,
}: {
  readonly owner: AcpAgentsOwner;
  readonly onChoose: (agent: AcpRegistryAgent) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{
    readonly query: string;
    readonly agents: readonly AcpRegistryAgent[] | null;
    readonly failure: AcpFailure | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      () => {
        void owner.search(query.trim()).then((result) => {
          if (!active) return;
          setResults(
            result.ok
              ? { query, agents: result.value.agents, failure: null }
              : { query, agents: null, failure: result.error },
          );
        });
      },
      // The full list loads at once; typing waits for a short pause.
      query ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [owner, query]);
  const loading = results === null || results.query !== query;
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 icon-xs -translate-y-1/2 text-token-description-foreground" />
        <Input
          aria-label="Search the ACP Registry"
          autoFocus
          className="h-9 ps-8 text-sm"
          placeholder="Search the ACP Registry"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div
        role="list"
        aria-label="Registry Agents"
        aria-busy={loading}
        className="-mx-1 flex h-72 flex-col overflow-y-auto"
      >
        {results?.failure ? (
          <p role="alert" className="px-2 py-3 text-sm text-danger">
            {acpFailureText(results.failure, "install")}
          </p>
        ) : results?.agents?.length === 0 ? (
          <p className="px-2 py-3 text-sm text-token-description-foreground">
            {loading ? "Searching…" : `No Agents match “${results.query}”.`}
          </p>
        ) : results === null ? (
          <p className="px-2 py-3 text-sm text-token-description-foreground">Loading Registry…</p>
        ) : (
          results.agents?.map((agent) => {
            const unavailable = acpRegistryUnavailableText(agent);
            return (
              <div role="listitem" key={agent.id}>
                <button
                  type="button"
                  className="flex w-full cursor-interaction items-start gap-2.5 rounded-lg px-2 py-2 text-start outline-hidden hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background"
                  onClick={() => onChoose(agent)}
                >
                  <RegistryIcon agent={agent} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-sm font-medium text-token-text-primary">
                        {agent.name}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-token-description-foreground">
                        v{agent.version}
                      </span>
                    </span>
                    <span className="line-clamp-1 text-xs text-token-text-secondary">
                      {agent.description}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 pt-0.5 text-xs",
                      unavailable ? "text-danger" : "text-token-description-foreground",
                    )}
                  >
                    {unavailable ??
                      (agent.distribution ? acpDistributionLabel(agent.distribution) : null)}
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function PreviewDetails({ preview }: { readonly preview: AcpInstallPreview }) {
  const rows: [string, string][] = [
    ...(preview.packageSpec ? ([["Package", preview.packageSpec]] as [string, string][]) : []),
    ...(preview.archiveUrl ? ([["Download", preview.archiveUrl]] as [string, string][]) : []),
    [
      "Integrity",
      preview.sha256
        ? `SHA-256 ${preview.sha256.slice(0, 16)}…`
        : "As published by the Registry (no checksum)",
    ],
    ...(preview.runner
      ? ([
          [
            "Runs with",
            preview.runnerPath
              ? `${acpRunnerLabel(preview.runner)} · ${preview.runnerPath}`
              : acpRunnerLabel(preview.runner),
          ],
        ] as [string, string][])
      : []),
    ["Installs to", preview.installDirectory],
  ];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-xs ring-[0.5px] ring-token-border ring-inset">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-token-description-foreground">{term}</dt>
          <dd className="font-mono break-all text-token-text-secondary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RegistryReview({
  agent,
  owner,
  takenNames,
  pending,
  onBack,
  onSubmit,
}: {
  readonly agent: AcpRegistryAgent;
  readonly owner: AcpAgentsOwner;
  readonly takenNames: readonly string[];
  readonly pending: boolean;
  readonly onBack: () => void;
  readonly onSubmit: (input: {
    readonly name: string;
    readonly distribution: AcpDistributionChoice;
    readonly storage: Storage;
    readonly preview: AcpInstallPreview;
  }) => void;
}) {
  const [name, setName] = useState(() => acpInstanceName(agent.name, takenNames));
  const [distribution, setDistribution] = useState<AcpDistributionChoice>("auto");
  const [storage, setStorage] = useState<Storage>({ kind: "shared" });
  const [preview, setPreview] = useState<{
    readonly distribution: AcpDistributionChoice;
    readonly value: AcpInstallPreview | null;
    readonly failure: AcpFailure | null;
  } | null>(null);
  const formId = useId();
  useEffect(() => {
    let active = true;
    void owner.previewInstall(agent.id, distribution).then((result) => {
      if (!active) return;
      setPreview(
        result.ok
          ? { distribution, value: result.value, failure: null }
          : { distribution, value: null, failure: result.error },
      );
    });
    return () => {
      active = false;
    };
  }, [owner, agent.id, distribution]);
  const current = preview?.distribution === distribution ? preview : null;
  const unavailable =
    current?.value && !current.value.available
      ? (acpAvailabilityText(current.value.reason, current.value.runner) ?? "Not available here")
      : null;
  const problems = useFieldProblem(
    !name.trim() ? { field: "name", message: "Enter a name." } : storageProblem(storage),
  );
  const installable = current?.value?.available === true ? current.value : null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !installable || !problems.allows(event.currentTarget)) return;
    onSubmit({ name: name.trim(), distribution, storage, preview: installable });
  };
  const meta = [agent.authors.length ? agent.authors.join(", ") : null, agent.license].filter(
    Boolean,
  );
  return (
    <NodexDialogForm id={formId} onSubmit={submit} className="gap-0">
      <NodexDialogHeader>
        <div className="flex items-center gap-2">
          <NodexIconButton size="sm" icon={BackIcon} ariaLabel="Back to search" onClick={onBack} />
          <RegistryIcon agent={agent} />
          <NodexDialogTitle className="truncate">{agent.name}</NodexDialogTitle>
          <span className="text-sm tabular-nums text-token-description-foreground">
            v{agent.version}
          </span>
        </div>
        <NodexDialogDescription className="text-sm">{agent.description}</NodexDialogDescription>
        {meta.length || agent.website || agent.repository ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-token-description-foreground">
            {meta.length ? <span>{meta.join(" · ")}</span> : null}
            {[agent.website, agent.repository]
              .filter((link): link is string => Boolean(link))
              .map((link) => (
                <button
                  key={link}
                  type="button"
                  className="inline-flex cursor-interaction items-center gap-1 hover:text-token-text-primary"
                  onClick={() => void openExternalUrl(link)}
                >
                  <OpenExternalIcon className="icon-xxs" />
                  {new URL(link).hostname}
                </button>
              ))}
          </div>
        ) : null}
      </NodexDialogHeader>
      <NodexDialogBody className="gap-3">
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <Labeled label="Name" problem={problems.message("name")}>
              <Input
                {...problems.control("name")}
                aria-label="Name"
                className="h-8 text-sm"
                maxLength={128}
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </Labeled>
          </div>
          <Labeled label="Distribution">
            <NodexOptionPicker
              value={distribution}
              disabled={pending}
              options={[
                { value: "auto", label: "Automatic" },
                ...agent.distributions.map((entry) => ({
                  value: entry.kind,
                  label: acpDistributionLabel(entry.kind),
                  disabled: !entry.available,
                  ...(entry.available
                    ? {}
                    : { subText: acpAvailabilityText(entry.reason, entry.runner) }),
                })),
              ]}
              onValueChange={(value) => setDistribution(value as AcpDistributionChoice)}
              triggerButton={
                <NodexSettingsDropdownTrigger aria-label="Distribution">
                  {acpDistributionLabel(distribution)}
                </NodexSettingsDropdownTrigger>
              }
            />
          </Labeled>
        </div>
        <StorageField
          storage={storage}
          disabled={pending}
          problems={problems}
          onChange={setStorage}
        />
        {current?.value ? (
          <PreviewDetails preview={current.value} />
        ) : current?.failure ? (
          <p role="alert" className="text-xs text-danger">
            {acpFailureText(current.failure, "install")}
          </p>
        ) : (
          <p className="text-xs text-token-description-foreground">Checking installation…</p>
        )}
        {unavailable ? (
          <p role="alert" className="text-xs text-danger">
            {unavailable}
          </p>
        ) : null}
      </NodexDialogBody>
      <NodexDialogFooter className="justify-between">
        <span className="min-w-0 text-xs text-token-description-foreground">
          Installs privately for Nodex, then connects to read its models.
        </span>
        <NodexDialogAction type="submit" tone="primary" disabled={pending || !installable}>
          {pending ? "Adding…" : "Install and connect"}
        </NodexDialogAction>
      </NodexDialogFooter>
    </NodexDialogForm>
  );
}

function LocalCommandForm({
  takenNames,
  pending,
  onSubmit,
}: {
  readonly takenNames: readonly string[];
  readonly pending: boolean;
  readonly onSubmit: (input: {
    readonly name: string;
    readonly executable: string;
    readonly args: string[];
    readonly storage: Storage;
    readonly identity: string | null;
  }) => void;
}) {
  const [name, setName] = useState(() => acpInstanceName("Local Agent", takenNames));
  const [executable, setExecutable] = useState("");
  const [args, setArgs] = useState<AcpArgumentDraft[]>([]);
  const [storage, setStorage] = useState<Storage>({ kind: "shared" });
  const [identity, setIdentity] = useState("");
  const executableIssue = AcpAgentSourceSchema.safeParse({
    kind: "local",
    executable,
    args: [],
  }).error?.issues[0];
  const argumentProblem = acpArgumentProblem(args.map(({ value }) => value));
  const problems = useFieldProblem(
    !name.trim()
      ? { field: "name", message: "Enter a name." }
      : !executable.trim()
        ? { field: "executable", message: "Enter the executable to run." }
        : executableIssue
          ? { field: "executable", message: executableIssue.message }
          : argumentProblem
            ? { field: "arguments", message: argumentProblem.message }
            : identity.trim() && !ACP_REGISTRY_ID_PATTERN.test(identity.trim())
              ? {
                  field: "identity",
                  message:
                    "A Registry ID uses lowercase letters, digits, dots, dashes and underscores.",
                }
              : storageProblem(storage),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !problems.allows(event.currentTarget)) return;
    onSubmit({
      name: name.trim(),
      executable: executable.trim(),
      args: args.map(({ value }) => value),
      storage,
      identity: identity.trim() || null,
    });
  };
  return (
    <form id="acp-local-command" className="flex flex-col gap-3" onSubmit={submit}>
      <div className="flex gap-3">
        <div className="w-40 shrink-0">
          <Labeled label="Name" problem={problems.message("name")}>
            <Input
              {...problems.control("name")}
              aria-label="Name"
              className="h-8 text-sm"
              maxLength={128}
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Labeled>
        </div>
        <div className="min-w-0 flex-1">
          <Labeled label="Executable" problem={problems.message("executable")}>
            <Input
              {...problems.control("executable")}
              aria-label="Executable"
              autoFocus
              className="h-8 font-mono text-xs"
              placeholder="qoder or /absolute/path/to/agent"
              spellCheck={false}
              value={executable}
              disabled={pending}
              onChange={(event) => setExecutable(event.target.value)}
            />
          </Labeled>
        </div>
      </div>
      <div role="group" aria-label="Arguments" className="flex flex-col gap-1 text-sm">
        <span className="text-token-text-secondary">Arguments</span>
        <AcpArgumentsEditor
          value={args}
          disabled={pending}
          marked={
            argumentProblem
              ? { index: argumentProblem.index, props: problems.control("arguments") }
              : null
          }
          onChange={setArgs}
        />
        {problems.message("arguments")}
        <span className="text-xs text-token-description-foreground">
          Each passed exactly as written, without a shell. Include the Agent's ACP flag, such as
          --acp.
        </span>
      </div>
      <StorageField
        storage={storage}
        disabled={pending}
        problems={problems}
        onChange={setStorage}
      />
      <Labeled
        label="Registry ID (optional)"
        hint="For a locally installed Registry Agent, enables its compatibility features."
        problem={problems.message("identity")}
      >
        <Input
          {...problems.control("identity")}
          aria-label="Registry ID"
          className="h-8 font-mono text-xs"
          placeholder="claude-acp"
          spellCheck={false}
          value={identity}
          disabled={pending}
          onChange={(event) => setIdentity(event.target.value)}
        />
      </Labeled>
    </form>
  );
}

/**
 * Adds an ACP instance from the Registry or a local command. Saving creates the instance; its
 * install and connection then continue in Settings even if this dialog closes.
 */
export function AcpAgentAddDialog({ owner, onAdded, onClose }: AcpAgentAddDialogProps) {
  const snapshot = useAcpAgents(owner);
  const [tab, setTab] = useState<"registry" | "local">("registry");
  const [chosen, setChosen] = useState<AcpRegistryAgent | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takenNames = (snapshot.settings?.instances ?? []).map(({ displayName }) => displayName);

  const create = async (instance: AcpAgentInstanceInput, then: () => void) => {
    setPending(true);
    setError(null);
    const outcome = await owner.addInstance(instance);
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    then();
    onAdded?.(instance.id);
    onClose();
  };

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <NodexDialogContent
        size="wide"
        // The dialog outlives its trigger, so focus returns to Add Agent by identity.
        finalFocus={() => document.getElementById(ACP_ADD_AGENT_ID) ?? true}
      >
        {chosen ? (
          <RegistryReview
            agent={chosen}
            owner={owner}
            takenNames={takenNames}
            pending={pending}
            onBack={() => setChosen(null)}
            onSubmit={({ name, distribution, storage, preview }) => {
              const id = crypto.randomUUID();
              void create(
                {
                  id,
                  agentDefinitionId: chosen.id,
                  displayName: name,
                  enabled: true,
                  source: { kind: "registry", agentId: chosen.id, distribution },
                  environment: [],
                  credentials: storageCredentials(storage),
                  proxy: "inherit-host",
                  customModels: [],
                },
                () =>
                  owner.install(
                    id,
                    {
                      agentId: chosen.id,
                      distribution,
                      expectedInstallationId: preview.installationId,
                    },
                    "connect",
                  ),
              );
            }}
          />
        ) : (
          <NodexTabsRoot
            className="flex flex-col px-5 py-5"
            value={tab}
            onValueChange={(value: typeof tab) => setTab(value)}
          >
            <NodexDialogHeader>
              <NodexDialogTitle>Add Agent</NodexDialogTitle>
              <NodexTabsList aria-label="Agent source" className="flex gap-1 pt-1">
                {(
                  [
                    ["registry", "ACP Registry"],
                    ["local", "Local command"],
                  ] as const
                ).map(([value, label]) => (
                  <NodexTabsTab
                    key={value}
                    value={value}
                    className="cursor-interaction rounded-md px-2.5 py-1 text-sm text-token-description-foreground outline-hidden hover:bg-token-list-hover-background focus-visible:ring-2 focus-visible:ring-token-focus-border data-active:bg-token-foreground/8 data-active:text-token-text-primary data-active:hover:bg-token-foreground/8"
                  >
                    {label}
                  </NodexTabsTab>
                ))}
              </NodexTabsList>
            </NodexDialogHeader>
            <NodexDialogBody>
              {/* Each source's first field takes focus when chosen, so its panel isn't a tab stop. */}
              <NodexTabsPanel value="registry" tabIndex={-1} className="outline-hidden">
                <RegistryResults owner={owner} onChoose={setChosen} />
              </NodexTabsPanel>
              <NodexTabsPanel value="local" tabIndex={-1} className="outline-hidden">
                <LocalCommandForm
                  takenNames={takenNames}
                  pending={pending}
                  onSubmit={({ name, executable, args, storage, identity }) => {
                    const id = crypto.randomUUID();
                    void create(
                      {
                        id,
                        agentDefinitionId: identity ?? acpLocalAgentIdentity(id),
                        displayName: name,
                        enabled: true,
                        source: { kind: "local", executable, args },
                        environment: [],
                        credentials: storageCredentials(storage),
                        proxy: "inherit-host",
                        customModels: [],
                      },
                      () => owner.connect(id),
                    );
                  }}
                />
              </NodexTabsPanel>
            </NodexDialogBody>
            {tab === "local" ? (
              <NodexDialogFooter>
                <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
                <NodexDialogAction
                  type="submit"
                  form="acp-local-command"
                  tone="primary"
                  disabled={pending}
                >
                  {pending ? "Adding…" : "Add and connect"}
                </NodexDialogAction>
              </NodexDialogFooter>
            ) : null}
          </NodexTabsRoot>
        )}
        {error ? (
          <p role="alert" className="px-5 pb-4 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </NodexDialogContent>
    </NodexDialog>
  );
}

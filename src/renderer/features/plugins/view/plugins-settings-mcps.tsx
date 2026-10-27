import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { TrashIcon } from "@/components/shared/icons/customize-action-icons";
import {
  ExternalLinkIcon,
  GearIcon20,
  PlusMdIcon,
} from "@/components/shared/icons/plugin-detail-icons";
import { NodexSwitch } from "@/components/ui/button";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { NodexSettingsRow, NodexSettingsSection } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/file-system-operations";
import { cn } from "@/lib/utils";
import type { McpServerOauthLoginParams } from "@nodex/codex-app-server-protocol/v2/McpServerOauthLoginParams";
import type {
  PluginMcpDeclaration,
  PluginMcpServer,
} from "../../../../shared/codex-plugin-settings";
import {
  capitalizeLowercaseName,
  mcpServerDeclaration,
  mcpServerForm,
  mcpServerFormComplete,
  mcpServerKey,
  NEW_MCP_SERVER,
  type KeyValuePair,
  type McpServerForm,
} from "../model/mcp-server-form";
import { pluginMutationSucceeded } from "../model/mutation-result";
import {
  useMcpAppDataCapabilities,
  useMcpOauthCompletion,
  usePluginManagement,
  usePluginMcpServers,
  type PluginContext,
} from "../plugin-management";

const MCP_DOCS_URL = "https://developers.openai.com/codex/mcp/";
const MCP_INPUT_CLASS = "h-9 text-sm";
type ClientRegistration = NonNullable<McpServerOauthLoginParams["clientRegistration"]> | "auto";

const REGISTRATION_LABELS: Record<ClientRegistration, { short: string; full: string }> = {
  auto: { short: "Auto", full: "Automatic" },
  cimd: { short: "CIMD", full: "Client ID metadata document (CIMD)" },
  dcr: { short: "DCR", full: "Dynamic client registration (DCR)" },
};

/**
 * One MCP server: Authenticate while it needs a sign-in (with a choice of how to register the
 * OAuth client), its settings, and its switch. Plugin servers only authenticate.
 */
function McpServerRow({
  server,
  authenticating,
  starting,
  onAuthenticate,
  onEdit,
  onSetEnabled,
}: {
  readonly server: PluginMcpServer;
  readonly authenticating: boolean;
  readonly starting: boolean;
  readonly onAuthenticate: (registration: ClientRegistration) => void;
  readonly onEdit?: () => void;
  readonly onSetEnabled?: (enabled: boolean) => void;
}) {
  const [registration, setRegistration] = useState<ClientRegistration>("auto");
  const needsAuth = server.status?.authStatus === "notLoggedIn";
  const name = server.declaration?.name;
  return (
    <NodexSettingsRow
      className="max-sm:flex-col max-sm:items-stretch"
      label={typeof name === "string" && name.length > 0 ? name : server.name}
    >
      {needsAuth ? (
        <>
          <NodexDropdownMenu
            align="end"
            disabled={authenticating}
            triggerButton={
              <ToolbarButton
                color="outline"
                disabled={authenticating}
                aria-label={`OAuth client registration: ${REGISTRATION_LABELS[registration].full}`}
              >
                {REGISTRATION_LABELS[registration].short}
              </ToolbarButton>
            }
          >
            {(Object.keys(REGISTRATION_LABELS) as ClientRegistration[]).map((option) => (
              <NodexDropdownItem key={option} onSelect={() => setRegistration(option)}>
                {REGISTRATION_LABELS[option].full}
              </NodexDropdownItem>
            ))}
          </NodexDropdownMenu>
          <ToolbarButton
            color="outline"
            disabled={starting}
            onClick={() => onAuthenticate(registration)}
          >
            {starting ? "Starting…" : "Authenticate"}
          </ToolbarButton>
        </>
      ) : null}
      {onEdit == null ? null : (
        <NodexTooltip tooltipContent="Settings" side="top">
          <ToolbarButton
            color="ghost"
            uniform
            aria-label="Settings"
            disabled={server.readOnly}
            onClick={onEdit}
          >
            <GearIcon20 className="icon-sm" />
          </ToolbarButton>
        </NodexTooltip>
      )}
      {onSetEnabled == null ? null : (
        <NodexSwitch
          ariaLabel="Enable"
          checked={server.enabled}
          disabled={server.readOnly}
          onCheckedChange={onSetEnabled}
        />
      )}
    </NodexSettingsRow>
  );
}

/** A labeled field box: one text input, or a list of inputs or key/value pairs. */
function McpField({
  title,
  list = false,
  children,
}: {
  readonly title: string;
  readonly list?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg bg-(--color-background-primary-soft) px-3 py-2",
        list ? "gap-3" : "gap-2",
      )}
    >
      <p className="text-base font-medium text-token-foreground">{title}</p>
      {children}
    </div>
  );
}

function McpListField({
  title,
  values,
  addLabel,
  onChange,
}: {
  readonly title: string;
  readonly values: readonly string[];
  readonly addLabel: string;
  readonly onChange: (values: string[]) => void;
}) {
  const rows = values.length > 0 ? values : [""];
  return (
    <McpField title={title} list>
      <div className="flex flex-col gap-2">
        {rows.map((value, index) => (
          <div key={`item-${index}`} className="flex items-center gap-2">
            <Input
              className={MCP_INPUT_CLASS}
              value={value}
              onChange={(event) => {
                const next = [...rows];
                next[index] = event.target.value;
                onChange(next);
              }}
            />
            <ToolbarButton
              color="ghost"
              size="icon"
              aria-label="Remove entry"
              disabled={values.length === 0}
              onClick={() => onChange(values.filter((_, other) => other !== index))}
            >
              <TrashIcon className="icon-2xs" />
            </ToolbarButton>
          </div>
        ))}
      </div>
      <AddEntryButton label={addLabel} onClick={() => onChange([...values, ""])} />
    </McpField>
  );
}

function McpPairsField({
  title,
  pairs,
  addLabel,
  onChange,
}: {
  readonly title: string;
  readonly pairs: readonly KeyValuePair[];
  readonly addLabel: string;
  readonly onChange: (pairs: KeyValuePair[]) => void;
}) {
  const rows = pairs.length > 0 ? pairs : [{ key: "", value: "" }];
  return (
    <McpField title={title} list>
      <div className="flex flex-col gap-2">
        {rows.map((pair, index) => (
          <div key={`pair-${index}`} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
            <Input
              className={MCP_INPUT_CLASS}
              placeholder="Key"
              value={pair.key}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...pair, key: event.target.value };
                onChange(next);
              }}
            />
            <Input
              className={MCP_INPUT_CLASS}
              placeholder="Value"
              value={pair.value}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...pair, value: event.target.value };
                onChange(next);
              }}
            />
            <ToolbarButton
              color="ghost"
              size="icon"
              aria-label="Remove entry"
              disabled={
                rows.length <= 1 && pair.key.trim().length === 0 && pair.value.trim().length === 0
              }
              onClick={() => onChange(rows.filter((_, other) => other !== index))}
            >
              <TrashIcon className="icon-2xs" />
            </ToolbarButton>
          </div>
        ))}
      </div>
      <AddEntryButton
        label={addLabel}
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      />
    </McpField>
  );
}

function AddEntryButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <ToolbarButton
      color="secondary"
      className="justify-center rounded-md border-dashed border-transparent text-(--color-text-secondary)/90"
      onClick={onClick}
    >
      <PlusMdIcon />
      {label}
    </ToolbarButton>
  );
}

/**
 * Adding or editing an MCP server, in place of the server list: its name and transport for a new
 * server, then the command or URL and their options. An existing server can be uninstalled.
 */
function McpServerEditor({
  server,
  existingKeys,
  context,
  onClose,
}: {
  readonly server: PluginMcpServer | null;
  readonly existingKeys: readonly string[];
  readonly context: PluginContext;
  readonly onClose: () => void;
}) {
  const management = usePluginManagement(context);
  const declaration: PluginMcpDeclaration = server?.declaration ?? NEW_MCP_SERVER;
  const [initial] = useState(() => mcpServerForm(declaration, server?.name ?? ""));
  const [form, setForm] = useState<McpServerForm>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isExisting = server != null;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const canSave = mcpServerFormComplete(form) && dirty && !submitting;

  const run = async (action: () => Promise<boolean>, fallback: string) => {
    setError(null);
    setSubmitting(true);
    try {
      if (await action()) onClose();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback,
      );
    } finally {
      setSubmitting(false);
    }
  };
  const save = () =>
    run(async () => {
      const name = isExisting ? server.name : mcpServerKey(form.label, existingKeys);
      const result = await management.saveMcpServer({
        name,
        ...(isExisting ? { previousName: server.name } : {}),
        declaration: mcpServerDeclaration(form),
      });
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      return true;
    }, "Could not save MCP server");
  const uninstall = () =>
    run(async () => {
      if (server == null) return false;
      const result = await management.removeMcpServer({ name: server.name });
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      return true;
    }, "Could not uninstall MCP server");

  const setStdio = (patch: Partial<McpServerForm["stdio"]>) =>
    setForm((current) => ({ ...current, stdio: { ...current.stdio, ...patch } }));
  const setHttp = (patch: Partial<McpServerForm["http"]>) =>
    setForm((current) => ({ ...current, http: { ...current.http, ...patch } }));

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center pb-(--padding-panel)">
        <ToolbarButton color="ghost" onClick={onClose}>
          <span aria-hidden>←</span>
          Back
        </ToolbarButton>
      </div>
      <div className="flex flex-col gap-(--padding-panel)">
        <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
            <h2 className="heading-base min-w-0 break-words text-token-foreground">
              {isExisting
                ? `Update ${capitalizeLowercaseName(server.name)} MCP`
                : "Connect to a custom MCP"}
            </h2>
            {isExisting ? null : (
              <div className="text-base text-balance text-(--color-text-secondary)">
                <a
                  href={MCP_DOCS_URL}
                  aria-label="Open MCP documentation"
                  className="inline-flex items-center gap-1 text-sm hover:text-token-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    void openExternalUrl(MCP_DOCS_URL);
                  }}
                >
                  Docs
                  <ExternalLinkIcon className="icon-xxs" />
                </a>
              </div>
            )}
          </div>
          {isExisting ? (
            <ToolbarButton
              color="outline"
              disabled={submitting}
              className="border-(--color-text-danger) bg-transparent text-(--color-text-danger)"
              onClick={() => void uninstall()}
            >
              <TrashIcon className="icon-xs" />
              Uninstall
            </ToolbarButton>
          ) : null}
        </header>
        <div className={cn("relative flex flex-col gap-1.5", submitting && "pointer-events-none")}>
          {submitting ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-(--color-surface)/60">
              <ActivitySpinnerIcon className="icon-sm" />
            </div>
          ) : null}
          {isExisting ? (
            <p className="text-sm text-(--color-text-secondary)">
              If you would like to switch MCP server type, please uninstall first.
            </p>
          ) : (
            <NodexSettingsSection>
              <McpField title="Name">
                <Input
                  className={MCP_INPUT_CLASS}
                  placeholder="MCP server name"
                  value={form.label}
                  onChange={(event) => setForm({ ...form, label: event.target.value })}
                />
              </McpField>
              <NodexSettingsRow label="Type">
                <div role="group" aria-label="MCP server type" className="inline-flex gap-0.5">
                  {(
                    [
                      ["stdio", "STDIO"],
                      ["streamable_http", "Streamable HTTP"],
                    ] as const
                  ).map(([id, label]) => (
                    <ToolbarButton
                      key={id}
                      color="ghost"
                      aria-pressed={form.transport === id}
                      className={cn(
                        form.transport === id &&
                          "bg-[color-mix(in_oklab,var(--color-text)_5%,transparent)] text-token-foreground",
                      )}
                      onClick={() => setForm({ ...form, transport: id })}
                    >
                      {label}
                    </ToolbarButton>
                  ))}
                </div>
              </NodexSettingsRow>
            </NodexSettingsSection>
          )}
          <NodexSettingsSection>
            {form.transport === "stdio" ? (
              <>
                <McpField title="Command to launch">
                  <Input
                    className={MCP_INPUT_CLASS}
                    placeholder="openai-dev-mcp serve-sqlite"
                    value={form.stdio.command}
                    onChange={(event) => setStdio({ command: event.target.value })}
                  />
                </McpField>
                <McpListField
                  title="Arguments"
                  values={form.stdio.args}
                  addLabel="Add argument"
                  onChange={(args) => setStdio({ args })}
                />
                <McpPairsField
                  title="Environment variables"
                  pairs={form.stdio.env}
                  addLabel="Add environment variable"
                  onChange={(env) => setStdio({ env })}
                />
                <McpListField
                  title="Environment variable passthrough"
                  values={form.stdio.envVars}
                  addLabel="Add variable"
                  onChange={(envVars) => setStdio({ envVars })}
                />
                <McpField title="Working directory">
                  <Input
                    className={MCP_INPUT_CLASS}
                    placeholder="~/code"
                    value={form.stdio.cwd}
                    onChange={(event) => setStdio({ cwd: event.target.value })}
                  />
                </McpField>
              </>
            ) : (
              <>
                <McpField title="URL">
                  <Input
                    className={MCP_INPUT_CLASS}
                    placeholder="https://mcp.example.com/mcp"
                    value={form.http.url}
                    onChange={(event) => setHttp({ url: event.target.value })}
                  />
                </McpField>
                <McpField title="Bearer token env var">
                  <Input
                    className={MCP_INPUT_CLASS}
                    placeholder="MCP_BEARER_TOKEN"
                    value={form.http.bearerTokenEnvVar}
                    onChange={(event) => setHttp({ bearerTokenEnvVar: event.target.value })}
                  />
                </McpField>
                <McpPairsField
                  title="Headers"
                  pairs={form.http.httpHeaders}
                  addLabel="Add header"
                  onChange={(httpHeaders) => setHttp({ httpHeaders })}
                />
                <McpPairsField
                  title="Headers from environment variables"
                  pairs={form.http.envHttpHeaders}
                  addLabel="Add variable"
                  onChange={(envHttpHeaders) => setHttp({ envHttpHeaders })}
                />
              </>
            )}
          </NodexSettingsSection>
          {error == null ? null : (
            <p
              role="alert"
              className="rounded-md bg-(--color-background-danger-surface)/20 px-3 py-2 text-sm text-danger"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <ToolbarButton color="primary" disabled={!canSave} onClick={() => void save()}>
              Save
            </ToolbarButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The MCPs tab: your configured servers with their settings and switches, then servers that
 * plugins provide. Adding or editing a server replaces the lists until it is saved or left.
 */
export function McpServersTab({
  context,
  search,
  adding,
  onAddingChange,
}: {
  readonly context: PluginContext;
  readonly search: string;
  readonly adding: boolean;
  readonly onAddingChange: (adding: boolean) => void;
}) {
  const servers = usePluginMcpServers(context);
  const management = usePluginManagement(context);
  const oauthCompletion = useMcpOauthCompletion(context);
  const [editing, setEditing] = useState<PluginMcpServer | null>(null);
  const [authUrls, setAuthUrls] = useState<Record<string, string | null>>({});

  // A finished sign-in clears that server's pending authorization.
  const seenCompletion = useRef(oauthCompletion.data);
  useEffect(() => {
    const completion = oauthCompletion.data;
    if (completion == null || completion === seenCompletion.current) return;
    seenCompletion.current = completion;
    setAuthUrls((current) => {
      const next = { ...current };
      delete next[completion.name];
      return next;
    });
  }, [oauthCompletion.data]);

  const all = servers.data?.servers ?? [];
  if (adding || editing != null) {
    return (
      <McpServerEditor
        key={editing?.name ?? "new"}
        server={editing}
        existingKeys={all.map((server) => server.name)}
        context={context}
        onClose={() => {
          setEditing(null);
          onAddingChange(false);
        }}
      />
    );
  }

  const query = search.trim().toLowerCase();
  const matches = (server: PluginMcpServer) =>
    query.length === 0 ||
    [server.name, typeof server.declaration?.name === "string" ? server.declaration.name : ""].some(
      (value) => value.toLowerCase().includes(query),
    );
  const configured = all
    .filter((server) => server.declaration != null && server.pluginId == null)
    .filter(matches);
  const fromPlugins = all.filter((server) => server.declaration == null).filter(matches);
  const noResults = query.length > 0 && configured.length === 0 && fromPlugins.length === 0;

  const authenticate = async (server: PluginMcpServer, registration: ClientRegistration) => {
    const existing = authUrls[server.name];
    if (existing) {
      void openExternalUrl(existing);
      return;
    }
    setAuthUrls((current) => ({ ...current, [server.name]: null }));
    const fail = () => {
      setAuthUrls((current) => {
        const next = { ...current };
        delete next[server.name];
        return next;
      });
      toast.danger(`Couldn’t connect to MCP server “${server.name}”. Try again.`);
    };
    try {
      const result = await management.loginMcpServer({
        name: server.name,
        ...(registration === "auto" ? {} : { clientRegistration: registration }),
      });
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      const url = result.value.authorizationUrl.trim();
      if (url.length === 0) throw new Error("MCP OAuth login returned an empty authorization URL");
      setAuthUrls((current) => ({ ...current, [server.name]: url }));
      void openExternalUrl(url);
    } catch {
      fail();
    }
  };
  const setEnabled = async (server: PluginMcpServer, enabled: boolean) => {
    const result = await management.setMcpServerEnabled({ name: server.name, enabled });
    if (!pluginMutationSucceeded(result)) toast.danger("Failed to update MCP server");
  };
  const row = (server: PluginMcpServer, editable: boolean) => (
    <McpServerRow
      key={server.name}
      server={server}
      authenticating={Object.hasOwn(authUrls, server.name)}
      starting={Object.hasOwn(authUrls, server.name) && authUrls[server.name] == null}
      onAuthenticate={(registration) => void authenticate(server, registration)}
      onEdit={editable ? () => setEditing(server) : undefined}
      onSetEnabled={editable ? (enabled) => void setEnabled(server, enabled) : undefined}
    />
  );

  if (servers.isPending) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 py-2 text-sm text-(--color-text-secondary)"
      >
        <ActivitySpinnerIcon className="icon-xs shrink-0" />
        Loading settings…
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-(--padding-panel)">
      <NodexSettingsSection title="Servers">
        {noResults ? (
          <NodexSettingsRow label="No MCP servers found">{null}</NodexSettingsRow>
        ) : configured.length > 0 ? (
          configured.map((server) => row(server, true))
        ) : (
          <NodexSettingsRow label="No MCP servers connected">{null}</NodexSettingsRow>
        )}
      </NodexSettingsSection>
      {!noResults && fromPlugins.length > 0 ? (
        <NodexSettingsSection title="From plugins">
          {fromPlugins.map((server) => row(server, false))}
        </NodexSettingsSection>
      ) : null}
      <McpAppsDataSection context={context} />
    </div>
  );
}

/** Clears what interactive MCP apps saved in their browser sessions, without asking first. */
function McpAppsDataSection({ context }: { readonly context: PluginContext }) {
  const capabilities = useMcpAppDataCapabilities(context);
  const management = usePluginManagement(context);
  const [clearing, setClearing] = useState(false);
  if (capabilities.data?.available !== true) return null;

  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      const result = await management.clearMcpAppData();
      if (pluginMutationSucceeded(result)) toast.success("MCP app data cleared");
      else toast.danger("Unable to clear MCP app data");
    } finally {
      setClearing(false);
    }
  };
  return (
    <NodexSettingsSection title="MCP Apps">
      <NodexSettingsRow label="App data" description="Clear site data and cache from all MCP apps">
        <ToolbarButton color="secondary" loading={clearing} onClick={() => void clear()}>
          Clear all app data
        </ToolbarButton>
      </NodexSettingsRow>
    </NodexSettingsSection>
  );
}

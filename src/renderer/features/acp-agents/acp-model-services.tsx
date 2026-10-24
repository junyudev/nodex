import { useEffect, useState, type FormEvent } from "react";
import { NodexButton } from "@/components/ui/button";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { NodexSettingsRow } from "@/components/ui/settings";
import type { AcpFailure } from "../../../shared/acp-api";
import { acpFailureText, type AcpModelService } from "./acp-agent-model";
import type { AcpAgentsOwner } from "./acp-agents-owner";

interface HeaderRow {
  readonly id: string;
  readonly name: string;
  readonly value: string;
}

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
};

function ServiceForm({
  service,
  pending,
  onCancel,
  onSave,
}: {
  readonly service: AcpModelService;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSave: (input: {
    apiType: string;
    baseUrl: string;
    headers: Record<string, string>;
  }) => void;
}) {
  const [apiType, setApiType] = useState(service.current?.apiType ?? service.supported[0] ?? "");
  const [baseUrl, setBaseUrl] = useState(service.current?.baseUrl ?? "");
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!apiType) return setError("Choose an API type.");
    if (!isHttpUrl(baseUrl.trim()))
      return setError("Enter an http or https URL without credentials.");
    const named = headers.filter((row) => row.name.trim());
    if (new Set(named.map((row) => row.name.trim().toLowerCase())).size !== named.length)
      return setError("Each header name must be unique.");
    setError(null);
    onSave({
      apiType,
      baseUrl: baseUrl.trim(),
      headers: Object.fromEntries(named.map((row) => [row.name.trim(), row.value])),
    });
  };
  return (
    <form className="flex flex-col gap-2 px-4 pb-3" onSubmit={submit}>
      <div className="flex flex-wrap items-center gap-2">
        {service.supported.length > 1 ? (
          <NodexOptionPicker
            value={apiType}
            options={service.supported.map((value) => ({ value, label: value }))}
            onValueChange={setApiType}
            triggerButton={
              <NodexSettingsDropdownTrigger aria-label={`${service.providerId} API type`}>
                {apiType}
              </NodexSettingsDropdownTrigger>
            }
          />
        ) : (
          <span className="text-sm text-token-text-secondary">{apiType}</span>
        )}
        <Input
          aria-label={`${service.providerId} base URL`}
          className="h-8 min-w-0 flex-1 basis-64 font-mono text-xs"
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          value={baseUrl}
          disabled={pending}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </div>
      {headers.map((row, index) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            aria-label={`Header name ${index + 1}`}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            placeholder="Authorization"
            spellCheck={false}
            value={row.name}
            disabled={pending}
            onChange={(event) =>
              setHeaders((current) =>
                current.map((entry) =>
                  entry.id === row.id ? { ...entry, name: event.target.value } : entry,
                ),
              )
            }
          />
          <Input
            aria-label={`Header value ${index + 1}`}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            type="password"
            autoComplete="off"
            value={row.value}
            disabled={pending}
            onChange={(event) =>
              setHeaders((current) =>
                current.map((entry) =>
                  entry.id === row.id ? { ...entry, value: event.target.value } : entry,
                ),
              )
            }
          />
          <NodexButton
            size="sm"
            variant="ghost"
            aria-label={`Remove header ${index + 1}`}
            disabled={pending}
            onClick={() => setHeaders((current) => current.filter(({ id }) => id !== row.id))}
          >
            ×
          </NodexButton>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <NodexButton
          size="sm"
          variant="ghost"
          disabled={pending || headers.length >= 64}
          onClick={() =>
            setHeaders((current) => [...current, { id: crypto.randomUUID(), name: "", value: "" }])
          }
        >
          Add header
        </NodexButton>
        <span className="min-w-0 flex-1 text-xs text-token-description-foreground">
          Headers go to the Agent and are never shown again.
        </span>
        <NodexButton size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </NodexButton>
        <NodexButton type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </NodexButton>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The Agent's own model services (endpoints it calls for models), offered only when the Agent
 * advertises them. Writes go to the Agent's configuration, not to Nodex settings.
 */
export function AcpModelServices({
  instanceId,
  owner,
}: {
  readonly instanceId: string;
  readonly owner: AcpAgentsOwner;
}) {
  const [services, setServices] = useState<readonly AcpModelService[] | null>(null);
  const [failure, setFailure] = useState<AcpFailure | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void owner.listModelServices({ instanceId }).then((result) => {
      if (!active) return;
      if (result.ok) setServices(result.value.providers);
      else setFailure(result.error);
    });
    return () => {
      active = false;
    };
  }, [owner, instanceId]);

  const write = async (
    providerId: string,
    run: () => ReturnType<AcpAgentsOwner["setModelService"]>,
  ) => {
    setPending(providerId);
    setFailure(null);
    const result = await run();
    setPending(null);
    if (result.ok) {
      setServices(result.value.providers);
      setEditing(null);
    } else setFailure(result.error);
  };

  return (
    <div className="flex flex-col">
      <NodexSettingsRow
        label="Model services"
        description="Endpoints this Agent uses for its models. Changes are saved in the Agent's own configuration."
      >
        {services === null && !failure ? (
          <span className="text-xs text-token-description-foreground">Loading…</span>
        ) : null}
      </NodexSettingsRow>
      {services?.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-token-description-foreground">
          The Agent reports no configurable services.
        </p>
      ) : null}
      {services?.map((service) => (
        <div key={service.providerId} className="flex flex-col">
          <NodexSettingsRow
            variant="nested"
            label={service.providerId}
            description={
              <span className="font-mono">
                {service.current
                  ? `${service.current.apiType} · ${service.current.baseUrl}`
                  : "Not configured"}
                {service.required ? " · Required" : ""}
              </span>
            }
          >
            {editing !== service.providerId ? (
              <NodexButton
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => setEditing(service.providerId)}
              >
                {service.current ? "Edit" : "Configure"}
              </NodexButton>
            ) : null}
            {service.current && !service.required ? (
              <NodexButton
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() =>
                  void write(service.providerId, () =>
                    owner.disableModelService({ instanceId, providerId: service.providerId }),
                  )
                }
              >
                {pending === service.providerId && editing !== service.providerId
                  ? "Turning off…"
                  : "Turn off"}
              </NodexButton>
            ) : null}
          </NodexSettingsRow>
          {editing === service.providerId ? (
            <ServiceForm
              service={service}
              pending={pending === service.providerId}
              onCancel={() => setEditing(null)}
              onSave={(input) =>
                void write(service.providerId, () =>
                  owner.setModelService({
                    instanceId,
                    providerId: service.providerId,
                    apiType: input.apiType,
                    baseUrl: input.baseUrl,
                    ...(Object.keys(input.headers).length ? { headers: input.headers } : {}),
                  }),
                )
              }
            />
          ) : null}
        </div>
      ))}
      {failure ? (
        <p role="alert" className="px-4 pb-3 text-xs text-danger">
          {acpFailureText(failure, "model-services")}
        </p>
      ) : null}
    </div>
  );
}

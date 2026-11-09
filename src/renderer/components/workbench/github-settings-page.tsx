import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SourcesSettingsSnapshot, UpdateSourceSettingsInput } from "../../../shared/sources";
import {
  connectGitHubSource,
  readSourcesSettings,
  retrySource,
  updateSourcesSettings,
} from "@/lib/sources";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexCheckbox,
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
} from "@/components/ui/settings";
const queryKey = ["sources-settings"] as const;
const discoveryLabels = {
  assigned: "Assigned to me",
  review_requests: "Review requests",
  mentions: "Mentions",
} as const;
/** GitHub is Nodex’s Source: the account it reads, the repositories it watches, and what it finds. */
export function GitHubSettingsView({
  snapshot,
  pending,
  error,
  onConnect,
  onUpdate,
  onRetry,
}: {
  snapshot: SourcesSettingsSnapshot;
  pending: boolean;
  error: string | null;
  onConnect: () => void;
  onUpdate: (input: UpdateSourceSettingsInput) => void;
  onRetry: (id: string) => void;
}) {
  const source = snapshot.source;
  const change = (
    patch: Partial<Pick<UpdateSourceSettingsInput, "enabled" | "repositories" | "discovery">>,
  ) => {
    if (!source) return;
    onUpdate({
      sourceId: source.id,
      expectedRevision: source.revision,
      enabled: source.enabled,
      repositories: snapshot.repositories.map(({ id, enabled }) => ({ id, enabled })),
      discovery: source.config.discovery,
      ...patch,
    });
  };
  const problem = snapshot.problems[0];
  return (
    <NodexSettingsPageSurface title="GitHub">
      <NodexSettingsSection>
        <NodexSettingsRow
          label="Account"
          description={
            snapshot.connection === "connected" && snapshot.account
              ? `Connected as ${snapshot.account.login}`
              : "Install GitHub CLI and run gh auth login."
          }
        >
          <NodexButton size="sm" variant="secondary" disabled={pending} onClick={onConnect}>
            {snapshot.connection === "connected" ? (source ? "Refresh" : "Connect") : "Reconnect"}
          </NodexButton>
        </NodexSettingsRow>
        {source ? (
          <NodexSettingsRow label="Watch GitHub">
            <NodexSwitch
              ariaLabel="Watch GitHub"
              checked={source.enabled}
              disabled={pending}
              onCheckedChange={(enabled) => change({ enabled })}
            />
          </NodexSettingsRow>
        ) : null}
      </NodexSettingsSection>
      {source ? (
        <>
          <NodexSettingsSection title="Repositories">
            {snapshot.repositories.length ? (
              snapshot.repositories.map((repo) => (
                <NodexSettingsRow key={repo.id} label={repo.name}>
                  <NodexSwitch
                    ariaLabel={`Watch ${repo.name}`}
                    checked={repo.enabled}
                    disabled={pending}
                    onCheckedChange={(enabled) =>
                      change({
                        repositories: snapshot.repositories.map((r) => ({
                          id: r.id,
                          enabled: r.id === repo.id ? enabled : r.enabled,
                        })),
                      })
                    }
                  />
                </NodexSettingsRow>
              ))
            ) : (
              <p className="px-3 py-2 text-sm text-token-text-secondary">
                Add a git repository to a Project.
              </p>
            )}
          </NodexSettingsSection>
          <NodexSettingsSection title="Discovery">
            {Object.entries(discoveryLabels).map(([key, label]) => (
              <NodexSettingsRow key={key} label={label}>
                <NodexCheckbox
                  ariaLabel={label}
                  checked={source.config.discovery[key as keyof typeof discoveryLabels]}
                  disabled={pending}
                  onCheckedChange={(checked) =>
                    change({ discovery: { ...source.config.discovery, [key]: checked } })
                  }
                />
              </NodexSettingsRow>
            ))}
          </NodexSettingsSection>
          <div
            className="flex items-center justify-between gap-3 px-1 text-sm text-token-text-secondary"
            role="status"
          >
            <span>
              {problem
                ? problem.kind === "credential_invalid"
                  ? "GitHub needs to reconnect."
                  : problem.summary === "GitHub returned an unreadable update"
                    ? "Some GitHub activity could not be read."
                    : "GitHub could not be reached."
                : !source.enabled
                  ? "Paused"
                  : snapshot.lastSuccessAtMs
                    ? "Up to date"
                    : "Waiting for first poll"}
            </span>
            {problem ? (
              <NodexButton
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => onRetry(source.id)}
              >
                Retry
              </NodexButton>
            ) : null}
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="px-1 text-sm text-token-error-foreground">
          {error}
        </p>
      ) : null}
    </NodexSettingsPageSurface>
  );
}
export function GitHubSettingsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey, queryFn: readSourcesSettings, refetchInterval: 15000 });
  const mutation = useMutation({
    mutationFn: async (
      action:
        | { kind: "connect" }
        | { kind: "update"; input: UpdateSourceSettingsInput }
        | { kind: "retry"; id: string },
    ) => {
      if (action.kind === "connect") return await connectGitHubSource();
      if (action.kind === "update") return await updateSourcesSettings(action.input);
      return await retrySource(action.id);
    },
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  if (!query.data)
    return (
      <NodexSettingsPageSurface title="GitHub">
        <p className="text-sm text-token-text-secondary" role="status">
          {query.error ? "GitHub is unavailable." : "Loading…"}
        </p>
      </NodexSettingsPageSurface>
    );
  return (
    <GitHubSettingsView
      snapshot={query.data}
      pending={mutation.isPending}
      error={mutation.error?.message ?? null}
      onConnect={() => mutation.mutate({ kind: "connect" })}
      onUpdate={(input) => mutation.mutate({ kind: "update", input })}
      onRetry={(id) => mutation.mutate({ kind: "retry", id })}
    />
  );
}

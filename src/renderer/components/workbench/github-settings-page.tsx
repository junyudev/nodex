import { settingsMessages } from "./workbench-settings-search-catalog";
import { defineMessage, useIntl } from "@/lib/i18n";
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
  assigned: defineMessage({ id: "settings.github.assignedToMe", defaultMessage: "Assigned to me" }),
  review_requests: defineMessage({
    id: "settings.github.reviewRequests",
    defaultMessage: "Review requests",
  }),
  mentions: defineMessage({ id: "settings.github.mentions", defaultMessage: "Mentions" }),
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
  const intl = useIntl();
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
    <NodexSettingsPageSurface
      title={intl.formatMessage(settingsMessages.githubTitle)}
      subtitle={intl.formatMessage(settingsMessages.githubSubtitle)}
    >
      <NodexSettingsSection>
        <NodexSettingsRow
          label={intl.formatMessage({ id: "settings.github.account", defaultMessage: "Account" })}
          description={
            snapshot.connection === "connected" && snapshot.account
              ? intl.formatMessage(
                  { id: "settings.github.connectedAs", defaultMessage: "Connected as {login}" },
                  { login: snapshot.account.login },
                )
              : intl.formatMessage({
                  id: "settings.github.installGitHubCLIAndRunGh",
                  defaultMessage: "Install GitHub CLI and run gh auth login.",
                })
          }
        >
          <NodexButton size="toolbar" variant="secondary" disabled={pending} onClick={onConnect}>
            {snapshot.connection === "connected"
              ? source
                ? intl.formatMessage({ id: "settings.github.refresh", defaultMessage: "Refresh" })
                : intl.formatMessage({ id: "settings.github.connect", defaultMessage: "Connect" })
              : intl.formatMessage({
                  id: "settings.github.reconnect",
                  defaultMessage: "Reconnect",
                })}
          </NodexButton>
        </NodexSettingsRow>
        {source ? (
          <NodexSettingsRow
            label={intl.formatMessage({
              id: "settings.github.watchGitHub",
              defaultMessage: "Watch GitHub",
            })}
          >
            <NodexSwitch
              ariaLabel={intl.formatMessage({
                id: "settings.github.watchGitHub",
                defaultMessage: "Watch GitHub",
              })}
              checked={source.enabled}
              disabled={pending}
              onCheckedChange={(enabled) => change({ enabled })}
            />
          </NodexSettingsRow>
        ) : null}
      </NodexSettingsSection>
      {source ? (
        <>
          <NodexSettingsSection
            title={intl.formatMessage({
              id: "settings.github.repositories",
              defaultMessage: "Repositories",
            })}
          >
            {snapshot.repositories.length ? (
              snapshot.repositories.map((repo) => (
                <NodexSettingsRow key={repo.id} label={repo.name}>
                  <NodexSwitch
                    ariaLabel={intl.formatMessage(
                      { id: "settings.github.watch", defaultMessage: "Watch {name}" },
                      { name: repo.name },
                    )}
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
                {intl.formatMessage({
                  id: "settings.github.addAGitRepositoryToA",
                  defaultMessage: "Add a git repository to a Project.",
                })}
              </p>
            )}
          </NodexSettingsSection>
          <NodexSettingsSection
            title={intl.formatMessage({
              id: "settings.github.discovery",
              defaultMessage: "Discovery",
            })}
          >
            {Object.entries(discoveryLabels).map(([key, label]) => (
              <NodexSettingsRow key={key} label={intl.formatMessage(label)}>
                <NodexCheckbox
                  ariaLabel={intl.formatMessage(label)}
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
                  ? intl.formatMessage({
                      id: "settings.github.gitHubNeedsToReconnect",
                      defaultMessage: "GitHub needs to reconnect.",
                    })
                  : problem.summary === "GitHub returned an unreadable update"
                    ? intl.formatMessage({
                        id: "settings.github.someGitHubActivityCouldNotBe",
                        defaultMessage: "Some GitHub activity could not be read.",
                      })
                    : intl.formatMessage({
                        id: "settings.github.gitHubCouldNotBeReached",
                        defaultMessage: "GitHub could not be reached.",
                      })
                : !source.enabled
                  ? intl.formatMessage({ id: "settings.github.paused", defaultMessage: "Paused" })
                  : snapshot.lastSuccessAtMs
                    ? intl.formatMessage({
                        id: "settings.github.upToDate",
                        defaultMessage: "Up to date",
                      })
                    : intl.formatMessage({
                        id: "settings.github.waitingForFirstPoll",
                        defaultMessage: "Waiting for first poll",
                      })}
            </span>
            {problem ? (
              <NodexButton
                size="toolbar"
                variant="ghost"
                disabled={pending}
                onClick={() => onRetry(source.id)}
              >
                {intl.formatMessage({ id: "settings.github.retry", defaultMessage: "Retry" })}
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
  const intl = useIntl();
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
      <NodexSettingsPageSurface title={intl.formatMessage(settingsMessages.githubTitle)}>
        <p className="text-sm text-token-text-secondary" role="status">
          {query.error
            ? intl.formatMessage({
                id: "settings.github.gitHubIsUnavailable",
                defaultMessage: "GitHub is unavailable.",
              })
            : intl.formatMessage({ id: "settings.github.loading", defaultMessage: "Loading…" })}
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

import { FormattedMessage, defineMessage, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NodexOptionPicker } from "@/components/ui/dropdown";
import { NodexCheckbox } from "@/components/ui/settings";
import type { AutomationEventFilter } from "@/lib/types";
import { readSourceOptions } from "@/lib/sources";
import { queryKeys } from "@/lib/query-keys";
import { isRemoteSpace } from "@/lib/renderer-space";
import { AutomationFieldRow, AutomationFieldTrigger } from "./automation-fields";

const NO_SOURCES: readonly { id: string; label: string }[] = [];
const KINDS: readonly {
  value: AutomationEventFilter["events"][number];
  label: MessageDescriptor;
}[] = [
  {
    value: "new_issue",
    label: defineMessage({
      id: "automations.automationEventFields.newIssue",
      defaultMessage: "New issue",
    }),
  },
  {
    value: "new_pr",
    label: defineMessage({
      id: "automations.automationEventFields.newPullRequest",
      defaultMessage: "New pull request",
    }),
  },
  {
    value: "comment",
    label: defineMessage({
      id: "automations.automationEventFields.comment",
      defaultMessage: "Comment",
    }),
  },
  {
    value: "review",
    label: defineMessage({
      id: "automations.automationEventFields.review",
      defaultMessage: "Review",
    }),
  },
  {
    value: "check_failed",
    label: defineMessage({
      id: "automations.automationEventFields.checkFailed",
      defaultMessage: "Check failed",
    }),
  },
  {
    value: "check_passed",
    label: defineMessage({
      id: "automations.automationEventFields.checkPassed",
      defaultMessage: "Check passed",
    }),
  },
  {
    value: "label_added",
    label: defineMessage({
      id: "automations.automationEventFields.labelAdded",
      defaultMessage: "Label added",
    }),
  },
  {
    value: "label_removed",
    label: defineMessage({
      id: "automations.automationEventFields.labelRemoved",
      defaultMessage: "Label removed",
    }),
  },
];
const textClass =
  "h-10 min-w-0 w-full bg-transparent px-2.5 text-right text-base text-token-text-secondary outline-none placeholder:text-token-text-tertiary";
const split = (value: string) => [
  ...new Set(
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
function FilterText({
  label,
  placeholder,
  values,
  disabled,
  onChange,
}: {
  label: string;
  placeholder: string;
  values: readonly string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join(", "));
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      className={textClass}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={(event) => onChange(split(event.currentTarget.value))}
    />
  );
}
function HostEventAutomations() {
  return (
    <p role="status" className="px-4 py-3 text-sm text-token-description-foreground">
      <FormattedMessage
        id="automations.automationEventFields.eventAutomationsForThisSpace"
        defaultMessage="Event Automations for this Space run on its host"
      />
    </p>
  );
}
export function AutomationEventFields({
  value,
  disabled,
  onChange,
  sources = NO_SOURCES,
}: {
  value: AutomationEventFilter;
  disabled: boolean;
  onChange: (value: AutomationEventFilter) => void;
  sources?: readonly { id: string; label: string }[];
}) {
  const intl = useIntl();
  if (isRemoteSpace()) return <HostEventAutomations />;
  const patch = (next: Partial<AutomationEventFilter>) => onChange({ ...value, ...next });
  return (
    <>
      <AutomationFieldRow
        label={intl.formatMessage({
          id: "automations.automationEventFields.source",
          defaultMessage: "Source",
        })}
      >
        <NodexOptionPicker
          value={value.sourceId ?? "all"}
          options={[
            {
              value: "all",
              label: intl.formatMessage({
                id: "automations.automationEventFields.allGitHubSources",
                defaultMessage: "All GitHub Sources",
              }),
            },
            ...sources.map((s) => ({ value: s.id, label: s.label })),
          ]}
          search="filter"
          title={intl.formatMessage({
            id: "automations.automationEventFields.source",
            defaultMessage: "Source",
          })}
          disabled={disabled}
          onValueChange={(v) => patch({ sourceId: v === "all" ? null : v })}
          triggerButton={
            <AutomationFieldTrigger
              ariaLabel={intl.formatMessage({
                id: "automations.automationEventFields.source",
                defaultMessage: "Source",
              })}
              disabled={disabled}
            >
              {sources.find((s) => s.id === value.sourceId)?.label ??
                intl.formatMessage({
                  id: "automations.automationEventFields.allGitHubSources",
                  defaultMessage: "All GitHub Sources",
                })}
            </AutomationFieldTrigger>
          }
        />
      </AutomationFieldRow>
      <AutomationFieldRow
        label={intl.formatMessage({
          id: "automations.automationEventFields.repositories",
          defaultMessage: "Repositories",
        })}
      >
        <FilterText
          key={value.repositories.join("\0")}
          label={intl.formatMessage({
            id: "automations.automationEventFields.repositories",
            defaultMessage: "Repositories",
          })}
          placeholder={intl.formatMessage({
            id: "automations.automationEventFields.allRepositories",
            defaultMessage: "All repositories",
          })}
          values={value.repositories}
          disabled={disabled}
          onChange={(repositories) => patch({ repositories })}
        />
      </AutomationFieldRow>
      <div
        className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-3"
        role="group"
        aria-label={intl.formatMessage({
          id: "automations.automationEventFields.eventKinds",
          defaultMessage: "Event kinds",
        })}
      >
        {KINDS.map((kind) => (
          <label
            key={kind.value}
            className="flex items-center gap-2 text-sm text-token-text-secondary"
          >
            <NodexCheckbox
              ariaLabel={intl.formatMessage(kind.label)}
              checked={value.events.includes(kind.value)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                patch({
                  events: checked
                    ? [...value.events, kind.value]
                    : value.events.filter((v) => v !== kind.value),
                })
              }
            />
            {intl.formatMessage(kind.label)}
          </label>
        ))}
      </div>
      <AutomationFieldRow
        label={intl.formatMessage({
          id: "automations.automationEventFields.labels",
          defaultMessage: "Labels",
        })}
      >
        <FilterText
          key={value.labels.join("\0")}
          label={intl.formatMessage({
            id: "automations.automationEventFields.labels",
            defaultMessage: "Labels",
          })}
          placeholder={intl.formatMessage({
            id: "automations.automationEventFields.anyLabel",
            defaultMessage: "Any label",
          })}
          values={value.labels}
          disabled={disabled}
          onChange={(labels) => patch({ labels })}
        />
      </AutomationFieldRow>
      <AutomationFieldRow
        label={intl.formatMessage({
          id: "automations.automationEventFields.actors",
          defaultMessage: "Actors",
        })}
      >
        <NodexOptionPicker
          value={value.actorClass}
          options={[
            {
              value: "any",
              label: intl.formatMessage({
                id: "automations.automationEventFields.anyoneIncludingBotsAndCI",
                defaultMessage: "Anyone, including bots and CI",
              }),
            },
            {
              value: "person",
              label: intl.formatMessage({
                id: "automations.automationEventFields.peopleOnly",
                defaultMessage: "People only",
              }),
            },
          ]}
          search="none"
          title={intl.formatMessage({
            id: "automations.automationEventFields.actors",
            defaultMessage: "Actors",
          })}
          disabled={disabled}
          onValueChange={(v) => patch({ actorClass: v === "person" ? "person" : "any" })}
          triggerButton={
            <AutomationFieldTrigger
              ariaLabel={intl.formatMessage({
                id: "automations.automationEventFields.actors",
                defaultMessage: "Actors",
              })}
              disabled={disabled}
            >
              {value.actorClass === "person"
                ? intl.formatMessage({
                    id: "automations.automationEventFields.peopleOnly",
                    defaultMessage: "People only",
                  })
                : intl.formatMessage({
                    id: "automations.automationEventFields.anyoneIncludingBotsAndCI",
                    defaultMessage: "Anyone, including bots and CI",
                  })}
            </AutomationFieldTrigger>
          }
        />
      </AutomationFieldRow>
    </>
  );
}
export function AutomationSourceFields(
  props: Omit<Parameters<typeof AutomationEventFields>[0], "sources">,
) {
  return isRemoteSpace() ? <HostEventAutomations /> : <PersonalAutomationSourceFields {...props} />;
}
function PersonalAutomationSourceFields(props: Parameters<typeof AutomationSourceFields>[0]) {
  const options = useQuery({
    queryKey: queryKeys.sources.automationOptions(),
    queryFn: readSourceOptions,
  });
  return <AutomationEventFields {...props} sources={options.data ?? NO_SOURCES} />;
}

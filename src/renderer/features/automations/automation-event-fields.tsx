import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NodexOptionPicker } from "@/components/ui/dropdown";
import { NodexCheckbox } from "@/components/ui/settings";
import type { AutomationSourceFilter } from "@/lib/types";
import { readSourceOptions } from "@/lib/sources";
import { queryKeys } from "@/lib/query-keys";
import { isRemoteSpace } from "@/lib/renderer-space";
import { AutomationFieldRow, AutomationFieldTrigger } from "./automation-fields";

export const DEFAULT_AUTOMATION_SOURCE_FILTER: AutomationSourceFilter = {
  source_id: null,
  repositories: [],
  kinds: ["check_failed"],
  labels: [],
  actor_class: "any",
};
const NO_SOURCES: readonly { id: string; label: string }[] = [];
const KINDS: readonly { value: AutomationSourceFilter["kinds"][number]; label: string }[] = [
  { value: "new_issue", label: "New issue" },
  { value: "new_pr", label: "New pull request" },
  { value: "comment", label: "Comment" },
  { value: "review", label: "Review" },
  { value: "check_failed", label: "Check failed" },
  { value: "check_passed", label: "Check passed" },
  { value: "label_added", label: "Label added" },
  { value: "label_removed", label: "Label removed" },
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
      Event Automations for this Space run on its host
    </p>
  );
}
export function AutomationEventFields({
  value,
  disabled,
  onChange,
  sources = NO_SOURCES,
}: {
  value: AutomationSourceFilter;
  disabled: boolean;
  onChange: (value: AutomationSourceFilter) => void;
  sources?: readonly { id: string; label: string }[];
}) {
  if (isRemoteSpace()) return <HostEventAutomations />;
  const patch = (next: Partial<AutomationSourceFilter>) => onChange({ ...value, ...next });
  return (
    <>
      <AutomationFieldRow label="Source">
        <NodexOptionPicker
          value={value.source_id ?? "all"}
          options={[
            { value: "all", label: "All GitHub Sources" },
            ...sources.map((s) => ({ value: s.id, label: s.label })),
          ]}
          search="filter"
          title="Source"
          disabled={disabled}
          onValueChange={(v) => patch({ source_id: v === "all" ? null : v })}
          triggerButton={
            <AutomationFieldTrigger ariaLabel="Source" disabled={disabled}>
              {sources.find((s) => s.id === value.source_id)?.label ?? "All GitHub Sources"}
            </AutomationFieldTrigger>
          }
        />
      </AutomationFieldRow>
      <AutomationFieldRow label="Repositories">
        <FilterText
          key={value.repositories.join("\0")}
          label="Repositories"
          placeholder="All repositories"
          values={value.repositories}
          disabled={disabled}
          onChange={(repositories) => patch({ repositories })}
        />
      </AutomationFieldRow>
      <div
        className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-3"
        role="group"
        aria-label="Event kinds"
      >
        {KINDS.map((kind) => (
          <label
            key={kind.value}
            className="flex items-center gap-2 text-sm text-token-text-secondary"
          >
            <NodexCheckbox
              ariaLabel={kind.label}
              checked={value.kinds.includes(kind.value)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                patch({
                  kinds: checked
                    ? [...value.kinds, kind.value]
                    : value.kinds.filter((v) => v !== kind.value),
                })
              }
            />
            {kind.label}
          </label>
        ))}
      </div>
      <AutomationFieldRow label="Labels">
        <FilterText
          key={(value.labels ?? []).join("\0")}
          label="Labels"
          placeholder="Any label"
          values={value.labels ?? []}
          disabled={disabled}
          onChange={(labels) => patch({ labels })}
        />
      </AutomationFieldRow>
      <AutomationFieldRow label="Actors">
        <NodexOptionPicker
          value={value.actor_class ?? "any"}
          options={[
            { value: "any", label: "Anyone, including bots and CI" },
            { value: "person", label: "People only" },
          ]}
          search="none"
          title="Actors"
          disabled={disabled}
          onValueChange={(v) => patch({ actor_class: v === "person" ? "person" : "any" })}
          triggerButton={
            <AutomationFieldTrigger ariaLabel="Actors" disabled={disabled}>
              {value.actor_class === "person" ? "People only" : "Anyone, including bots and CI"}
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

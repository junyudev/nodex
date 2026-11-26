import { FormattedMessage, useIntl } from "@/lib/i18n";
import type { ClaudeCustomModel, ClaudeEffortLevel } from "../../../shared/claude-models";
import { CLAUDE_EFFORT_LEVELS } from "../../../shared/claude-models";
import { Input } from "../ui/input";
import { NodexButton } from "../ui/button";
import { NodexCheckbox, NodexSettingsRow } from "../ui/settings";

/** Custom routes declare capabilities instead of inheriting traits from their names. */
export function ClaudeCustomModelsEditor({
  models,
  disabled,
  onChange,
}: {
  readonly models: readonly ClaudeCustomModel[];
  readonly disabled: boolean;
  readonly onChange: (models: ClaudeCustomModel[]) => void;
}) {
  const intl = useIntl();
  const update = (index: number, patch: Partial<ClaudeCustomModel>) =>
    onChange(
      models.map((model, position) => (position === index ? { ...model, ...patch } : model)),
    );
  return (
    <div>
      <NodexSettingsRow
        variant="nested"
        label={intl.formatMessage({
          id: "workbench.claudeCustomModelsEditor.customModels",
          defaultMessage: "Custom models",
        })}
        description={intl.formatMessage({
          id: "workbench.claudeCustomModelsEditor.description",
          defaultMessage: "Models this profile can choose besides Claude's own.",
        })}
      >
        <NodexButton
          size="toolbar"
          variant="secondary"
          disabled={disabled || models.length >= 64}
          onClick={() => onChange([...models, { id: "", displayName: "", traits: {} }])}
        >
          <FormattedMessage
            id="workbench.claudeCustomModelsEditor.addModel"
            defaultMessage={"Add model"}
          />
        </NodexButton>
      </NodexSettingsRow>
      {models.map((model, index) => (
        <div key={index} className="flex flex-col gap-2 px-4 pb-3">
          <div className="flex items-center gap-2">
            <Input
              variant="settings"
              aria-label={intl.formatMessage(
                {
                  id: "workbench.claudeCustomModelsEditor.indexedId",
                  defaultMessage: "Model ID {index}",
                },
                { index: index + 1 },
              )}
              placeholder={intl.formatMessage({
                id: "workbench.claudeCustomModelsEditor.modelId",
                defaultMessage: "Model ID",
              })}
              value={model.id}
              disabled={disabled}
              onChange={(event) => update(index, { id: event.target.value })}
            />
            <Input
              variant="settings"
              aria-label={intl.formatMessage(
                {
                  id: "workbench.claudeCustomModelsEditor.indexedName",
                  defaultMessage: "Model name {index}",
                },
                { index: index + 1 },
              )}
              placeholder={intl.formatMessage({
                id: "workbench.claudeCustomModelsEditor.name",
                defaultMessage: "Name",
              })}
              value={model.displayName}
              disabled={disabled}
              onChange={(event) => update(index, { displayName: event.target.value })}
            />
            <NodexButton
              size="toolbar"
              variant="ghost"
              disabled={disabled}
              aria-label={intl.formatMessage(
                {
                  id: "workbench.claudeCustomModelsEditor.removeIndexed",
                  defaultMessage: "Remove model {index}",
                },
                { index: index + 1 },
              )}
              onClick={() => onChange(models.filter((_, position) => position !== index))}
            >
              <FormattedMessage
                id="workbench.claudeCustomModelsEditor.remove"
                defaultMessage={"Remove"}
              />
            </NodexButton>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {CLAUDE_EFFORT_LEVELS.map((level: ClaudeEffortLevel) => (
              <label key={level} className="flex items-center gap-1">
                <NodexCheckbox
                  ariaLabel={intl.formatMessage(
                    {
                      id: "workbench.claudeCustomModelsEditor.effort",
                      defaultMessage: "Model {index} effort {level}",
                    },
                    { index: index + 1, level },
                  )}
                  disabled={disabled}
                  checked={model.traits.effortLevels?.includes(level) ?? false}
                  onCheckedChange={(checked) =>
                    update(index, {
                      traits: {
                        ...model.traits,
                        effortLevels: CLAUDE_EFFORT_LEVELS.filter((candidate) =>
                          candidate === level
                            ? checked
                            : model.traits.effortLevels?.includes(candidate),
                        ),
                      },
                    })
                  }
                />
                {level}
              </label>
            ))}
            <label className="flex items-center gap-1">
              <NodexCheckbox
                ariaLabel={intl.formatMessage(
                  {
                    id: "workbench.claudeCustomModelsEditor.indexedFastMode",
                    defaultMessage: "Model {index} fast mode",
                  },
                  { index: index + 1 },
                )}
                disabled={disabled}
                checked={model.traits.fastMode ?? false}
                onCheckedChange={(fastMode) =>
                  update(index, { traits: { ...model.traits, fastMode } })
                }
              />
              <FormattedMessage
                id="workbench.claudeCustomModelsEditor.fastMode"
                defaultMessage={"Fast"}
              />
            </label>
            <label className="flex items-center gap-1">
              <NodexCheckbox
                ariaLabel={intl.formatMessage(
                  {
                    id: "workbench.claudeCustomModelsEditor.indexedAdaptiveThinking",
                    defaultMessage: "Model {index} adaptive thinking",
                  },
                  { index: index + 1 },
                )}
                disabled={disabled}
                checked={model.traits.adaptiveThinking ?? false}
                onCheckedChange={(adaptiveThinking) =>
                  update(index, { traits: { ...model.traits, adaptiveThinking } })
                }
              />
              <FormattedMessage
                id="workbench.claudeCustomModelsEditor.adaptiveThinking"
                defaultMessage={"Adaptive thinking"}
              />
            </label>
            <label className="flex items-center gap-1">
              <NodexCheckbox
                ariaLabel={intl.formatMessage(
                  {
                    id: "workbench.claudeCustomModelsEditor.indexedDisableThinking",
                    defaultMessage: "Model {index} disable thinking",
                  },
                  { index: index + 1 },
                )}
                disabled={disabled}
                checked={model.traits.disableThinking ?? false}
                onCheckedChange={(disableThinking) =>
                  update(index, { traits: { ...model.traits, disableThinking } })
                }
              />
              <FormattedMessage
                id="workbench.claudeCustomModelsEditor.thinkingOff"
                defaultMessage={"Thinking off"}
              />
            </label>
            <Input
              variant="settings"
              aria-label={intl.formatMessage(
                {
                  id: "workbench.claudeCustomModelsEditor.contextWindows",
                  defaultMessage: "Model {index} context windows",
                },
                { index: index + 1 },
              )}
              className="h-7 w-28 text-xs"
              placeholder="200k, 1m"
              value={model.traits.contextWindows?.join(", ") ?? ""}
              disabled={disabled}
              onChange={(event) =>
                update(index, {
                  traits: {
                    ...model.traits,
                    contextWindows: event.target.value
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </div>
        </div>
      ))}
    </div>
  );
}

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
  const update = (index: number, patch: Partial<ClaudeCustomModel>) =>
    onChange(
      models.map((model, position) => (position === index ? { ...model, ...patch } : model)),
    );
  return (
    <>
      <NodexSettingsRow label="Custom models">
        <NodexButton
          size="sm"
          variant="ghost"
          disabled={disabled || models.length >= 64}
          onClick={() => onChange([...models, { id: "", displayName: "", traits: {} }])}
        >
          Add model
        </NodexButton>
      </NodexSettingsRow>
      {models.map((model, index) => (
        <div key={index} className="flex flex-col gap-2 px-3 pb-3">
          <div className="flex items-center gap-2">
            <Input
              aria-label={`Model ID ${index + 1}`}
              placeholder="Model ID"
              value={model.id}
              disabled={disabled}
              onChange={(event) => update(index, { id: event.target.value })}
            />
            <Input
              aria-label={`Model name ${index + 1}`}
              placeholder="Name"
              value={model.displayName}
              disabled={disabled}
              onChange={(event) => update(index, { displayName: event.target.value })}
            />
            <NodexButton
              size="sm"
              variant="ghost"
              disabled={disabled}
              aria-label={`Remove model ${index + 1}`}
              onClick={() => onChange(models.filter((_, position) => position !== index))}
            >
              Remove
            </NodexButton>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {CLAUDE_EFFORT_LEVELS.map((level: ClaudeEffortLevel) => (
              <label key={level} className="flex items-center gap-1">
                <NodexCheckbox
                  ariaLabel={`Model ${index + 1} effort ${level}`}
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
                ariaLabel={`Model ${index + 1} fast mode`}
                disabled={disabled}
                checked={model.traits.fastMode ?? false}
                onCheckedChange={(fastMode) =>
                  update(index, { traits: { ...model.traits, fastMode } })
                }
              />
              Fast
            </label>
            <label className="flex items-center gap-1">
              <NodexCheckbox
                ariaLabel={`Model ${index + 1} adaptive thinking`}
                disabled={disabled}
                checked={model.traits.adaptiveThinking ?? false}
                onCheckedChange={(adaptiveThinking) =>
                  update(index, { traits: { ...model.traits, adaptiveThinking } })
                }
              />
              Adaptive thinking
            </label>
            <label className="flex items-center gap-1">
              <NodexCheckbox
                ariaLabel={`Model ${index + 1} disable thinking`}
                disabled={disabled}
                checked={model.traits.disableThinking ?? false}
                onCheckedChange={(disableThinking) =>
                  update(index, { traits: { ...model.traits, disableThinking } })
                }
              />
              Thinking off
            </label>
            <Input
              aria-label={`Model ${index + 1} context windows`}
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
    </>
  );
}

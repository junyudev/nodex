import { ScrollView, View } from "react-native";

import { useRootNavigation, type ScreenProps } from "../../navigation/types";
import { useAgentCatalog, useNewChatPreferences, useProjects } from "../../runtime";
import { Icon } from "../../ui/icons";
import { Row, RowGroup, SectionLabel, Txt } from "../../ui/primitives";
import { useHomeState } from "../home/home-state";
import { effectiveAgentChoice } from "./agent-choice";

const Selected = () => <Icon name="check" color="accent" />;

const Count = ({ value }: { readonly value: number }) =>
  value > 0 ? <Txt className="text-sm text-ink-3">{value}</Txt> : null;

const PickerSurface = ({ children }: { readonly children: React.ReactNode }) => (
  <ScrollView
    className="flex-1"
    contentContainerClassName="gap-5 px-4 pb-8 pt-7"
    contentInsetAdjustmentBehavior="automatic"
  >
    {children}
  </ScrollView>
);

/** Which Inbox the stream shows and the Composer sends to. */
export const ScopePickerScreen = () => {
  const navigation = useRootNavigation();
  const scope = useHomeState((state) => state.scope);
  const setScope = useHomeState((state) => state.setScope);
  const { projects, libraryInboxCount } = useProjects();
  return (
    <PickerSurface>
      <RowGroup>
        <Row
          icon="inbox"
          label="Library"
          trailing={scope.kind !== "project" ? <Selected /> : <Count value={libraryInboxCount} />}
          onPress={() => {
            setScope({ kind: "all" });
            navigation.goBack();
          }}
        />
      </RowGroup>
      {projects.length > 0 ? (
        <View>
          <SectionLabel>Projects</SectionLabel>
          <RowGroup>
            {projects.map((project) => (
              <Row
                key={project.id}
                icon="folder"
                label={project.name}
                trailing={
                  scope.kind === "project" && scope.projectId === project.id ? (
                    <Selected />
                  ) : (
                    <Count value={project.inboxCount} />
                  )
                }
                onPress={() => {
                  setScope({ kind: "project", projectId: project.id });
                  navigation.goBack();
                }}
              />
            ))}
          </RowGroup>
        </View>
      ) : null}
    </PickerSurface>
  );
};

/** Where a new chat runs: its Project, and the checkout or a fresh worktree. */
export const ProjectPickerScreen = ({ route }: ScreenProps<"ProjectPicker">) => {
  const projectOnly = route.params?.projectOnly === true;
  const navigation = useRootNavigation();
  const { projects } = useProjects();
  const preferences = useNewChatPreferences();
  const current = projects.find((project) => project.id === preferences.projectId);
  return (
    <PickerSurface>
      <RowGroup>
        <Row
          icon="thought"
          label="No project"
          detail="A chat that isn't about any folder"
          trailing={preferences.projectId === null ? <Selected /> : null}
          onPress={() => {
            preferences.set({ projectId: null, location: "local" });
            navigation.goBack();
          }}
        />
        {projects.map((project) => (
          <Row
            key={project.id}
            icon="folder"
            label={project.name}
            trailing={preferences.projectId === project.id ? <Selected /> : null}
            onPress={() => {
              preferences.set({
                projectId: project.id,
                ...(project.supportsWorktree ? {} : { location: "local" as const }),
              });
              // One with a choice of where to run stays open, to offer it just below.
              if (projectOnly || !project.supportsWorktree) navigation.goBack();
            }}
          />
        ))}
      </RowGroup>
      {!projectOnly && current?.supportsWorktree ? (
        <View>
          <SectionLabel>Runs in</SectionLabel>
          <RowGroup>
            <Row
              icon="folder"
              label="Local checkout"
              trailing={preferences.location === "local" ? <Selected /> : null}
              onPress={() => {
                preferences.set({ location: "local" });
                navigation.goBack();
              }}
            />
            <Row
              icon="branch"
              label="New worktree"
              detail="Keeps this chat's changes apart from your checkout"
              trailing={preferences.location === "worktree" ? <Selected /> : null}
              onPress={() => {
                preferences.set({ location: "worktree" });
                navigation.goBack();
              }}
            />
          </RowGroup>
        </View>
      ) : null}
    </PickerSurface>
  );
};

/** What a new chat runs on. Agents that can't run say why rather than disappearing. */
export const AgentPickerScreen = () => {
  const navigation = useRootNavigation();
  const { catalog, loading } = useAgentCatalog();
  const preferences = useNewChatPreferences();
  const effective = effectiveAgentChoice(catalog, preferences.agent);
  if (!catalog) {
    return (
      <PickerSurface>
        <Txt className="px-1 text-sm text-ink-3">
          {loading ? "Reading your Agents" : "Agents are shown once this Space is connected."}
        </Txt>
      </PickerSurface>
    );
  }
  return (
    <PickerSurface>
      {catalog.providers.map((provider) => (
        <View key={provider.instanceId}>
          <SectionLabel>{provider.label}</SectionLabel>
          {provider.unavailableReason ? (
            <Txt className="px-1 text-sm text-ink-3">{provider.unavailableReason}</Txt>
          ) : (
            <RowGroup>
              {provider.models.map((model) => (
                <Row
                  key={model.id}
                  label={model.label}
                  trailing={
                    effective?.providerInstanceId === provider.instanceId &&
                    effective.model === model.id ? (
                      <Selected />
                    ) : null
                  }
                  onPress={() => {
                    preferences.set({
                      agent: { providerInstanceId: provider.instanceId, model: model.id },
                    });
                    navigation.goBack();
                  }}
                />
              ))}
            </RowGroup>
          )}
        </View>
      ))}
    </PickerSurface>
  );
};

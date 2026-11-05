import type { ChatQuestion, ChatRequest, ChatResponse } from "@nodex/mobile-protocol";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { cn } from "../../ui/cn";
import { Icon } from "../../ui/icons";
import { Button, Field, Mono, Tap, Txt, lightTap } from "../../ui/primitives";
import { showFailure } from "../../ui/snackbar";
import { answersFromSelections, isQuestionAnswered, toggleSelection } from "./request-answers";

type Respond = (requestId: string, runId: string | null, response: ChatResponse) => Promise<void>;

const useSubmit = (respond: Respond, request: ChatRequest) => {
  const [submitting, setSubmitting] = useState(false);
  const submit = (response: ChatResponse) => {
    lightTap();
    setSubmitting(true);
    respond(request.requestId, request.runId, response)
      .catch((cause: unknown) => showFailure("Your answer didn't reach the chat", cause))
      .finally(() => setSubmitting(false));
  };
  return { submitting, submit };
};

const ApprovalCard = ({
  request,
  respond,
}: {
  readonly request: Extract<ChatRequest, { kind: "approval" }>;
  readonly respond: Respond;
}) => {
  const { submitting, submit } = useSubmit(respond, request);
  return (
    <View className="gap-2">
      <View className="flex-row items-start gap-2">
        <Icon name="warning" size={17} color="warning" />
        <Txt className="flex-1 font-medium">{request.title}</Txt>
      </View>
      {request.detail ? (
        <ScrollView className="max-h-36 rounded-xl bg-surface-3" nestedScrollEnabled>
          <Mono selectable className="p-2.5 text-xs leading-[17px]">
            {request.detail}
          </Mono>
        </ScrollView>
      ) : null}
      {request.options.length === 0 ? (
        <Txt className="text-sm text-ink-3">Answer this on your desktop.</Txt>
      ) : null}
      <View className="flex-row flex-wrap gap-1.5">
        {request.options.map((option) => (
          <Button
            key={option.id}
            compact
            disabled={submitting}
            label={option.label}
            tone={option.tone}
            onPress={() => submit({ kind: "option", optionId: option.id, feedback: null })}
          />
        ))}
      </View>
    </View>
  );
};

const QuestionBlock = ({
  question,
  selected,
  text,
  onToggle,
  onText,
}: {
  readonly question: ChatQuestion;
  readonly selected: readonly string[];
  readonly text: string;
  readonly onToggle: (optionId: string) => void;
  readonly onText: (text: string) => void;
}) => {
  return (
    <View className="gap-1.5">
      {question.header ? <Txt className="text-xs text-ink-3">{question.header}</Txt> : null}
      <Txt className="font-medium">{question.prompt}</Txt>
      {question.options.map((option) => {
        const isSelected = selected.includes(option.id);
        return (
          <Tap
            key={option.id}
            accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
            accessibilityState={{ checked: isSelected }}
            className={cn(
              "flex-row items-center gap-2 rounded-xl border-[0.5px] border-line px-3 py-2",
              isSelected && "bg-surface-3",
            )}
            pressedClassName="active:bg-surface-3"
            onPress={() => onToggle(option.id)}
          >
            <View className="flex-1">
              <Txt className="text-sm">{option.label}</Txt>
              {option.description ? (
                <Txt className="text-xs text-ink-3">{option.description}</Txt>
              ) : null}
            </View>
            {isSelected ? <Icon name="check" size={16} color="accent" /> : null}
          </Tap>
        );
      })}
      {question.allowsText ? (
        <Field
          accessibilityLabel={question.prompt}
          className="min-h-10 rounded-xl border-[0.5px] border-line px-3 py-2 text-sm text-ink"
          multiline
          onChangeText={onText}
          placeholder={question.options.length > 0 ? "Or answer in your words" : "Your answer"}
          value={text}
        />
      ) : null}
    </View>
  );
};

const QuestionCard = ({
  request,
  respond,
}: {
  readonly request: Extract<ChatRequest, { kind: "question" }>;
  readonly respond: Respond;
}) => {
  const { submitting, submit } = useSubmit(respond, request);
  const [selections, setSelections] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [texts, setTexts] = useState<Readonly<Record<string, string>>>({});
  const complete = request.questions.every((question) =>
    isQuestionAnswered(selections[question.id] ?? [], texts[question.id] ?? ""),
  );
  return (
    <View className="gap-3">
      <ScrollView className="max-h-80" contentContainerClassName="gap-3" nestedScrollEnabled>
        {request.questions.map((question) => (
          <QuestionBlock
            key={question.id}
            question={question}
            selected={selections[question.id] ?? []}
            text={texts[question.id] ?? ""}
            onToggle={(optionId) =>
              setSelections((current) => ({
                ...current,
                [question.id]: toggleSelection(
                  current[question.id] ?? [],
                  optionId,
                  question.multiSelect,
                ),
              }))
            }
            onText={(text) => setTexts((current) => ({ ...current, [question.id]: text }))}
          />
        ))}
      </ScrollView>
      <Button
        compact
        className="self-end"
        disabled={!complete || submitting}
        label="Answer"
        tone="primary"
        onPress={() =>
          submit({
            kind: "answers",
            answers: answersFromSelections(request.questions, selections, texts),
          })
        }
      />
    </View>
  );
};

/** What the chat is asking for, pinned above the Composer so it cannot scroll out of reach. */
export const RequestCard = ({
  request,
  respond,
}: {
  readonly request: ChatRequest;
  readonly respond: Respond;
}) => (
  <View className="mx-2.5 mt-1.5 rounded-2xl border-[0.5px] border-line bg-surface-2 p-3">
    {request.kind === "approval" ? (
      <ApprovalCard request={request} respond={respond} />
    ) : (
      <QuestionCard request={request} respond={respond} />
    )}
  </View>
);

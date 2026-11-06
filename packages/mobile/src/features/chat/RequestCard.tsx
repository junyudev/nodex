import type { ChatQuestion, ChatRequest, ChatResponse } from "@nodex/mobile-protocol";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { cn } from "../../ui/cn";
import { Glass } from "../../ui/glass";
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

/** Past this, an approval's detail starts collapsed to a scrolling window. */
const LONG_DETAIL_LINES = 7;

/** Exactly what is being approved, however long: a window to scroll, or opened up to read. */
const ApprovalDetail = ({ detail }: { readonly detail: string }) => {
  const [whole, setWhole] = useState(false);
  const long = detail.split("\n").length > LONG_DETAIL_LINES || detail.length > 320;
  return (
    <View className="items-start gap-1">
      <ScrollView
        className={cn("w-full rounded-2xl bg-fill", whole ? "max-h-96" : "max-h-36")}
        nestedScrollEnabled
      >
        <Mono selectable className="p-3 text-xs leading-[17px]">
          {detail}
        </Mono>
      </ScrollView>
      {long ? (
        <Tap
          accessibilityState={{ expanded: whole }}
          className="flex-row items-center gap-1 py-1"
          hitSlop={6}
          onPress={() => setWhole(!whole)}
        >
          <Txt className="text-xs font-medium text-ink-2">{whole ? "Show less" : "Show more"}</Txt>
          <Icon name={whole ? "chevronDown" : "chevronRight"} size={12} color="ink-3" />
        </Tap>
      ) : null}
    </View>
  );
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
      {request.detail ? <ApprovalDetail detail={request.detail} /> : null}
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
              "flex-row items-center gap-2 rounded-2xl bg-fill px-3.5 py-2.5",
              isSelected && "bg-surface-3",
            )}
            pressedClassName="active:opacity-50"
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
          className="min-h-10 rounded-2xl bg-fill px-3.5 py-2.5 text-sm text-ink"
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
  <View className="px-4" pointerEvents="box-none">
    <Glass radius={25}>
      <View className="p-3.5">
        {request.kind === "approval" ? (
          <ApprovalCard request={request} respond={respond} />
        ) : (
          <QuestionCard request={request} respond={respond} />
        )}
      </View>
    </Glass>
  </View>
);

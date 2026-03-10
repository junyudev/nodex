import { cn } from "@/lib/utils";

interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

interface StageThreadsPlaceholderProps {
  messages: ThreadMessage[];
  activeThreadTitle: string;
}

export function StageThreadsPlaceholder({
  messages,
  activeThreadTitle,
}: StageThreadsPlaceholderProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-(--background)">
      <div className="flex h-7 items-center justify-between border-b border-(--border) px-2">
        <div className="truncate text-xs text-(--foreground-secondary)">{activeThreadTitle}</div>
        <div className="text-xs text-(--foreground-tertiary)">Mock</div>
      </div>

      <div className="scrollbar-token min-h-0 flex-1 overflow-y-auto">
        {messages.map((message) => (
          <article
            key={message.id}
            className={cn(
              "border-b border-(--border) px-2 py-1.5",
              message.role === "assistant" ? "bg-(--background)" : "bg-(--background-secondary)",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium tracking-wide text-(--foreground-tertiary) uppercase">
                {message.role}
              </span>
              <span className="text-xs text-(--foreground-tertiary)">{message.timestamp}</span>
            </div>
            <p className="mt-0.5 text-sm/5 text-(--foreground)">{message.text}</p>
          </article>
        ))}
      </div>

      <div className="space-y-1 border-t border-(--border) p-1.5">
        <textarea
          value=""
          placeholder="Message composer placeholder"
          readOnly
          className={cn(
            "h-16 w-full resize-none border border-(--border) bg-(--background)",
            "px-2 py-1.5 text-sm text-(--foreground-tertiary)",
          )}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-(--foreground-tertiary)">Threads UI not implemented yet</span>
          <button
            type="button"
            disabled
            className="h-6 border border-(--border) px-2 text-xs text-(--foreground-disabled)"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

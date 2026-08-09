/**
 * A workflow subagent's own conversation, rendered over the main chat area in
 * the thread's visual language: the prompt as a user bubble, assistant text as
 * markdown, tool calls as compact chips, and the final outcome at the end.
 *
 * The transcript itself is the child agent's Pi session journal, answered by
 * the environment over RPC, so remote clients see the same thread.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PiSubagentTranscriptEntry } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { ArrowLeftIcon, BotIcon, ChevronRightIcon, WrenchIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useWorkflowAgentFocusStore, type WorkflowAgentFocus } from "../../workflowAgentFocusStore";
import { cn } from "~/lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import ChatMarkdown from "../ChatMarkdown";

const STATUS_BADGE_CLASS: Record<string, string> = {
  running: "bg-info/10 text-info",
  waiting: "bg-warning/10 text-warning",
  completed: "bg-success/10 text-success",
  failed: "bg-destructive/10 text-destructive",
};

const ToolCallRow = memo(function ToolCallRow({ entry }: { entry: PiSubagentTranscriptEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((current) => !current)}
      className="flex w-full cursor-pointer items-start gap-2 rounded-lg border border-border/60 bg-card/60 px-2.5 py-1.5 text-left hover:border-border"
    >
      <WrenchIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="text-xs font-medium text-foreground">{entry.toolName}</span>
        <span
          className={cn(
            "block font-mono text-[11px] text-muted-foreground",
            expanded ? "break-all whitespace-pre-wrap" : "truncate",
          )}
        >
          {entry.text}
        </span>
      </span>
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "mt-0.5 size-3 shrink-0 text-muted-foreground/60 transition-transform",
          expanded && "rotate-90",
        )}
      />
    </button>
  );
});

function TranscriptEntry({ entry, cwd }: { entry: PiSubagentTranscriptEntry; cwd: string | null }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-sm whitespace-pre-wrap text-secondary-foreground">
            {entry.text}
          </div>
        </div>
      );
    case "assistant":
      return <ChatMarkdown text={entry.text} cwd={cwd ?? undefined} className="text-sm" />;
    case "thinking":
      return (
        <p className="border-l-2 border-border/60 pl-3 text-xs text-muted-foreground italic">
          {entry.text}
        </p>
      );
    case "tool":
      return <ToolCallRow entry={entry} />;
    case "toolResult":
      return null; // Tool output is noise here; the chips carry the activity.
  }
}

export function WorkflowSubagentThread({
  environmentId,
  activeThreadKey,
  cwd,
  bottomInset,
}: {
  environmentId: EnvironmentId;
  activeThreadKey: string | null;
  cwd: string | null;
  bottomInset: number;
}) {
  const focus = useWorkflowAgentFocusStore((state) => state.focus);
  if (focus === null || focus.threadKey !== activeThreadKey) return null;
  return (
    <SubagentThreadContent
      environmentId={environmentId}
      focus={focus}
      cwd={cwd}
      bottomInset={bottomInset}
    />
  );
}

function SubagentThreadContent({
  environmentId,
  focus,
  cwd,
  bottomInset,
}: {
  environmentId: EnvironmentId;
  focus: WorkflowAgentFocus;
  cwd: string | null;
  bottomInset: number;
}) {
  const close = useWorkflowAgentFocusStore((state) => state.close);

  const input = useMemo(
    () => ({
      promptPrefix: (focus.prompt ?? focus.title).slice(0, 200),
      startedAt: focus.startedAt ?? "1970-01-01T00:00:00.000Z",
      ...(focus.scriptPrefix ? { scriptPrefix: focus.scriptPrefix } : {}),
      agentLabel: focus.title,
    }),
    [focus.prompt, focus.scriptPrefix, focus.startedAt, focus.title],
  );
  const result = useAtomValue(serverEnvironment.piSubagentTranscript({ environmentId, input }));

  const transcript = Option.getOrNull(AsyncResult.value(result));
  const loading = result.waiting && transcript === null;
  const entries = transcript?.found ? transcript.entries : [];
  const prompt = transcript?.fullPrompt ?? focus.prompt;
  const running = focus.status === "running" || focus.status === "pending";
  // A live agent has no outcome yet: the workflow's shared result belongs to
  // the run, not to this agent, and showing it here would be a lie.
  const sharedResult = running ? null : (focus.result ?? transcript?.workflowResult);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <button
          type="button"
          onClick={close}
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Back to thread
        </button>
        <span className="h-4 w-px bg-border" />
        <BotIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{focus.title}</span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
            STATUS_BADGE_CLASS[focus.status] ?? "bg-muted text-muted-foreground",
          )}
        >
          {focus.statusLabel}
        </span>
        {(transcript?.model ?? focus.modelLabel) ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {transcript?.model ?? focus.modelLabel}
          </span>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div
          className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4"
          style={{ paddingBottom: bottomInset + 16 }}
        >
          {prompt ? (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-sm whitespace-pre-wrap text-secondary-foreground">
                {prompt}
              </div>
            </div>
          ) : null}

          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading transcript…</p>
          ) : entries.length > 0 ? (
            <>
              {transcript?.truncated ? (
                <p className="text-center text-xs text-muted-foreground">
                  Long run — showing the first part of the transcript.
                </p>
              ) : null}
              {entries.map((entry, index) => {
                // The located journal's first user message repeats the prompt
                // bubble already rendered above.
                if (index === 0 && entry.kind === "user") return null;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: entries are append-only journal rows
                  <TranscriptEntry key={index} entry={entry} cwd={cwd} />
                );
              })}
            </>
          ) : sharedResult ? (
            <div className="flex flex-col gap-2">
              <ChatMarkdown text={sharedResult} cwd={cwd ?? undefined} className="text-sm" />
              <p className="text-xs text-muted-foreground">
                {focus.result
                  ? "Pi kept no full journal for this agent, so this is its reported result."
                  : "Pi kept no journal for this agent, so this is the workflow's shared result."}
              </p>
            </div>
          ) : (
            <p className="flex items-center justify-center gap-2 py-6 text-center text-sm text-muted-foreground">
              {running ? (
                <>
                  <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-info" />
                  Working… this agent's transcript appears once Pi writes its journal.
                </>
              ) : (
                "Pi did not keep a journal for this agent."
              )}
            </p>
          )}

          {focus.error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground">
              {focus.error}
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

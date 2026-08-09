/**
 * Workflow inspector right-panel surface.
 *
 * T3-native styling: workflow run chips, phase sections with agent cards, and
 * the run's final result. Clicking an agent takes over the chat area with that
 * subagent's own transcript (see WorkflowSubagentThread); this panel stays the
 * map, the chat column becomes the territory.
 */
import type {
  WorkflowInspectorAgent,
  WorkflowInspectorModel,
  WorkflowInspectorWorkflow,
} from "@t3tools/client-runtime/state/workflow-inspector";
import type { RuntimeSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  GitBranchIcon,
  WorkflowIcon,
} from "lucide-react";
import { memo, useEffect, useState } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { useWorkflowAgentFocusStore } from "../workflowAgentFocusStore";

const STATUS_DOT_CLASS: Record<RuntimeSubagentStatus, string> = {
  pending: "bg-muted-foreground/40",
  running: "bg-info",
  waiting: "bg-warning",
  idle: "bg-muted-foreground/50",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/60",
  interrupted: "bg-muted-foreground/60",
};

function StatusDot({ status }: { status: RuntimeSubagentStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        STATUS_DOT_CLASS[status],
        status === "running" && "animate-pulse",
      )}
    />
  );
}

const AgentCard = memo(function AgentCard({
  agent,
  active,
  onSelect,
}: {
  agent: WorkflowInspectorAgent;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors",
        active
          ? "border-border bg-accent"
          : "border-border/60 bg-card hover:border-border hover:bg-accent/50",
      )}
    >
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
        <BotIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <span
          aria-hidden
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-card",
            STATUS_DOT_CLASS[agent.status],
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{agent.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {agent.statusLabel}
          {agent.modelLabel ? ` · ${agent.modelLabel}` : ""}
        </span>
      </span>
      {agent.needsAttention ? (
        <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
      ) : null}
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
    </button>
  );
});

function WorkflowRun({
  workflow,
  activeAgentId,
  onSelectAgent,
}: {
  workflow: WorkflowInspectorWorkflow;
  activeAgentId: string | null;
  onSelectAgent: (agent: WorkflowInspectorAgent) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <WorkflowIcon aria-hidden className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{workflow.name.replaceAll("_", " ")}</h3>
          {workflow.coordinator.role ? (
            <p className="truncate text-xs text-muted-foreground">{workflow.coordinator.role}</p>
          ) : null}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {workflow.settledCount}/{workflow.agentCount}
          {workflow.elapsedLabel ? ` · ${workflow.elapsedLabel}` : ""}
        </span>
      </div>

      {workflow.phases.map((phase) => (
        <div key={phase.index} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 px-0.5">
            {phase.state === "done" ? (
              <CheckIcon aria-hidden className="size-3 text-success" />
            ) : (
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  phase.state === "running" ? "animate-pulse bg-info" : "bg-muted-foreground/40",
                )}
              />
            )}
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {phase.title}
            </span>
            {phase.parallel ? (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <GitBranchIcon aria-hidden className="size-2.5" />
                {phase.agents.length} parallel
              </span>
            ) : null}
          </div>
          {phase.agents.length === 0 ? (
            <p className="px-0.5 text-xs text-muted-foreground">
              {phase.state === "pending" ? "Not started yet" : "No agents recorded."}
            </p>
          ) : (
            phase.agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                active={agent.id === activeAgentId}
                onSelect={() => onSelectAgent(agent)}
              />
            ))
          )}
        </div>
      ))}

      {workflow.coordinator.result ? (
        <div className="flex flex-col gap-1.5">
          <span className="px-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Result
          </span>
          <pre className="max-h-44 overflow-y-auto rounded-lg border border-border/60 bg-card p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90">
            {workflow.coordinator.result}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <WorkflowIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">No workflow runs yet</p>
      <p className="max-w-56 text-xs text-muted-foreground">
        {label} appear here once this thread starts a workflow.
      </p>
    </div>
  );
}

export function WorkflowInspectorPanel({
  model,
  activeThreadKey = null,
  disconnected = false,
}: {
  model: WorkflowInspectorModel;
  /** Scopes the chat-area takeover to the thread that owns this panel. */
  activeThreadKey?: string | null;
  /** The thread's provider session is gone; showing the last saved state. */
  disconnected?: boolean;
}) {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const focus = useWorkflowAgentFocusStore((state) => state.focus);
  const openFocus = useWorkflowAgentFocusStore((state) => state.open);

  const workflow =
    model.workflows.find((entry) => entry.id === selectedWorkflowId) ?? model.workflows[0] ?? null;

  // A newly started run takes over the surface, matching the CLI.
  useEffect(() => {
    const live = model.workflows.find((entry) => entry.status === "running");
    if (live && selectedWorkflowId !== live.id) setSelectedWorkflowId(live.id);
  }, [model.workflows, selectedWorkflowId]);

  if (!model.hasActivity || workflow === null) {
    return <EmptyState label={model.label} />;
  }

  const selectAgent = (agent: WorkflowInspectorAgent) => {
    if (activeThreadKey === null) return;
    openFocus({
      threadKey: activeThreadKey,
      agentId: agent.id,
      title: agent.title,
      status: agent.status,
      statusLabel: agent.statusLabel,
      modelLabel: agent.modelLabel,
      prompt: agent.task,
      result: agent.result,
      error: agent.error,
      startedAt: workflow.startedAt,
      scriptPrefix: workflow.script?.slice(0, 200) ?? null,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {disconnected ? (
        <p
          role="status"
          className="border-b border-border/60 px-3 py-1 text-[11px] text-muted-foreground"
        >
          Session disconnected — showing the last saved run.
        </p>
      ) : null}
      {model.unknownSchemaVersion !== null ? (
        <p
          role="status"
          className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1 text-[11px] text-muted-foreground"
        >
          <CircleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />
          Newer workflow format (v{model.unknownSchemaVersion}); some detail may be missing.
        </p>
      ) : null}

      {model.workflows.length > 1 ? (
        <div className="flex gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2">
          {model.workflows.map((entry) => {
            const active = entry.id === workflow.id;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSelectedWorkflowId(entry.id)}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  active
                    ? "border-border bg-accent text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <StatusDot status={entry.status} />
                {entry.name.replaceAll("_", " ")}
              </button>
            );
          })}
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          <WorkflowRun
            workflow={workflow}
            activeAgentId={focus?.threadKey === activeThreadKey ? (focus?.agentId ?? null) : null}
            onSelectAgent={selectAgent}
          />
        </div>
      </ScrollArea>

      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {model.workflows.length} {model.workflows.length === 1 ? "run" : "runs"}
        </span>
        <span className="flex items-center gap-2">
          {model.liveCount > 0 ? (
            <span className="text-info">{model.liveCount} running</span>
          ) : null}
          {model.needsAttentionCount > 0 ? (
            <span className="text-warning">{model.needsAttentionCount} need attention</span>
          ) : null}
        </span>
      </footer>
    </div>
  );
}

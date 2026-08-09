// @effect-diagnostics globalDate:off -- elapsed labels are formatted from two persisted ISO stamps, never from a live clock.
/**
 * Workflow inspector read model: a bounded, provider-scoped view over the
 * same persisted task and tool activities the Agents surface folds, shaped
 * for drill-down (workflow → phase → child agent → that agent's transcript).
 *
 * Two rules keep this file honest:
 *
 * 1. Everything here derives from persisted orchestration activities, so a
 *    reload, a reconnect, or a remote client rebuilds the same model from the
 *    same rows. Nothing reads provider session files and nothing scrapes
 *    rendered text.
 * 2. Provider-specific payload knowledge lives in a `WorkflowInspectorSource`
 *    (see piWorkflowInspector.ts), never inline. Today exactly one source is
 *    registered; a second provider adds a source, not a branch in here.
 *
 * Bounded by construction: the fold already caps the roster, and each agent
 * keeps at most TRANSCRIPT_LIMIT transcript entries with bounded strings, so
 * a long workflow cannot grow the model without limit.
 */
import type { OrchestrationThreadActivity, ProviderDriverKind } from "@t3tools/contracts";

import {
  derivePiWorkflowInspectorModel,
  PI_DRIVER_KIND,
  piWorkflowInspectorSource,
} from "./piWorkflowInspector.ts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
} from "./subagentRuntime.ts";

/**
 * Provider-specific parsing boundary. A source answers the three questions
 * the generic derive cannot: which driver it speaks for, how that driver
 * stamps its workflow payload version, and which agent owns a tool row.
 */
export interface WorkflowInspectorSource {
  readonly driver: ProviderDriverKind;
  /** Surface label ("Pi workflows"), shown in the panel header. */
  readonly label: string;
  /** Highest payload schema version this build renders without a warning. */
  readonly supportedSchemaVersion: number;
  /** Version stamp on a workflow payload, or null when it carries none. */
  readonly readSchemaVersion: (payload: Record<string, unknown>) => number | null;
  /** Agent owning a non-task activity; null when it belongs to the parent. */
  readonly readOwnerAgentId: (payload: Record<string, unknown>) => string | null;
}

export type WorkflowInspectorTranscriptKind = "tool" | "progress" | "result" | "error";

export interface WorkflowInspectorTranscriptEntry {
  readonly id: string;
  readonly at: string;
  readonly kind: WorkflowInspectorTranscriptKind;
  readonly label: string;
  readonly detail: string | null;
}

export interface WorkflowInspectorAgent {
  readonly id: string;
  readonly title: string;
  readonly role: string | null;
  readonly modelLabel: string | null;
  readonly status: RuntimeSubagentStatus;
  readonly statusLabel: string;
  /** Failed or waiting on the user: the states worth surfacing upward. */
  readonly needsAttention: boolean;
  /** Concise task line: what this agent was asked to do. */
  readonly task: string | null;
  readonly result: string | null;
  readonly error: string | null;
  /** Only present once both ends are known — never ticks, never repaints. */
  readonly elapsedLabel: string | null;
  readonly tokensLabel: string | null;
  readonly toolCount: number;
  readonly transcript: ReadonlyArray<WorkflowInspectorTranscriptEntry>;
  readonly transcriptTruncated: boolean;
}

export interface WorkflowInspectorPhase {
  readonly index: number;
  readonly title: string;
  readonly state: "pending" | "running" | "done";
  /** More than one agent in the phase, i.e. a parallel branch. */
  readonly parallel: boolean;
  readonly needsAttention: boolean;
  readonly agents: ReadonlyArray<WorkflowInspectorAgent>;
}

export interface WorkflowInspectorWorkflow {
  readonly id: string;
  readonly name: string;
  /** ISO start of the run; bounds the child-journal transcript lookup. */
  readonly startedAt: string | null;
  /** The workflow script (possibly truncated), for server-side recovery. */
  readonly script: string | null;
  readonly status: RuntimeSubagentStatus;
  readonly statusLabel: string;
  readonly needsAttention: boolean;
  readonly elapsedLabel: string | null;
  readonly phases: ReadonlyArray<WorkflowInspectorPhase>;
  /** Members whose phase never arrived; they must still be reachable. */
  readonly looseAgents: ReadonlyArray<WorkflowInspectorAgent>;
  readonly coordinator: WorkflowInspectorAgent;
  readonly agentCount: number;
  readonly settledCount: number;
}

export interface WorkflowInspectorModel {
  readonly driver: ProviderDriverKind | null;
  readonly label: string;
  readonly workflows: ReadonlyArray<WorkflowInspectorWorkflow>;
  /** Agents spawned outside a workflow, kept reachable in the same tree. */
  readonly directAgents: ReadonlyArray<WorkflowInspectorAgent>;
  readonly hasActivity: boolean;
  readonly liveCount: number;
  readonly needsAttentionCount: number;
  /** Set when a payload stamps a version this build does not understand. */
  readonly unknownSchemaVersion: number | null;
}

const TRANSCRIPT_LIMIT = 40;
const TRANSCRIPT_TEXT_LIMIT = 200;

const STATUS_LABELS: Record<RuntimeSubagentStatus, string> = {
  pending: "Queued",
  running: "Running",
  waiting: "Needs attention",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

export function workflowInspectorStatusLabel(status: RuntimeSubagentStatus): string {
  return STATUS_LABELS[status];
}

const EMPTY_MODEL: WorkflowInspectorModel = {
  driver: null,
  label: "Workflows",
  workflows: [],
  directAgents: [],
  hasActivity: false,
  liveCount: 0,
  needsAttentionCount: 0,
  unknownSchemaVersion: null,
};

export function emptyWorkflowInspectorModel(): WorkflowInspectorModel {
  return EMPTY_MODEL;
}

/**
 * Registered sources. A second provider adds its module here; nothing else
 * in this file learns a driver name. Imported as a value while the source
 * imports only types back, so there is no runtime cycle and no
 * import-order-dependent registration.
 */
const SOURCES: ReadonlyArray<WorkflowInspectorSource> = [piWorkflowInspectorSource];

export function workflowInspectorSourceFor(
  driver: string | null | undefined,
): WorkflowInspectorSource | null {
  if (!driver) {
    return null;
  }
  return SOURCES.find((source) => source.driver === driver) ?? null;
}

function bounded(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= TRANSCRIPT_TEXT_LIMIT
    ? trimmed
    : `${trimmed.slice(0, TRANSCRIPT_TEXT_LIMIT - 1)}…`;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function payloadOf(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function formatElapsed(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) {
    return null;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

interface TranscriptBuffer {
  entries: WorkflowInspectorTranscriptEntry[];
  truncated: boolean;
  toolCount: number;
}

function pushEntry(buffer: TranscriptBuffer, entry: WorkflowInspectorTranscriptEntry): void {
  const previous = buffer.entries.at(-1);
  // Providers repeat the same heartbeat line while a tool runs; a transcript
  // of forty identical rows tells the user nothing.
  if (previous && previous.kind === entry.kind && previous.label === entry.label) {
    return;
  }
  if (entry.kind === "tool") {
    buffer.toolCount += 1;
  }
  buffer.entries.push(entry);
  if (buffer.entries.length > TRANSCRIPT_LIMIT) {
    buffer.entries.shift();
    buffer.truncated = true;
  }
}

/**
 * One pass over the activities collecting each agent's bounded transcript.
 * Attribution follows the persisted stamps the server already writes: task
 * rows belong to their `taskId`, tool rows to the owning agent the source
 * reads out of the payload.
 */
function collectTranscripts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  source: WorkflowInspectorSource,
): {
  readonly byAgentId: Map<string, TranscriptBuffer>;
  readonly unknownSchemaVersion: number | null;
} {
  const byAgentId = new Map<string, TranscriptBuffer>();
  let unknownSchemaVersion: number | null = null;

  const bufferFor = (agentId: string): TranscriptBuffer => {
    const existing = byAgentId.get(agentId);
    if (existing) {
      return existing;
    }
    const created: TranscriptBuffer = { entries: [], truncated: false, toolCount: 0 };
    byAgentId.set(agentId, created);
    return created;
  };

  for (const activity of activities) {
    const payload = payloadOf(activity);
    if (!payload) {
      continue;
    }

    const stampedVersion = source.readSchemaVersion(payload);
    if (
      stampedVersion !== null &&
      stampedVersion > source.supportedSchemaVersion &&
      (unknownSchemaVersion === null || stampedVersion > unknownSchemaVersion)
    ) {
      unknownSchemaVersion = stampedVersion;
    }

    switch (activity.kind) {
      case "task.progress": {
        const agentId = asText(payload.taskId);
        if (!agentId) break;
        const buffer = bufferFor(agentId);
        const summary = asText(payload.summary);
        if (summary) {
          pushEntry(buffer, {
            id: activity.id,
            at: activity.createdAt,
            kind: "progress",
            label: bounded(summary),
            detail: null,
          });
        }
        const toolName = asText(payload.lastToolName);
        if (toolName && !summary) {
          pushEntry(buffer, {
            id: activity.id,
            at: activity.createdAt,
            kind: "tool",
            label: bounded(toolName),
            detail: null,
          });
        }
        const error = asText(payload.error);
        if (error) {
          pushEntry(buffer, {
            id: `${activity.id}:error`,
            at: activity.createdAt,
            kind: "error",
            label: bounded(error),
            detail: null,
          });
        }
        break;
      }
      case "task.completed": {
        const agentId = asText(payload.taskId);
        if (!agentId) break;
        const summary = asText(payload.summary) ?? asText(payload.detail);
        if (!summary) break;
        pushEntry(bufferFor(agentId), {
          id: activity.id,
          at: activity.createdAt,
          kind: payload.status === "failed" ? "error" : "result",
          label: bounded(summary),
          detail: null,
        });
        break;
      }
      case "tool.progress": {
        const agentId = asText(payload.taskId) ?? source.readOwnerAgentId(payload);
        const toolName = asText(payload.toolName);
        if (!agentId || !toolName) break;
        pushEntry(bufferFor(agentId), {
          id: activity.id,
          at: activity.createdAt,
          kind: "tool",
          label: bounded(toolName),
          detail: null,
        });
        break;
      }
      case "tool.started":
      case "tool.updated":
      case "tool.completed": {
        const agentId = source.readOwnerAgentId(payload);
        if (!agentId) break;
        const label = asText(payload.toolName) ?? asText(payload.title) ?? activity.summary;
        pushEntry(bufferFor(agentId), {
          id: activity.id,
          at: activity.createdAt,
          kind: activity.tone === "error" ? "error" : "tool",
          label: bounded(label),
          detail: (() => {
            const detail = asText(payload.detail) ?? asText(payload.command);
            return detail ? bounded(detail) : null;
          })(),
        });
        break;
      }
      default:
        break;
    }
  }

  return { byAgentId, unknownSchemaVersion };
}

function toInspectorAgent(
  agent: RuntimeSubagent,
  transcripts: ReadonlyMap<string, TranscriptBuffer>,
): WorkflowInspectorAgent {
  const buffer = transcripts.get(agent.id);
  const needsAttention = agent.status === "failed" || agent.status === "waiting";
  return {
    id: agent.id,
    title: agent.title,
    role: agent.role,
    modelLabel: formatSubagentModelLabel(agent.model, agent.effort),
    status: agent.status,
    statusLabel: STATUS_LABELS[agent.status],
    needsAttention,
    // The task line is the spawn instruction; progress lines are transcript
    // rows, not the task, so a live agent still shows what it was asked for.
    task: agent.role && agent.role !== agent.title ? agent.role : agent.progress,
    result: agent.result,
    error: agent.error,
    elapsedLabel: formatElapsed(agent.startedAt, agent.completedAt),
    tokensLabel: agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null,
    toolCount: buffer?.toolCount ?? agent.usage?.toolUses ?? 0,
    transcript: buffer?.entries ?? [],
    transcriptTruncated: buffer?.truncated ?? false,
  };
}

function toInspectorWorkflow(
  group: AgentPanelWorkflowGroup,
  transcripts: ReadonlyMap<string, TranscriptBuffer>,
): WorkflowInspectorWorkflow {
  const phases = group.phases.map((phase) => {
    const agents = phase.members.map((member) => toInspectorAgent(member, transcripts));
    return {
      index: phase.index,
      title: phase.title,
      state: phase.state,
      parallel: agents.length > 1,
      needsAttention: agents.some((agent) => agent.needsAttention),
      agents,
    };
  });
  const looseAgents = group.unphasedMembers.map((member) => toInspectorAgent(member, transcripts));
  const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  const settledCount = members.filter((member) => isTerminalSubagentStatus(member.status)).length;
  return {
    id: group.workflow.id,
    name: group.workflow.workflowName ?? group.workflow.title,
    startedAt: group.workflow.startedAt,
    script: null,
    status: group.workflow.status,
    statusLabel: STATUS_LABELS[group.workflow.status],
    needsAttention:
      group.workflow.status === "failed" ||
      phases.some((phase) => phase.needsAttention) ||
      looseAgents.some((agent) => agent.needsAttention),
    elapsedLabel: formatElapsed(group.workflow.startedAt, group.workflow.completedAt),
    phases,
    looseAgents,
    coordinator: toInspectorAgent(group.workflow, transcripts),
    agentCount: members.length,
    settledCount,
  };
}

/**
 * Builds the inspector model for a thread. Returns the empty model (and no
 * work) when the thread's driver has no registered source, which is how the
 * surface stays provider-scoped without the caller branching on a driver id.
 */
export function deriveWorkflowInspectorModel(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly driver: string | null | undefined;
  readonly sessionLive?: boolean;
}): WorkflowInspectorModel {
  const source = workflowInspectorSourceFor(input.driver);
  if (!source) {
    return EMPTY_MODEL;
  }
  if (source.driver === PI_DRIVER_KIND) {
    const piModel = derivePiWorkflowInspectorModel(input.activities);
    if (piModel !== null) return piModel;
  }
  if (input.activities.length === 0) {
    return { ...EMPTY_MODEL, driver: source.driver, label: source.label };
  }

  const panel = deriveAgentPanelModel({
    agents: foldSubagentActivities(
      input.activities,
      input.sessionLive === undefined ? undefined : { sessionLive: input.sessionLive },
    ),
  });
  const { byAgentId, unknownSchemaVersion } = collectTranscripts(input.activities, source);

  const workflows = panel.workflows.map((group) => toInspectorWorkflow(group, byAgentId));
  const directAgents = panel.directAgents.map((agent) => toInspectorAgent(agent, byAgentId));

  let liveCount = 0;
  let needsAttentionCount = 0;
  const visit = (agent: WorkflowInspectorAgent): void => {
    if (isActiveSubagentStatus(agent.status)) liveCount += 1;
    if (agent.needsAttention) needsAttentionCount += 1;
  };
  for (const workflow of workflows) {
    if (isActiveSubagentStatus(workflow.status)) liveCount += 1;
    for (const phase of workflow.phases) phase.agents.forEach(visit);
    workflow.looseAgents.forEach(visit);
  }
  directAgents.forEach(visit);

  return {
    driver: source.driver,
    label: source.label,
    workflows,
    directAgents,
    hasActivity: workflows.length > 0 || directAgents.length > 0,
    liveCount,
    needsAttentionCount,
    unknownSchemaVersion,
  };
}

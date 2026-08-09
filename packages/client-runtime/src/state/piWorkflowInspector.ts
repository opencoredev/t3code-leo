// @effect-diagnostics globalDate:off -- elapsed labels compare persisted ISO timestamps.
/**
 * Pi source for the workflow inspector: the ONLY place Pi-shaped payload
 * knowledge lives. The generic derive (workflowInspector.ts) never branches
 * on a driver; it asks a source these questions instead.
 *
 * Pi runs its subagents through the same orchestration task/tool activities
 * every native provider emits, so identity, phases, and status come from the
 * shared stamps. What is Pi-specific is the workflow payload version stamp
 * (Pi ships workflow schema changes ahead of clients, so an older client must
 * be able to say "this run uses a newer format" instead of silently drawing a
 * wrong tree) and which payload key names the owning agent on a tool row.
 */
import { ProviderDriverKind, type OrchestrationThreadActivity } from "@t3tools/contracts";

import type {
  WorkflowInspectorAgent,
  WorkflowInspectorModel,
  WorkflowInspectorPhase,
  WorkflowInspectorSource,
  WorkflowInspectorWorkflow,
} from "./workflowInspector.ts";
import type { RuntimeSubagentStatus } from "./subagentRuntime.ts";

/** Reserved driver kind for the Pi provider. */
export const PI_DRIVER_KIND = ProviderDriverKind.make("piAgent");

/**
 * Payload schema this build renders. A run stamped higher is rendered with
 * whatever fields still parse, plus an explicit "newer format" notice — a
 * blank panel would read as "nothing happened".
 */
export const PI_WORKFLOW_SCHEMA_VERSION = 1;

function readVersion(payload: Record<string, unknown>): number | null {
  const raw = payload.workflowSchemaVersion ?? payload.schemaVersion;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  // Unstamped payloads predate the stamp and are version 1 by definition;
  // reporting null keeps them out of the unknown-version path.
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readOwnerAgentId(payload: Record<string, unknown>): string | null {
  const agentId = payload.agentId;
  return typeof agentId === "string" && agentId.trim().length > 0 ? agentId.trim() : null;
}

export const piWorkflowInspectorSource: WorkflowInspectorSource = {
  driver: PI_DRIVER_KIND,
  label: "Pi workflows",
  supportedSchemaVersion: PI_WORKFLOW_SCHEMA_VERSION,
  readSchemaVersion: readVersion,
  readOwnerAgentId,
};

const statusLabel = (status: RuntimeSubagentStatus): string =>
  ({
    pending: "Queued",
    running: "Running",
    waiting: "Needs attention",
    idle: "Idle",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Stopped",
    interrupted: "Stopped",
  })[status];

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function toolCallId(payload: Record<string, unknown>): string | null {
  const data = payload["data"];
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)["toolCallId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function workflowScriptOf(payload: Record<string, unknown>): string | null {
  const data = payload["data"];
  if (typeof data !== "object" || data === null) return null;
  const rawInput = (data as Record<string, unknown>)["rawInput"];
  if (typeof rawInput !== "object" || rawInput === null) return null;
  const script = (rawInput as Record<string, unknown>)["script"];
  return typeof script === "string" && script.length > 0 ? script : null;
}

/** Best-effort per-label agent prompts recovered from the workflow script. */
function extractAgentPrompts(script: string): ReadonlyMap<string, string> {
  const prompts = new Map<string, string>();
  const pattern = /agent\(\s*(['"`])([\s\S]*?)\1\s*,\s*\{[\s\S]*?label:\s*(['"`])([^'"`]+)\3/g;
  for (const match of script.matchAll(pattern)) {
    const prompt = match[2]?.trim();
    const label = match[4]?.trim();
    if (prompt && label && !prompts.has(label)) prompts.set(label, prompt);
  }
  return prompts;
}

function extractWorkflowDescription(script: string): string | null {
  const match = script.match(/description:\s*(['"`])([\s\S]*?)\1/);
  return match?.[2]?.trim() || null;
}

/** Truncated tree labels still deserve their full prompt when one label matches. */
function promptForLabel(prompts: ReadonlyMap<string, string>, title: string): string | null {
  const direct = prompts.get(title);
  if (direct) return direct;
  const prefix = title.replace(/\.\.\.$|…$/, "").trim();
  if (prefix.length < 3) return null;
  for (const [label, prompt] of prompts) {
    if (label.startsWith(prefix) || prefix.startsWith(label)) return prompt;
  }
  return null;
}

function extractFinalResult(detail: string): string | null {
  const index = detail.indexOf("Result:");
  if (index === -1) return detail.trim() || null;
  return detail.slice(index + "Result:".length).trim() || null;
}

function elapsedLabel(startedAt: string, completedAt: string | null): string | null {
  if (completedAt === null) return null;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const seconds = Math.floor(elapsed / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function markerStatus(marker: string): RuntimeSubagentStatus {
  if (marker === "✓") return "completed";
  if (marker === "✕" || marker === "×") return "failed";
  if (marker === "!" || marker === "⚠") return "waiting";
  if (marker === "●") return "running";
  return "pending";
}

/** One parsed ◆ progress tree. Later snapshots refresh markers; earlier
 * snapshots often carry the untruncated titles the last one clipped. */
interface RawTree {
  readonly name: string;
  readonly headerState: string;
  readonly phases: Array<{
    marker: string;
    title: string;
    agents: Map<number, { marker: string; title: string }>;
  }>;
}

const isClipped = (title: string) => title.endsWith("...") || title.endsWith("…");

function parseTree(detail: string): RawTree | null {
  const lines = detail.split("\n");
  const header = lines[1]?.match(/^◆ Workflow: (.+?) \(/);
  if (!header?.[1]) return null;
  const phases: RawTree["phases"] = [];
  let current: RawTree["phases"][number] | null = null;
  for (const line of lines.slice(2)) {
    const phase = line.match(/^  ([▶✓✕×!⚠○]) (.+?)(?: \d+\/\d+.*)?$/);
    if (phase?.[1] && phase[2]) {
      current = { title: phase[2].trim(), marker: phase[1], agents: new Map() };
      phases.push(current);
      continue;
    }
    const agent = line.match(/^\s{4}#(\d+)\s+([●✓✕×!⚠○])\s+(.+)$/);
    if (!agent?.[1] || !agent[2] || !agent[3] || current === null) continue;
    current.agents.set(Number(agent[1]), { marker: agent[2], title: agent[3].trim() });
  }
  return { name: header[1], headerState: lines[0]?.toLowerCase() ?? "", phases };
}

const preferTitle = (current: string, incoming: string): string => {
  if (isClipped(current) && !isClipped(incoming)) return incoming;
  if (!isClipped(current) && isClipped(incoming)) return current;
  return incoming.length > current.length ? incoming : current;
};

/** Folds every snapshot: markers track the latest tree, titles keep the best. */
function mergeTrees(details: ReadonlyArray<string>): RawTree | null {
  let merged: RawTree | null = null;
  for (const detail of details) {
    const tree = parseTree(detail);
    if (tree === null) continue;
    if (merged === null) {
      merged = tree;
      continue;
    }
    merged = {
      name: preferTitle(merged.name, tree.name),
      headerState: tree.headerState,
      phases: tree.phases.map((phase, index) => {
        const previous = merged?.phases[index];
        if (!previous) return phase;
        const agents = new Map(previous.agents);
        for (const [agentIndex, agent] of phase.agents) {
          const existing = agents.get(agentIndex);
          agents.set(agentIndex, {
            marker: agent.marker,
            title: existing ? preferTitle(existing.title, agent.title) : agent.title,
          });
        }
        return {
          marker: phase.marker,
          title: preferTitle(previous.title, phase.title),
          agents,
        };
      }),
    };
  }
  return merged;
}

function parseWorkflowSnapshot(input: {
  id: string;
  details: ReadonlyArray<string>;
  startedAt: string;
  completedAt: string | null;
  finalResult: string | null;
  script: string | null;
}): WorkflowInspectorWorkflow | null {
  const prompts = input.script ? extractAgentPrompts(input.script) : new Map<string, string>();
  const description = input.script ? extractWorkflowDescription(input.script) : null;
  const tree = mergeTrees(input.details);
  if (tree === null) return null;
  const workflowStatus: RuntimeSubagentStatus = tree.headerState.includes("failed")
    ? "failed"
    : tree.headerState.includes("completed")
      ? "completed"
      : "running";

  const phases: Array<{ title: string; marker: string; agents: WorkflowInspectorAgent[] }> = [];
  for (const rawPhase of tree.phases) {
    const current: (typeof phases)[number] = {
      title: rawPhase.title,
      marker: rawPhase.marker,
      agents: [],
    };
    phases.push(current);
    for (const [agentIndex, rawAgent] of [...rawPhase.agents.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const status = markerStatus(rawAgent.marker);
      const title = rawAgent.title;
      current.agents.push(makeAgent(input, agentIndex, title, status, prompts));
    }
  }
  return buildWorkflow(input, tree.name, workflowStatus, phases, description);
}

function makeAgent(
  input: { id: string; startedAt: string; completedAt: string | null },
  agentIndex: number,
  title: string,
  status: RuntimeSubagentStatus,
  prompts: ReadonlyMap<string, string>,
): WorkflowInspectorAgent {
  return {
    id: `${input.id}:${agentIndex}`,
    title,
    role: null,
    modelLabel: null,
    status,
    statusLabel: statusLabel(status),
    needsAttention: status === "failed" || status === "waiting",
    task: promptForLabel(prompts, title) ?? title,
    result: status === "completed" ? "Completed" : null,
    error: status === "failed" ? "Agent failed" : null,
    elapsedLabel: null,
    tokensLabel: null,
    toolCount: 0,
    transcript: [
      {
        id: `${input.id}:${agentIndex}:${status}`,
        at: input.completedAt ?? input.startedAt,
        kind: status === "failed" ? "error" : status === "completed" ? "result" : "progress",
        label: statusLabel(status),
        detail: null,
      },
    ],
    transcriptTruncated: false,
  };
}

function buildWorkflow(
  input: { id: string; startedAt: string; completedAt: string | null; finalResult: string | null },
  name: string,
  workflowStatus: RuntimeSubagentStatus,
  phases: Array<{ title: string; marker: string; agents: WorkflowInspectorAgent[] }>,
  description: string | null,
): WorkflowInspectorWorkflow {
  const mappedPhases: WorkflowInspectorPhase[] = phases.map((phase, index) => ({
    index,
    title: phase.title,
    state: phase.marker === "✓" ? "done" : phase.marker === "▶" ? "running" : "pending",
    parallel: phase.agents.length > 1,
    needsAttention: phase.agents.some((agent) => agent.needsAttention),
    agents: phase.agents,
  }));
  const agents = mappedPhases.flatMap((phase) => phase.agents);
  const coordinator: WorkflowInspectorAgent = {
    id: input.id,
    title: name,
    role: description,
    modelLabel: null,
    status: workflowStatus,
    statusLabel: statusLabel(workflowStatus),
    needsAttention: workflowStatus === "failed",
    task: name,
    result: input.finalResult,
    error: workflowStatus === "failed" ? input.finalResult : null,
    elapsedLabel: elapsedLabel(input.startedAt, input.completedAt),
    tokensLabel: null,
    toolCount: 0,
    transcript: [],
    transcriptTruncated: false,
  };
  return {
    id: input.id,
    name,
    startedAt: input.startedAt,
    script: null,
    status: workflowStatus,
    statusLabel: statusLabel(workflowStatus),
    needsAttention: coordinator.needsAttention || agents.some((agent) => agent.needsAttention),
    elapsedLabel: coordinator.elapsedLabel,
    phases: mappedPhases,
    looseAgents: [],
    coordinator,
    agentCount: agents.length,
    settledCount: agents.filter((agent) =>
      ["completed", "failed", "cancelled", "interrupted"].includes(agent.status),
    ).length,
  };
}

/** Derives Pi workflow state from the workflow tool's persisted progress snapshots. */
export function derivePiWorkflowInspectorModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkflowInspectorModel | null {
  const groups = new Map<
    string,
    {
      startedAt: string;
      updatedAt: string;
      details: string[];
      finalResult: string | null;
      script: string | null;
    }
  >();
  for (const activity of activities) {
    if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") continue;
    const payload = activityPayload(activity);
    if (!payload) continue;
    const id = toolCallId(payload);
    const detail = typeof payload["detail"] === "string" ? payload["detail"] : null;
    if (!id || !detail || !detail.includes("Workflow")) continue;
    const previous = groups.get(id);
    const next = previous ?? {
      startedAt: activity.createdAt,
      updatedAt: activity.createdAt,
      details: [],
      finalResult: null,
      script: null,
    };
    next.updatedAt = activity.createdAt;
    if (next.script === null) next.script = workflowScriptOf(payload);
    if (detail.includes("◆ Workflow:")) next.details.push(detail);
    if (activity.kind === "tool.completed") next.finalResult = extractFinalResult(detail);
    groups.set(id, next);
  }
  if (groups.size === 0) return null;

  const workflows = [...groups.entries()].toReversed().flatMap(([id, group]) => {
    if (group.details.length === 0) return [];
    const completed =
      group.finalResult !== null ||
      (group.details.at(-1)?.startsWith("Workflow completed") ?? false);
    const parsed = parseWorkflowSnapshot({
      id,
      details: group.details,
      startedAt: group.startedAt,
      completedAt: completed ? group.updatedAt : null,
      finalResult: group.finalResult,
      script: group.script,
    });
    return parsed === null ? [] : [{ ...parsed, script: group.script }];
  });
  if (workflows.length === 0) return null;
  return {
    driver: PI_DRIVER_KIND,
    label: "Pi workflows",
    workflows,
    directAgents: [],
    hasActivity: true,
    liveCount: workflows.filter((workflow) => workflow.status === "running").length,
    needsAttentionCount: workflows.filter((workflow) => workflow.needsAttention).length,
    unknownSchemaVersion: null,
  };
}

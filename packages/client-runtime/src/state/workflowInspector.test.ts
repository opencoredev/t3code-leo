import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PI_DRIVER_KIND, PI_WORKFLOW_SCHEMA_VERSION } from "./piWorkflowInspector.ts";
import {
  deriveWorkflowInspectorModel,
  emptyWorkflowInspectorModel,
  workflowInspectorSourceFor,
  workflowInspectorStatusLabel,
} from "./workflowInspector.ts";

let sequence = 0;

/** Post-ingestion row: the server stamps agentKind on every task payload. */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  options?: { readonly tone?: string },
): OrchestrationThreadActivity {
  sequence += 1;
  const stamped =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `activity-${sequence}`,
    tone: options?.tone ?? "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

/** One coordinator, two parallel children in phase 0, one child in phase 1. */
function workflowRun(): OrchestrationThreadActivity[] {
  return [
    activity("task.started", {
      taskId: "wf-1",
      taskType: "local_workflow",
      title: "Ship the inspector",
      workflowName: "ship-inspector",
      phases: [
        { index: 0, title: "Scout" },
        { index: 1, title: "Build" },
      ],
    }),
    activity("task.started", {
      taskId: "wf-1:wf:scout-a",
      parentAgentId: "wf-1",
      title: "Scout A",
      role: "read the adapters",
      model: "claude-sonnet-5",
      phaseIndex: 0,
      phaseTitle: "Scout",
      agentIndex: 0,
    }),
    activity("task.started", {
      taskId: "wf-1:wf:scout-b",
      parentAgentId: "wf-1",
      title: "Scout B",
      model: "gpt-6",
      phaseIndex: 0,
      phaseTitle: "Scout",
      agentIndex: 1,
    }),
    activity("tool.progress", { taskId: "wf-1:wf:scout-a", toolName: "read_file" }),
    activity("tool.completed", {
      agentId: "wf-1:wf:scout-a",
      toolName: "grep",
      detail: "matched 3 files",
    }),
    activity("task.completed", {
      taskId: "wf-1:wf:scout-a",
      status: "completed",
      summary: "Found the adapter boundary",
    }),
    activity("task.completed", {
      taskId: "wf-1:wf:scout-b",
      status: "failed",
      summary: "Could not open the workspace",
    }),
    activity("task.started", {
      taskId: "wf-1:wf:build",
      parentAgentId: "wf-1",
      title: "Builder",
      phaseIndex: 1,
      phaseTitle: "Build",
      agentIndex: 0,
    }),
  ];
}

describe("workflowInspectorSourceFor", () => {
  it("resolves the Pi source and nothing else", () => {
    expect(workflowInspectorSourceFor(PI_DRIVER_KIND)?.driver).toBe(PI_DRIVER_KIND);
    expect(workflowInspectorSourceFor("codex")).toBeNull();
    expect(workflowInspectorSourceFor(null)).toBeNull();
  });
});

describe("deriveWorkflowInspectorModel", () => {
  it("returns the empty model for an unsupported driver", () => {
    const model = deriveWorkflowInspectorModel({
      activities: workflowRun(),
      driver: "codex",
    });
    expect(model).toBe(emptyWorkflowInspectorModel());
    expect(model.hasActivity).toBe(false);
  });

  it("returns an empty but labelled model when a Pi thread has no activity", () => {
    const model = deriveWorkflowInspectorModel({ activities: [], driver: PI_DRIVER_KIND });
    expect(model.hasActivity).toBe(false);
    expect(model.driver).toBe(PI_DRIVER_KIND);
    expect(model.label).toBe("Pi workflows");
  });

  it("builds the phase tree with parallel branches and child status", () => {
    const model = deriveWorkflowInspectorModel({
      activities: workflowRun(),
      driver: PI_DRIVER_KIND,
    });

    expect(model.hasActivity).toBe(true);
    expect(model.workflows).toHaveLength(1);
    const workflow = model.workflows[0]!;
    expect(workflow.name).toBe("ship-inspector");
    expect(workflow.phases.map((phase) => phase.title)).toEqual(["Scout", "Build"]);
    expect(workflow.phases[0]!.parallel).toBe(true);
    expect(workflow.phases[0]!.state).toBe("done");
    expect(workflow.phases[1]!.parallel).toBe(false);
    expect(workflow.phases[1]!.state).toBe("running");
    expect(workflow.agentCount).toBe(3);
    expect(workflow.settledCount).toBe(2);

    const [scoutA, scoutB] = workflow.phases[0]!.agents;
    expect(scoutA!.status).toBe("completed");
    expect(scoutA!.result).toBe("Found the adapter boundary");
    expect(scoutA!.modelLabel).toBe("sonnet-5");
    expect(scoutA!.task).toBe("read the adapters");
    expect(scoutA!.elapsedLabel).toMatch(/^\d+s$/);
    expect(scoutB!.status).toBe("failed");
    expect(scoutB!.needsAttention).toBe(true);
  });

  it("collects a bounded per-agent transcript from tool and task rows", () => {
    const model = deriveWorkflowInspectorModel({
      activities: workflowRun(),
      driver: PI_DRIVER_KIND,
    });
    const scoutA = model.workflows[0]!.phases[0]!.agents[0]!;

    expect(scoutA.transcript.map((entry) => `${entry.kind}:${entry.label}`)).toEqual([
      "tool:read_file",
      "tool:grep",
      "result:Found the adapter boundary",
    ]);
    expect(scoutA.transcript[1]!.detail).toBe("matched 3 files");
    expect(scoutA.toolCount).toBe(2);
    expect(scoutA.transcriptTruncated).toBe(false);
  });

  it("caps the transcript and marks it truncated", () => {
    const activities = [
      activity("task.started", { taskId: "solo", title: "Solo" }),
      ...Array.from({ length: 60 }, (_unused, index) =>
        activity("tool.progress", { taskId: "solo", toolName: `tool_${index}` }),
      ),
    ];
    const model = deriveWorkflowInspectorModel({ activities, driver: PI_DRIVER_KIND });
    const agent = model.directAgents[0]!;

    expect(agent.transcript).toHaveLength(40);
    expect(agent.transcriptTruncated).toBe(true);
    expect(agent.transcript.at(-1)!.label).toBe("tool_59");
  });

  it("drops consecutive duplicate transcript rows", () => {
    const activities = [
      activity("task.started", { taskId: "solo", title: "Solo" }),
      activity("tool.progress", { taskId: "solo", toolName: "bash" }),
      activity("tool.progress", { taskId: "solo", toolName: "bash" }),
      activity("tool.progress", { taskId: "solo", toolName: "bash" }),
    ];
    const model = deriveWorkflowInspectorModel({ activities, driver: PI_DRIVER_KIND });

    expect(model.directAgents[0]!.transcript).toHaveLength(1);
  });

  it("reports a payload version this build does not understand", () => {
    const activities = [
      activity("task.started", {
        taskId: "wf-2",
        taskType: "local_workflow",
        title: "Future run",
        workflowSchemaVersion: PI_WORKFLOW_SCHEMA_VERSION + 3,
      }),
    ];
    const model = deriveWorkflowInspectorModel({ activities, driver: PI_DRIVER_KIND });

    expect(model.unknownSchemaVersion).toBe(PI_WORKFLOW_SCHEMA_VERSION + 3);
    // Still renders what it understands: a blank panel would read as "nothing
    // happened" on a run that is plainly in flight.
    expect(model.workflows).toHaveLength(1);
  });

  it("treats unstamped payloads as the supported version", () => {
    const model = deriveWorkflowInspectorModel({
      activities: workflowRun(),
      driver: PI_DRIVER_KIND,
    });
    expect(model.unknownSchemaVersion).toBeNull();
  });

  it("counts live agents and settles them when the session is gone", () => {
    const live = deriveWorkflowInspectorModel({
      activities: workflowRun(),
      driver: PI_DRIVER_KIND,
      sessionLive: true,
    });
    expect(live.liveCount).toBeGreaterThan(0);
    expect(live.needsAttentionCount).toBe(1);

    const dead = deriveWorkflowInspectorModel({
      activities: workflowRun(),
      driver: PI_DRIVER_KIND,
      sessionLive: false,
    });
    expect(dead.liveCount).toBe(0);
    expect(dead.workflows[0]!.phases[1]!.agents[0]!.status).toBe("interrupted");
  });

  it("keeps members whose phase never arrived reachable", () => {
    const activities = [
      activity("task.started", {
        taskId: "wf-3",
        taskType: "local_workflow",
        title: "Orphan run",
      }),
      activity("task.started", {
        taskId: "wf-3:wf:orphan",
        parentAgentId: "wf-3",
        title: "Orphan",
      }),
    ];
    const model = deriveWorkflowInspectorModel({ activities, driver: PI_DRIVER_KIND });

    expect(model.workflows[0]!.phases).toHaveLength(0);
    expect(model.workflows[0]!.looseAgents.map((agent) => agent.title)).toEqual(["Orphan"]);
  });
});

describe("Pi structured workflow snapshots", () => {
  it("renders every agent and full phase titles from the structured payload", () => {
    // The rendered tree clips agents and truncates titles; the structured
    // payload is authoritative, so a clipped tree must not win.
    const model = deriveWorkflowInspectorModel({
      driver: PI_DRIVER_KIND,
      activities: [
        activity("tool.updated", {
          detail:
            "Workflow running\n◆ Workflow: audit (1/4 done, 3 running)\n  ▶ Reference and cur... 1/4\n    #1 ● api\n    #2 ✓ site...",
          data: {
            toolCallId: "call-1",
            rawOutput: {
              name: "audit",
              description: "Parallel audit",
              phases: ["Reference and current-state audit"],
              currentPhase: "Reference and current-state audit",
              agentCount: 4,
              doneCount: 1,
              runningCount: 3,
              errorCount: 0,
              agents: [
                {
                  id: 1,
                  label: "email-sdk api",
                  phase: "Reference and current-state audit",
                  prompt: "Read the repository at /repo",
                  status: "running",
                },
                {
                  id: 2,
                  label: "email-sdk site",
                  phase: "Reference and current-state audit",
                  prompt: "Read the docs site",
                  status: "done",
                  resultPreview: "Docs live in apps/docs",
                },
                {
                  id: 3,
                  label: "sandbox-sdk api",
                  phase: "Reference and current-state audit",
                  prompt: "Read the SDK package",
                  status: "running",
                },
                {
                  id: 4,
                  label: "sandbox-sdk site",
                  phase: "Reference and current-state audit",
                  prompt: "Read the marketing surface",
                  status: "running",
                },
              ],
            },
          },
        }),
      ],
    });

    const workflow = model.workflows[0];
    expect(workflow?.status).toBe("running");
    expect(workflow?.agentCount).toBe(4);
    expect(workflow?.settledCount).toBe(1);
    expect(workflow?.phases[0]?.title).toBe("Reference and current-state audit");
    expect(workflow?.phases[0]?.agents.map((agent) => agent.title)).toEqual([
      "email-sdk api",
      "email-sdk site",
      "sandbox-sdk api",
      "sandbox-sdk site",
    ]);
    // Each agent carries its own full prompt and its own reported result.
    expect(workflow?.phases[0]?.agents[0]?.task).toBe("Read the repository at /repo");
    expect(workflow?.phases[0]?.agents[1]?.result).toBe("Docs live in apps/docs");
    expect(workflow?.phases[0]?.agents[1]?.statusLabel).toBe("Completed");
  });
});

describe("Pi workflow progress snapshots", () => {
  it("derives phases and selectable agents from persisted workflow tool updates", () => {
    const toolCallId = "workflow-call-1";
    const model = deriveWorkflowInspectorModel({
      driver: PI_DRIVER_KIND,
      activities: [
        activity("tool.updated", {
          detail:
            "Workflow running\n◆ Workflow: dynamic_scan (1/2 done, 1 running)\n  ✓ Discover 1/1\n    #1 ✓ discover projects\n  ▶ Inspect 0/1 · 1 running\n    #2 ● inspect project",
          data: { toolCallId },
        }),
        activity("tool.updated", {
          detail:
            "Workflow completed\n◆ Workflow: dynamic_scan (2/2 done)\n  ✓ Discover 1/1\n    #1 ✓ discover projects\n  ✓ Inspect 1/1\n    #2 ✓ inspect project",
          data: { toolCallId },
        }),
        activity("tool.completed", {
          detail: "Workflow dynamic_scan completed with 2 agent(s).",
          data: { toolCallId },
        }),
      ],
    });

    expect(model.hasActivity).toBe(true);
    expect(model.workflows[0]?.name).toBe("dynamic_scan");
    expect(model.workflows[0]?.status).toBe("completed");
    expect(model.workflows[0]?.phases.map((phase) => phase.title)).toEqual(["Discover", "Inspect"]);
    expect(model.workflows[0]?.agentCount).toBe(2);
  });
});

describe("workflowInspectorStatusLabel", () => {
  it("names every status for screen readers", () => {
    expect(workflowInspectorStatusLabel("waiting")).toBe("Needs attention");
    expect(workflowInspectorStatusLabel("interrupted")).toBe("Stopped");
    expect(workflowInspectorStatusLabel("running")).toBe("Running");
  });
});

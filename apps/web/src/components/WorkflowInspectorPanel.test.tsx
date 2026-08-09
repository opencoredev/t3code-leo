import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PI_DRIVER_KIND } from "@t3tools/client-runtime/state/pi-workflow-inspector";
import {
  deriveWorkflowInspectorModel,
  emptyWorkflowInspectorModel,
} from "@t3tools/client-runtime/state/workflow-inspector";

import { WorkflowInspectorPanel } from "./WorkflowInspectorPanel";

let sequence = 0;

function activity(kind: string, payload: Record<string, unknown>): OrchestrationThreadActivity {
  sequence += 1;
  const stamped = kind.startsWith("task.")
    ? {
        ...payload,
        agentKind: classifyTaskAgentKind({
          taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
        }),
      }
    : payload;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

function runActivities(extraPayload: Record<string, unknown> = {}): OrchestrationThreadActivity[] {
  return [
    activity("task.started", {
      taskId: "wf-1",
      taskType: "local_workflow",
      title: "Ship it",
      workflowName: "ship-it",
      phases: [{ index: 0, title: "Scout" }],
      ...extraPayload,
    }),
    activity("task.started", {
      taskId: "wf-1:wf:a",
      parentAgentId: "wf-1",
      title: "Scout A",
      phaseIndex: 0,
      phaseTitle: "Scout",
      agentIndex: 0,
    }),
    activity("task.started", {
      taskId: "wf-1:wf:b",
      parentAgentId: "wf-1",
      title: "Scout B",
      phaseIndex: 0,
      phaseTitle: "Scout",
      agentIndex: 1,
    }),
    activity("task.completed", {
      taskId: "wf-1:wf:b",
      status: "failed",
      summary: "Ran out of budget",
    }),
  ];
}

function renderPanel(props: Parameters<typeof WorkflowInspectorPanel>[0]): string {
  return renderToStaticMarkup(<WorkflowInspectorPanel {...props} />);
}

describe("WorkflowInspectorPanel", () => {
  it("shows the empty state when the thread has no workflow activity", () => {
    const markup = renderPanel({ model: emptyWorkflowInspectorModel() });
    expect(markup).toContain("No workflow runs yet");
    expect(markup).not.toContain("Scout A");
  });

  it("renders phase sections with agent cards and status", () => {
    const model = deriveWorkflowInspectorModel({
      activities: runActivities(),
      driver: PI_DRIVER_KIND,
    });
    const markup = renderPanel({ model });

    expect(markup).toContain("ship-it");
    expect(markup).toContain("Scout");
    expect(markup).toContain("2 parallel");
    expect(markup).toContain("Scout A");
    expect(markup).toContain("Scout B");
    expect(markup).toContain("Failed");
    expect(markup).toContain("1 need attention");
  });

  it("warns when the run uses a newer workflow format", () => {
    const model = deriveWorkflowInspectorModel({
      activities: runActivities({ workflowSchemaVersion: 9 }),
      driver: PI_DRIVER_KIND,
    });
    const markup = renderPanel({ model });

    expect(markup).toContain("Newer workflow format (v9)");
    // The overview still renders what it understands.
    expect(markup).toContain("Scout A");
  });

  it("says the tree is the last saved run while the session is gone", () => {
    const model = deriveWorkflowInspectorModel({
      activities: runActivities(),
      driver: PI_DRIVER_KIND,
      sessionLive: false,
    });
    const markup = renderPanel({ model, disconnected: true });

    expect(markup).toContain("Session disconnected");
  });
});

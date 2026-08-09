import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload agent-field survival", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});

/**
 * The Pi workflow tool reports the whole run as structured data. Clients build
 * the workflow inspector from it, and the rendered `detail` tree is clipped, so
 * dropping this snapshot leaves the UI with a partial run.
 */
describe("projectActivityPayload workflow snapshot", () => {
  it("keeps every agent, prompt, and count for the client", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail:
          "Workflow running\n◆ Workflow: audit (1/4 done, 3 running)\n  ▶ Reference and cur...",
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
              { id: 1, label: "api", phase: "Audit", prompt: "Read the repo", status: "running" },
              {
                id: 2,
                label: "site",
                phase: "Audit",
                prompt: "Read the docs",
                status: "done",
                resultPreview: "Docs live in apps/docs",
              },
            ],
          },
        },
      }),
    );

    const rawOutput = (projected.payload as { data: { rawOutput: Record<string, unknown> } }).data
      .rawOutput;
    expect(rawOutput.name).toBe("audit");
    expect(rawOutput.currentPhase).toBe("Reference and current-state audit");
    expect(rawOutput.doneCount).toBe(1);
    expect(rawOutput.agents).toHaveLength(2);
    expect((rawOutput.agents as ReadonlyArray<{ prompt: string }>)[0]?.prompt).toBe(
      "Read the repo",
    );
    expect((rawOutput.agents as ReadonlyArray<{ resultPreview?: string }>)[1]?.resultPreview).toBe(
      "Docs live in apps/docs",
    );
  });

  it("bounds long prompts so one run cannot bloat the payload", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        data: {
          rawOutput: {
            name: "audit",
            agents: [{ id: 1, label: "api", prompt: "x".repeat(9_000), status: "running" }],
          },
        },
      }),
    );

    const agents = (
      projected.payload as { data: { rawOutput: { agents: ReadonlyArray<{ prompt: string }> } } }
    ).data.rawOutput.agents;
    expect(agents[0]?.prompt.length).toBeLessThanOrEqual(4_000);
    expect(agents[0]?.prompt.endsWith("…")).toBe(true);
  });
});

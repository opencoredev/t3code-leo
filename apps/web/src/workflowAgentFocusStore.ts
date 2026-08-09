/**
 * Which workflow subagent's thread is taking over the chat area.
 *
 * The Workflows panel sets the focus; ChatView renders the subagent's
 * transcript over the main timeline until the user goes back. Scoped by thread
 * key so switching threads never leaks another thread's overlay.
 */
import type { RuntimeSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import { create } from "zustand";

export interface WorkflowAgentFocus {
  readonly threadKey: string;
  readonly agentId: string;
  readonly title: string;
  readonly status: RuntimeSubagentStatus;
  readonly statusLabel: string;
  readonly modelLabel: string | null;
  /** The agent's full prompt, recovered from the workflow script. */
  readonly prompt: string | null;
  readonly result: string | null;
  readonly error: string | null;
  /** Workflow start, bounding the server-side journal lookup. */
  readonly startedAt: string | null;
  /** Leading slice of the workflow script, for parent-journal recovery. */
  readonly scriptPrefix: string | null;
}

interface WorkflowAgentFocusStore {
  focus: WorkflowAgentFocus | null;
  open: (focus: WorkflowAgentFocus) => void;
  close: () => void;
}

export const useWorkflowAgentFocusStore = create<WorkflowAgentFocusStore>((set) => ({
  focus: null,
  open: (focus) => set({ focus }),
  close: () => set({ focus: null }),
}));

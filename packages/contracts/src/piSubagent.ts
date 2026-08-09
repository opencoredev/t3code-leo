/**
 * Pi subagent transcript contract.
 *
 * A Pi dynamic workflow runs each child agent as its own Pi session, journaled
 * on the server under Pi's agent directory. The client cannot read those files,
 * so the environment answers a bounded, chat-shaped projection of one child
 * session, located by the agent's prompt (recovered from the workflow script)
 * and the workflow's time window.
 *
 * @module piSubagent
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PiSubagentTranscriptInput = Schema.Struct({
  /** Leading slice of the child agent's prompt, used to locate its journal. */
  promptPrefix: TrimmedNonEmptyString,
  /** ISO timestamp the workflow started; bounds the journal search window. */
  startedAt: TrimmedNonEmptyString,
  /**
   * Leading slice of the workflow script, used to locate the parent journal
   * when the client only holds a truncated copy of the script.
   */
  scriptPrefix: Schema.optionalKey(Schema.String),
  /** The agent's label in the workflow script, for full-prompt recovery. */
  agentLabel: Schema.optionalKey(Schema.String),
});
export type PiSubagentTranscriptInput = typeof PiSubagentTranscriptInput.Type;

export const PiSubagentTranscriptEntryKind = Schema.Literals([
  "user",
  "assistant",
  "thinking",
  "tool",
  "toolResult",
]);
export type PiSubagentTranscriptEntryKind = typeof PiSubagentTranscriptEntryKind.Type;

export const PiSubagentTranscriptEntry = Schema.Struct({
  kind: PiSubagentTranscriptEntryKind,
  text: Schema.String,
  /** Tool name for tool entries; null elsewhere. */
  toolName: Schema.NullOr(Schema.String),
});
export type PiSubagentTranscriptEntry = typeof PiSubagentTranscriptEntry.Type;

export const PiSubagentTranscript = Schema.Struct({
  found: Schema.Boolean,
  /** Model that answered, when the journal recorded one. */
  model: Schema.NullOr(Schema.String),
  entries: Schema.Array(PiSubagentTranscriptEntry),
  truncated: Schema.Boolean,
  /** The agent's complete prompt, recovered from the parent journal's script. */
  fullPrompt: Schema.NullOr(Schema.String),
  /** The workflow's complete final result from the parent journal. */
  workflowResult: Schema.NullOr(Schema.String),
});
export type PiSubagentTranscript = typeof PiSubagentTranscript.Type;

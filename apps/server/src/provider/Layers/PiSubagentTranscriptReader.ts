// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads one Pi child-agent session journal into the chat-shaped transcript the
 * workflow inspector renders.
 *
 * Pi journals each workflow child under
 * `<agentDir>/sessions/<cwd-slug>/<parent-session>/<run>/run-N/session.jsonl`.
 * The workflow tool's persisted payload does not carry the child's path, so the
 * child is located by its prompt: the journal's first user message begins with
 * the exact prompt text the workflow script passed to `agent()`.
 *
 * Direct `node:fs` mirrors `usageTranscriptReader`: journals are scanned on a
 * page load and streaming is an order of magnitude cheaper than materialising.
 *
 * @module provider/Layers/PiSubagentTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type {
  PiSubagentTranscript,
  PiSubagentTranscriptEntry,
  PiSubagentTranscriptInput,
} from "@t3tools/contracts";

const MAX_CANDIDATE_FILES = 400;
const MAX_ENTRIES = 300;
const MAX_TEXT_LENGTH = 6_000;
const MAX_TOOL_RESULT_LENGTH = 1_500;
/** A child can start slightly before the parent's first persisted snapshot. */
const WINDOW_SLACK_MS = 5 * 60 * 1000;

const NOT_FOUND: PiSubagentTranscript = {
  found: false,
  model: null,
  entries: [],
  truncated: false,
  fullPrompt: null,
  workflowResult: null,
};

export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["PI_CODING_AGENT_DIR"]?.trim();
  if (configured && configured.length > 0) {
    if (configured === "~") return NodeOS.homedir();
    if (configured.startsWith("~/")) return NodePath.join(NodeOS.homedir(), configured.slice(2));
    return configured;
  }
  return NodePath.join(NodeOS.homedir(), ".pi", "agent");
}

function normalize(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function bounded(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

interface JournalScan {
  readonly firstUserText: string;
  readonly model: string | null;
  readonly entries: PiSubagentTranscriptEntry[];
  readonly truncated: boolean;
}

function pushEntry(
  scan: { entries: PiSubagentTranscriptEntry[]; truncated: boolean },
  entry: PiSubagentTranscriptEntry,
): void {
  if (scan.entries.length >= MAX_ENTRIES) {
    scan.truncated = true;
    return;
  }
  scan.entries.push(entry);
}

/** Streams one child journal into transcript entries. Returns null on read failure. */
async function scanJournal(filePath: string): Promise<JournalScan | null> {
  const scan = {
    firstUserText: "",
    model: null as string | null,
    entries: [] as PiSubagentTranscriptEntry[],
    truncated: false,
  };
  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;

      if (record["type"] === "model_change" && typeof record["modelId"] === "string") {
        scan.model = record["modelId"];
        continue;
      }
      if (record["type"] !== "message") continue;
      const message = record["message"];
      if (typeof message !== "object" || message === null) continue;
      const { role, content, model } = message as Record<string, unknown>;
      if (typeof model === "string" && model.length > 0) scan.model = model;

      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      if (!Array.isArray(blocks)) continue;
      for (const raw of blocks) {
        if (typeof raw !== "object" || raw === null) continue;
        const block = raw as Record<string, unknown>;
        if (block["type"] === "text" && typeof block["text"] === "string") {
          const text = block["text"];
          if (text.trim().length === 0) continue;
          if (role === "user") {
            if (scan.firstUserText === "") scan.firstUserText = text;
            pushEntry(scan, { kind: "user", text: bounded(text, MAX_TEXT_LENGTH), toolName: null });
          } else if (role === "toolResult") {
            pushEntry(scan, {
              kind: "toolResult",
              text: bounded(text, MAX_TOOL_RESULT_LENGTH),
              toolName: null,
            });
          } else if (role === "assistant") {
            pushEntry(scan, {
              kind: "assistant",
              text: bounded(text, MAX_TEXT_LENGTH),
              toolName: null,
            });
          }
          continue;
        }
        if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
          const thinking = block["thinking"].trim();
          if (thinking.length > 0) {
            pushEntry(scan, {
              kind: "thinking",
              text: bounded(thinking, MAX_TEXT_LENGTH),
              toolName: null,
            });
          }
          continue;
        }
        if (block["type"] === "toolCall") {
          const name = typeof block["name"] === "string" ? block["name"] : "tool";
          let args = "";
          try {
            args = JSON.stringify(block["arguments"] ?? {});
          } catch {
            args = "";
          }
          pushEntry(scan, {
            kind: "tool",
            text: bounded(args, 400),
            toolName: name,
          });
        }
      }
    }
  } catch {
    return null;
  }
  return scan;
}

/** The agent's full prompt, matched by label inside the workflow script. */
function promptFromScript(script: string, label: string): string | null {
  const pattern = /agent\(\s*(['"`])([\s\S]*?)\1\s*,\s*\{[\s\S]*?label:\s*(['"`])([^'"`]+)\3/g;
  const target = label.replace(/\.\.\.$|…$/, "").trim();
  for (const match of script.matchAll(pattern)) {
    const prompt = match[2]?.trim();
    const candidate = match[4]?.trim();
    if (!prompt || !candidate) continue;
    if (candidate === label || candidate.startsWith(target) || target.startsWith(candidate)) {
      return prompt;
    }
  }
  return null;
}

interface ParentScan {
  readonly script: string;
  readonly result: string | null;
}

/**
 * Finds the workflow tool call in a parent pi journal and returns its complete
 * script plus the complete tool result the persisted activity truncated.
 */
async function scanParentJournal(
  filePath: string,
  matchesScript: (script: string) => boolean,
): Promise<ParentScan | null> {
  let script: string | null = null;
  let awaitingResult = false;
  let result: string | null = null;
  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (record["type"] !== "message") continue;
      const message = record["message"];
      if (typeof message !== "object" || message === null) continue;
      const { role, content } = message as Record<string, unknown>;
      if (!Array.isArray(content)) continue;

      if (awaitingResult && role === "toolResult") {
        for (const raw of content) {
          if (typeof raw !== "object" || raw === null) continue;
          const block = raw as Record<string, unknown>;
          if (block["type"] === "text" && typeof block["text"] === "string") {
            result = block["text"];
            break;
          }
        }
        break;
      }
      if (role !== "assistant") continue;
      for (const raw of content) {
        if (typeof raw !== "object" || raw === null) continue;
        const block = raw as Record<string, unknown>;
        if (block["type"] !== "toolCall" || block["name"] !== "workflow") continue;
        const argumentsValue = block["arguments"];
        if (typeof argumentsValue !== "object" || argumentsValue === null) continue;
        const candidate = (argumentsValue as Record<string, unknown>)["script"];
        if (typeof candidate !== "string") continue;
        if (!matchesScript(candidate)) continue;
        script = candidate;
        awaitingResult = true;
      }
    }
  } catch {
    return null;
  }
  return script === null ? null : { script, result };
}

/**
 * Finds the child journal whose first user message carries the agent's prompt
 * and returns its transcript. Absence is an answer, never an error.
 */
export async function readPiSubagentTranscript(
  input: PiSubagentTranscriptInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiSubagentTranscript> {
  const sessionsDir = NodePath.join(resolvePiAgentDir(env), "sessions");
  const startedAtMs = Date.parse(input.startedAt);
  const sinceMs = Number.isNaN(startedAtMs) ? 0 : startedAtMs - WINDOW_SLACK_MS;

  // Child journals sit exactly at <cwd>/<parent>/<run>/run-N/session.jsonl;
  // parent journals are the .jsonl files directly under each cwd slug.
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const parents: Array<{ path: string; mtimeMs: number }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (candidates.length >= MAX_CANDIDATE_FILES) return;
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= MAX_CANDIDATE_FILES) return;
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) await walk(child, depth + 1);
        continue;
      }
      const isChildJournal = entry.name === "session.jsonl" && depth >= 3;
      const isParentJournal = depth === 1 && entry.name.endsWith(".jsonl");
      if (!isChildJournal && !isParentJournal) continue;
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs < sinceMs) continue;
        if (isChildJournal) candidates.push({ path: child, mtimeMs: stats.mtimeMs });
        else parents.push({ path: child, mtimeMs: stats.mtimeMs });
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };
  await walk(sessionsDir, 0);

  // The parent journal upgrades a truncated client-side script and prompt to
  // the complete versions, and carries the untruncated workflow result.
  let fullPrompt: string | null = null;
  let workflowResult: string | null = null;
  const scriptPrefix = normalize(input.scriptPrefix ?? "").slice(0, 160);
  // Clients often hold no copy of the script at all, so the label inside the
  // script is the fallback locator: `label: 'discover projects'`.
  const label = (input.agentLabel ?? "").replace(/\.\.\.$|…$/, "").trim();
  const matchesScript = (script: string): boolean => {
    if (scriptPrefix.length > 0 && normalize(script).startsWith(scriptPrefix)) return true;
    return label.length >= 3 && script.includes(label);
  };
  if (scriptPrefix.length > 0 || label.length >= 3) {
    parents.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const parent of parents) {
      const scan = await scanParentJournal(parent.path, matchesScript);
      if (scan === null) continue;
      workflowResult = scan.result;
      if (input.agentLabel) fullPrompt = promptFromScript(scan.script, input.agentLabel);
      break;
    }
  }

  const prefixes = [fullPrompt, input.promptPrefix]
    .flatMap((value) => (value ? [normalize(value).slice(0, 200)] : []))
    .filter((value) => value.length > 0);
  // Newest first: re-runs of the same prompt should resolve to the latest run.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const scan = await scanJournal(candidate.path);
    if (scan === null || scan.firstUserText === "") continue;
    const firstUser = normalize(scan.firstUserText);
    if (!prefixes.some((prefix) => firstUser.startsWith(prefix))) continue;
    return {
      found: true,
      model: scan.model,
      entries: scan.entries,
      truncated: scan.truncated,
      fullPrompt,
      workflowResult,
    };
  }
  return { ...NOT_FOUND, fullPrompt, workflowResult };
}

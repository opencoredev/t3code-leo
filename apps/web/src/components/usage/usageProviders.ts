import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, type Icon, OpenAI, PiAgentIcon } from "../Icons";

/**
 * Series and table order. The chart layers both providers from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the other.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["pi", "codex", "claude"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

/** Nightly palette, shared by the dithered chart and provider bars. */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  pi: "#4EA4FF",
  codex: "#696FEA",
  claude: "#A85BEA",
};

/**
 * Brand marks, reused from the provider picker.
 *
 * The marks keep provider identity while the chart and bars use the Nightly
 * palette consistently.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
  pi: PiAgentIcon,
};

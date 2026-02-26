// Thin re-exports — implementations now live in the Claude adapter.
export { claudeAdapter as _claudeAdapter } from "../providers";

import { claudeAdapter } from "../providers";
import type { ParsedOutput } from "../types";

export function parseOutput(logContent: string, skipLinesBefore = 0): ParsedOutput {
  return claudeAdapter.parseOutput(logContent, skipLinesBefore);
}

export function buildClaudeCommand(opts: {
  prompt?: string;
  resumeSessionId?: string;
  resumePrompt?: string;
  allowedTools?: string;
  maxTurns?: number;
  usePromptUrl?: boolean;
}): string[] {
  return claudeAdapter.buildCommand(opts);
}

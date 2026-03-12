// Task lifecycle — no workflow phases, no ticketing
export const TASK_STATUSES = ["queued", "running", "completed", "failed", "stopped", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskState {
  task_id: string; // UUID — not integer issue ID
  prompt: string;
  status: TaskStatus;
  branch: string;
  worktree: string;
  session_id: string | null;
  error: string | null;
  failure_reason: "max_turns" | "infrastructure" | "agent_aborted" | null;
  log_path: string;
  started_at: string;
  finished_at: string | null;
}

// What you pass to runTask()
export interface RunConfig {
  taskId: string; // caller-assigned UUID
  prompt: string;
  branch: string;
  projectRoot: string;
  worktreePrefix: string; // e.g. "/tmp/ysa-tasks/"
  provider?: string; // "claude" (default) | future providers
  model?: string; // model ID within the provider
  maxTurns?: number; // default 60
  allowedTools?: string[]; // override tool whitelist
  resumeSessionId?: string; // for continue after max_turns
  resumePrompt?: string; // custom prompt for session resume (refine)
  networkPolicy?: "none" | "strict" | "custom"; // default "none"
  promptUrl?: string; // URL for container to fetch prompt from
  shadowDirs?: string[]; // dirs to shadow with per-task volumes (default: ["node_modules"])
}

// What runTask() returns
export interface RunResult {
  task_id: string;
  status: TaskStatus;
  session_id: string | null;
  error: string | null;
  failure_reason: "max_turns" | "infrastructure" | "agent_aborted" | null;
  log_path: string;
  duration_ms: number;
}

// Minimal config for Core (Platform's AgentConfig extends this)
export interface CoreConfig {
  projectRoot: string;
  worktreePrefix: string;
  branchPrefix: string;
  dataDir: string; // where SQLite DB + logs live (e.g. ~/.ysa/)
}

export type { ParsedOutput, ParsedLogEntry } from "./providers/types";
export type { DetectedLanguage as Language } from "./runtime/detect-language";

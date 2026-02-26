export interface ParsedLogEntry {
  type: "system" | "assistant" | "tool_call" | "result" | "raw" | "network" | "progress";
  icon?: string;
  text: string;
  tool?: string;
  session_id?: string;
  cost?: number;
  turns?: number;
  ts?: number;
}

export interface ProviderModel {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface CommandOpts {
  prompt?: string;
  maxTurns?: number;
  allowedTools?: string;
  model?: string;
  usePromptUrl?: boolean;
  resumeSessionId?: string;
  resumePrompt?: string;
}

export interface ParsedOutput {
  sessionId: string | null;
  maxTurnsReached: boolean;
  agentAborted: boolean;
  abortReason: string | null;
  lastError: string | null;
}

export interface ContainerConfig {
  initScript: string;
  envVars: Record<string, string>;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  agentBinary: string;
  models: ProviderModel[];

  authEnvKeys: string[];
  getAuthEnv(): Promise<Record<string, string>>;

  buildCommand(opts: CommandOpts): string[];

  parseLogLine(line: string): ParsedLogEntry | null;
  parseOutput(logContent: string, skipLinesBefore?: number): ParsedOutput;
  extractSessionId(logContent: string): string | null;

  containerImage: string;
  bypassHosts: string[];
  initContainerConfig(opts?: { model?: string }): ContainerConfig;

  capabilities: {
    sessionResume: boolean;
    maxTurns: boolean;
    toolRestriction: boolean;
    hooks: boolean;
    streamingOutput: boolean;
    maxPrice: boolean;
  };

  mapToolNames(tools: string[]): string[];
}

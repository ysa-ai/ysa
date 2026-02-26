// Auth logic has moved into the Claude provider adapter.
// This file re-exports for backward compatibility.
import { claudeAdapter } from "../providers";

export async function getAuthEnv(): Promise<Record<string, string>> {
  return claudeAdapter.getAuthEnv();
}

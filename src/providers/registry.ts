import type { ProviderAdapter } from "./types";
import { claudeAdapter } from "./claude";
import { mistralAdapter } from "./mistral";

const registry = new Map<string, ProviderAdapter>([
  ["claude", claudeAdapter],
  ["mistral", mistralAdapter],
]);

export function getProvider(id: string): ProviderAdapter {
  const adapter = registry.get(id);
  if (!adapter) throw new Error(`Unknown provider: ${id}`);
  return adapter;
}

export function listProviders(): ProviderAdapter[] {
  return Array.from(registry.values());
}

export function registerProvider(adapter: ProviderAdapter): void {
  registry.set(adapter.id, adapter);
}

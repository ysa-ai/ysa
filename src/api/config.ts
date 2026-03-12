import { z } from "zod";
import { access } from "fs/promises";
import { join } from "path";
import { router, publicProcedure } from "./init";
import { getConfig, setConfig } from "./config-store";
import { getApiKey, setApiKey, hasApiKey } from "./keystore";
import { writeAuditLog } from "../lib/audit";

async function pickDirectoryNative(): Promise<string | null> {
  if (process.platform === "darwin") {
    const proc = Bun.spawn(
      ["osascript", "-e", 'POSIX path of (choose folder with prompt "Select your project root:")'],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim().replace(/\/+$/, "");
    return out || null;
  }
  // Linux: try zenity, then kdialog
  for (const [bin, ...args] of [
    ["zenity", "--file-selection", "--directory", "--title=Select project root"],
    ["kdialog", "--getexistingdirectory", "/"],
  ] as [string, ...string[]][]) {
    try {
      const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      const out = (await new Response(proc.stdout).text()).trim().replace(/\/+$/, "");
      if (out) return out;
    } catch {}
  }
  return null;
}

export const configRouter = router({
  get: publicProcedure.query(async () => {
    const config = getConfig();
    const [has_anthropic_key, has_mistral_key] = await Promise.all([
      hasApiKey("anthropic"),
      hasApiKey("mistral"),
    ]);
    let languages_list: string[] = [];
    try { languages_list = JSON.parse(config.languages ?? "[]"); } catch {}
    return { ...config, has_anthropic_key, has_mistral_key, languages_list };
  }),

  pickDirectory: publicProcedure.mutation(async () => {
    const path = await pickDirectoryNative();
    return { path };
  }),

  set: publicProcedure
    .input(
      z.object({
        project_root: z.string().optional(),
        default_model: z.string().nullable().optional(),
        default_network_policy: z.enum(["none", "strict"]).optional(),
        preferred_terminal: z.string().nullable().optional(),
        port: z.number().int().min(1024).max(65535).nullable().optional(),
        max_concurrent_tasks: z.number().int().min(1).max(100).optional(),
        languages: z.array(z.string()).optional(),
        shadow_dirs: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.project_root) {
        const hasGit = await access(join(input.project_root, ".git")).then(() => true).catch(() => false);
        if (!hasGit) {
          const proc = Bun.spawn(["git", "init", input.project_root], { stdout: "pipe", stderr: "pipe" });
          await proc.exited;
        }
      }
      const existing = getConfig();
      const { languages, shadow_dirs, ...rest } = input;
      const updates: Record<string, unknown> = { ...rest };
      if (languages !== undefined) updates.languages = JSON.stringify(languages);
      if (shadow_dirs !== undefined) updates.shadow_dirs = shadow_dirs;
      setConfig(updates);
      if (languages !== undefined && JSON.stringify(languages) !== (existing.languages ?? "[]")) {
        Bun.spawn(["podman", "volume", "rm", "mise-installs"], { stdout: "ignore", stderr: "ignore" });
      }
      const changedKeys = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
      writeAuditLog("config.set", { keys: changedKeys });
      return getConfig();
    }),

  detectLanguages: publicProcedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ input }) => {
      const normalizedPath = input.path.replace(/\/+$/, "");
      await access(normalizedPath).catch(() => {
        throw new Error(`Directory not found: ${normalizedPath}`);
      });
      const { detectAllLanguages } = await import("../runtime/detect-language");
      return detectAllLanguages(normalizedPath);
    }),

  setApiKey: publicProcedure
    .input(
      z.object({
        provider: z.enum(["anthropic", "mistral"]),
        value: z.string().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await setApiKey(input.provider, input.value);
      writeAuditLog("config.setApiKey", { provider: input.provider, cleared: input.value === null });
      return {
        has_anthropic_key: await hasApiKey("anthropic"),
        has_mistral_key: await hasApiKey("mistral"),
      };
    }),
});

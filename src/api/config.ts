import { z } from "zod";
import { access } from "fs/promises";
import { join } from "path";
import { router, publicProcedure } from "./init";
import { getConfig, setConfig } from "./config-store";

async function pickDirectoryNative(): Promise<string | null> {
  if (process.platform === "darwin") {
    const proc = Bun.spawn(
      ["osascript", "-e", 'POSIX path of (choose folder with prompt "Select your project root:")'],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
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
      const out = (await new Response(proc.stdout).text()).trim();
      if (out) return out;
    } catch {}
  }
  return null;
}

export const configRouter = router({
  get: publicProcedure.query(() => getConfig()),

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
        anthropic_api_key: z.string().nullable().optional(),
        mistral_api_key: z.string().nullable().optional(),
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
      setConfig(input);
      return getConfig();
    }),
});

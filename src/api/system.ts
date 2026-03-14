import { router, publicProcedure } from "./init";
import { getResourceMetrics } from "../lib/resources";
import { getBuildState } from "../lib/build-manager";
import { stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export type DetectedTerminal = {
  id: string;
  name: string;
};

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function detectTerminals(): Promise<DetectedTerminal[]> {
  const home = homedir();

  const candidates: { id: string; name: string; paths: string[]; binary?: string }[] = process.platform === "darwin"
    ? [
        { id: "ghostty",   name: "Ghostty",      paths: ["/Applications/Ghostty.app",   join(home, "Applications/Ghostty.app")] },
        { id: "iterm2",    name: "iTerm2",        paths: ["/Applications/iTerm.app",     join(home, "Applications/iTerm.app")] },
        { id: "alacritty", name: "Alacritty",     paths: ["/Applications/Alacritty.app", join(home, "Applications/Alacritty.app")] },
        { id: "kitty",     name: "Kitty",         paths: ["/Applications/kitty.app",     join(home, "Applications/kitty.app")] },
        { id: "wezterm",   name: "WezTerm",       paths: ["/Applications/WezTerm.app",   join(home, "Applications/WezTerm.app")] },
        { id: "terminal",  name: "Terminal",      paths: ["/System/Applications/Utilities/Terminal.app"] },
      ]
    : [
        { id: "ghostty",       name: "Ghostty",          paths: [], binary: "ghostty" },
        { id: "kitty",         name: "Kitty",             paths: [], binary: "kitty" },
        { id: "alacritty",     name: "Alacritty",         paths: [], binary: "alacritty" },
        { id: "wezterm",       name: "WezTerm",           paths: [], binary: "wezterm" },
        { id: "gnome-terminal",name: "GNOME Terminal",    paths: [], binary: "gnome-terminal" },
        { id: "konsole",       name: "Konsole",           paths: [], binary: "konsole" },
        { id: "xterm",         name: "xterm",             paths: [], binary: "xterm" },
      ];

  const available: DetectedTerminal[] = [];
  for (const t of candidates) {
    const foundPath = (await Promise.all(t.paths.map(exists))).some(Boolean);
    const foundBinary = t.binary
      ? (await exists(`/usr/bin/${t.binary}`) || await exists(`/usr/local/bin/${t.binary}`) || await exists(join(home, ".local/bin", t.binary)))
      : false;
    if (foundPath || foundBinary) {
      available.push({ id: t.id, name: t.name });
    }
  }
  return available;
}

async function checkBinary(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

async function checkDeps(): Promise<{ git: boolean; podman: boolean }> {
  const [git, podman] = await Promise.all([checkBinary("git"), checkBinary("podman")]);
  return { git, podman };
}

export const systemRouter = router({
  resources: publicProcedure.query(() => getResourceMetrics()),
  detectTerminals: publicProcedure.query(() => detectTerminals()),
  checkDeps: publicProcedure.query(() => checkDeps()),
  buildStatus: publicProcedure.query(() => getBuildState()),
});

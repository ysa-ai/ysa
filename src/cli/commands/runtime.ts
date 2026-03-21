import { resolveProjectRoot } from "../git-root";
import { readYsaConfig, writeYsaConfig } from "../ysa-config";
import { detectAllLanguages, getMiseToolsForLanguages } from "../../runtime/detect-language";

export async function runtimeCommand(
  action: string,
  tool: string | undefined,
  opts: { project?: string },
) {
  const projectRoot = await resolveProjectRoot(opts.project);
  const config = await readYsaConfig(projectRoot);
  const runtimes = config.sandbox?.runtimes ?? [];
  const packages = config.sandbox?.packages ?? [];

  switch (action) {
    case "add": {
      if (!tool) {
        console.error("Usage: ysa runtime add <tool@version>");
        process.exit(1);
      }
      if (runtimes.includes(tool)) {
        console.log(`Already configured: ${tool}`);
        return;
      }
      const updated = [...runtimes, tool];
      await writeYsaConfig(projectRoot, { sandbox: { runtimes: updated, packages } });
      console.log(`Added: ${tool}`);
      console.log(`  Run \`ysa run\` to install on next task.`);
      break;
    }

    case "remove": {
      if (!tool) {
        console.error("Usage: ysa runtime remove <tool>");
        process.exit(1);
      }
      const base = tool.split("@")[0];
      const updated = runtimes.filter((r) => r !== tool && r.split("@")[0] !== base);
      if (updated.length === runtimes.length) {
        console.log(`Not found: ${tool}`);
        return;
      }
      await writeYsaConfig(projectRoot, { sandbox: { runtimes: updated, packages } });
      console.log(`Removed: ${tool}`);
      break;
    }

    case "list": {
      if (runtimes.length === 0 && packages.length === 0) {
        console.log("No runtimes configured. Run `ysa runtime detect` or `ysa runtime add <tool>`.");
        return;
      }
      if (runtimes.length > 0) {
        console.log("Runtimes (mise):");
        for (const r of runtimes) console.log(`  ${r}`);
      }
      if (packages.length > 0) {
        console.log("Packages (apt):");
        for (const p of packages) console.log(`  ${p}`);
      }
      break;
    }

    case "detect": {
      const results = await detectAllLanguages(projectRoot);
      if (results.length === 0) {
        console.log("No languages detected.");
        return;
      }

      const langs = results.map((r) => r.language);
      const spec = getMiseToolsForLanguages(langs);
      console.log(`Detected: ${langs.join(", ")}`);

      // Merge: only add entries not already present
      const newRuntimes = [...new Set([...runtimes, ...spec.tools])];
      const newPackages = [...new Set([...packages, ...spec.apkPackages])];

      await writeYsaConfig(projectRoot, { sandbox: { runtimes: newRuntimes, packages: newPackages } });

      if (spec.tools.length > 0) console.log(`  runtimes: [${spec.tools.map((t) => `"${t}"`).join(", ")}]`);
      if (spec.apkPackages.length > 0) console.log(`  packages: [${spec.apkPackages.map((p) => `"${p}"`).join(", ")}]`);
      console.log("Written to .ysa.toml");
      break;
    }

    default:
      console.error(`Unknown action: ${action}. Use add, remove, list, or detect.`);
      process.exit(1);
  }
}

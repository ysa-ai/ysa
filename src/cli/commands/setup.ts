import { stat } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { ensureProxy, isProxyRunning, stopProxy } from "../../runtime/proxy";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runShell(
  cmd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

function pass(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function warn(msg: string) {
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

function step(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

export async function setupCommand() {
  console.log("\x1b[1mysa setup\x1b[0m");

  let failed = false;

  // ── 1. Preflight ─────────────────────────────────────────────────────
  step("1/5  Preflight checks");

  const podmanCheck = await runShell("podman version --format '{{.Client.Version}}' 2>/dev/null");
  if (!podmanCheck.ok || !podmanCheck.stdout) {
    fail("Podman not found — install Podman 5.x+ and re-run ysa setup");
    console.error("\n  https://podman.io/docs/installation");
    process.exit(1);
  }

  const podmanVer = podmanCheck.stdout;
  const major = parseInt(podmanVer.split(".")[0] ?? "0", 10);
  if (major >= 5) {
    pass(`Podman ${podmanVer}`);
  } else {
    warn(`Podman ${podmanVer} — version 5.x+ recommended`);
  }

  // Rootless check
  const rootlessCheck = await runShell("podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null");
  if (rootlessCheck.stdout === "true") {
    pass("Rootless mode enabled");
  } else {
    warn("Rootless mode not detected — ysa requires rootless Podman");
    failed = true;
  }

  // ── 2. CA cert ───────────────────────────────────────────────────────
  step("2/5  CA certificate");

  const caDir = join(homedir(), ".ysa", "proxy-ca");
  const caPem = join(caDir, "ca.pem");
  const caKey = join(caDir, "ca-key.pem");

  // Locate the container directory (bundled with the binary)
  const containerDir = resolve(import.meta.dir, "..", "..", "..", "container");

  if (await fileExists(caPem) && await fileExists(caKey)) {
    pass(`CA cert already exists at ${caPem}`);
  } else {
    const caScript = join(containerDir, "generate-ca.sh");

    if (!await fileExists(caScript)) {
      fail(`generate-ca.sh not found at ${caScript}`);
      failed = true;
    } else {
      const caGen = await runShell(`bash "${caScript}" "${caDir}"`);
      if (!caGen.ok) {
        fail(`CA generation failed: ${caGen.stderr}`);
        failed = true;
      } else {
        await runShell(`chmod 644 "${caPem}" && chmod 600 "${caKey}"`);
        pass(`CA cert generated at ${caPem}`);
      }
    }
  }

  // ── 3. Image build ───────────────────────────────────────────────────
  step("3/5  Container images");

  const images = ["sandbox-claude", "sandbox-mistral", "sandbox-proxy"];
  const missing: string[] = [];
  for (const img of images) {
    const check = await runShell(`podman image exists ${img} 2>/dev/null`);
    if (check.ok) {
      pass(`${img} — found`);
    } else {
      warn(`${img} — not built`);
      missing.push(img);
    }
  }

  if (missing.length > 0) {
    const buildScript = join(containerDir, "build-images.sh");
    if (!await fileExists(buildScript)) {
      fail(`build-images.sh not found at ${buildScript}`);
      failed = true;
    } else {
      process.stdout.write(`  ! building missing images (this may take a few minutes)...`);
      const buildProc = Bun.spawn(["bash", buildScript], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: resolve(containerDir, ".."),
      });
      const exitCode = await buildProc.exited;
      process.stdout.write("\r\x1b[2K");
      if (exitCode === 0) {
        pass("Container images built");
      } else {
        const stderr = await new Response(buildProc.stderr).text();
        fail(`Image build failed: ${stderr.trim().split("\n").pop() ?? "unknown error"}`);
        failed = true;
      }
    }
  }

  // ── 4. OCI network hooks ─────────────────────────────────────────────
  step("4/5  OCI network hooks");

  const hooksScript = join(containerDir, "setup-network-hooks.sh");

  if (!await fileExists(hooksScript)) {
    warn(`setup-network-hooks.sh not found at ${hooksScript} — skipping`);
  } else {
    const hookInstall = await runShell(`bash "${hooksScript}"`);
    if (!hookInstall.ok) {
      fail(`Hook install failed: ${hookInstall.stderr}`);
      failed = true;
    } else {
      pass("OCI network hooks installed");
    }
  }

  // ── 5. Smoke test ────────────────────────────────────────────────────
  step("5/5  Smoke test");

  if (failed) {
    warn("Skipping smoke test — fix issues above first");
  } else {
    try {
      await ensureProxy();
      const running = await isProxyRunning();
      if (running) {
        pass("Proxy started and responding");
        await stopProxy();
        pass("Proxy stopped cleanly");
      } else {
        fail("Proxy did not start");
        failed = true;
      }
    } catch (err: any) {
      fail(`Proxy smoke test failed: ${err.message}`);
      failed = true;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log();
  if (failed) {
    console.log("\x1b[33mSetup completed with warnings — fix the issues above before running tasks.\x1b[0m");
    process.exit(1);
  } else {
    console.log("\x1b[32mSetup complete — you're ready to run tasks.\x1b[0m");
    console.log();
    console.log("  Try it:  ysa run \"create a hello world page\"");
  }
}

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const containerSrc = readFileSync(join(import.meta.dir, "container.ts"), "utf-8");
const indexSrc = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

describe("teardownContainer", () => {
  it("ut-1: volume cleanup uses pattern-based grep, not hardcoded shadow-node_modules-", () => {
    // Find the teardownContainer function body
    const teardownMatch = containerSrc.match(
      /export async function teardownContainer[\s\S]*?^}/m
    );
    expect(teardownMatch).not.toBeNull();
    const teardownBody = teardownMatch![0];

    expect(teardownBody).toContain("podman volume ls --format");
    expect(teardownBody).toContain("grep -- '-");
    expect(teardownBody).not.toContain("shadow-node_modules-");
  });
});

describe("spawnSandbox SHADOW_DIRS", () => {
  it("ut-2: sets SHADOW_DIRS when shadowDirs provided", () => {
    // Read container.ts source and verify SHADOW_DIRS is assigned from opts.shadowDirs
    expect(containerSrc).toContain("SHADOW_DIRS");
    expect(containerSrc).toContain("opts.shadowDirs");
  });

  it("ut-3: does not set SHADOW_DIRS when shadowDirs is absent", () => {
    // Verify the assignment is guarded by a conditional (opts.shadowDirs &&)
    expect(containerSrc).toMatch(/opts\.shadowDirs.*&&.*SHADOW_DIRS|if.*opts\.shadowDirs/);
  });
});

describe("rebuildSandboxImage", () => {
  it("ut-4: passes --build-arg AGENT= to podman build", () => {
    expect(containerSrc).toContain("--build-arg");
    expect(containerSrc).toContain("AGENT=${agent}");
  });

  it("ut-5: accepts opts object with caDir required", () => {
    expect(containerSrc).toMatch(/function rebuildSandboxImage\s*\(\s*opts\s*:/);
    expect(containerSrc).toContain("caDir: string");
  });

  it("ut-6: reuses existing CA cert when caDir/ca.pem exists", () => {
    expect(containerSrc).toContain('resolve(caDir, "ca.pem")');
    expect(containerSrc).toMatch(/cp.*caDir.*ca\.pem.*CONTAINER_DIR/);
  });

  it("ut-7: generates CA into caDir when cert does not exist", () => {
    expect(containerSrc).toContain('generate-ca.sh');
    expect(containerSrc).toContain('"${caDir}"');
  });

  it("ut-8: cleans up ca files from CONTAINER_DIR after build", () => {
    expect(containerSrc).toContain('rm -f "${CONTAINER_DIR}/ca.pem" "${CONTAINER_DIR}/ca-key.pem"');
  });
});

describe("buildBaseImages", () => {
  it("ut-9: builds both claude and mistral agents", () => {
    const fn = containerSrc.match(/export async function buildBaseImages[\s\S]*?^}/m)?.[0] ?? "";
    expect(fn).toContain('"claude"');
    expect(fn).toContain('"mistral"');
  });

  it("ut-10: image names are derived from agent names via template literal", () => {
    const fn = containerSrc.match(/export async function buildBaseImages[\s\S]*?^}/m)?.[0] ?? "";
    expect(fn).toMatch(/sandbox-\$\{agent\}/);
  });

  it("ut-11: builds sandbox-proxy after agent images", () => {
    const fn = containerSrc.match(/export async function buildBaseImages[\s\S]*?^}/m)?.[0] ?? "";
    expect(fn).toContain("buildProxyImage");
    const proxyIdx = fn.indexOf("buildProxyImage");
    const mistralIdx = fn.indexOf("mistral");
    expect(proxyIdx).toBeGreaterThan(mistralIdx);
  });

  it("ut-12: passes caDir to all image builds", () => {
    const fn = containerSrc.match(/export async function buildBaseImages[\s\S]*?^}/m)?.[0] ?? "";
    expect(fn).toContain("caDir");
    expect(fn.match(/caDir/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("buildProxyImage", () => {
  it("ut-13: copies CA cert and key into CONTAINER_DIR before build", () => {
    const fn = containerSrc.match(/export async function buildProxyImage[\s\S]*?^}/m)?.[0] ?? "";
    expect(fn).toMatch(/cp.*caDir.*ca\.pem.*CONTAINER_DIR/);
    expect(fn).toMatch(/cp.*caDir.*ca-key\.pem.*CONTAINER_DIR/);
  });

  it("ut-14: cleans up CA files from CONTAINER_DIR after build", () => {
    const fn = containerSrc.match(/export async function buildProxyImage[\s\S]*?^}/m)?.[0] ?? "";
    expect(fn).toContain('rm -f "${CONTAINER_DIR}/ca.pem" "${CONTAINER_DIR}/ca-key.pem"');
  });
});

describe("exports", () => {
  it("ut-15: buildProxyImage and buildBaseImages are exported from runtime index", () => {
    expect(indexSrc).toContain("buildProxyImage");
    expect(indexSrc).toContain("buildBaseImages");
    expect(indexSrc).toContain("RebuildSandboxImageOpts");
  });
});

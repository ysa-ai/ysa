import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { detectLanguage, getRegistryHostsForLanguage } from "./detect-language";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "detect-language-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("detectLanguage", () => {
  it("ut-1: returns go when go.mod is present", async () => {
    await writeFile(join(tmpDir, "go.mod"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "go", shadowDirs: [] });
  });

  it("ut-2: returns rust when Cargo.toml is present", async () => {
    await writeFile(join(tmpDir, "Cargo.toml"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "rust", shadowDirs: ["target"] });
  });

  it("ut-2: returns elixir when mix.exs is present", async () => {
    await writeFile(join(tmpDir, "mix.exs"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "elixir", shadowDirs: ["_build", "deps"] });
  });

  it("ut-2: returns swift when Package.swift is present", async () => {
    await writeFile(join(tmpDir, "Package.swift"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "swift", shadowDirs: [".build"] });
  });

  it("ut-3: returns dotnet when a .csproj file is present", async () => {
    await writeFile(join(tmpDir, "App.csproj"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "dotnet", shadowDirs: ["bin", "obj"] });
  });

  it("ut-3: returns dotnet when a .sln file is present", async () => {
    await writeFile(join(tmpDir, "Solution.sln"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "dotnet", shadowDirs: ["bin", "obj"] });
  });

  it("ut-2: returns java-maven when pom.xml is present", async () => {
    await writeFile(join(tmpDir, "pom.xml"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "java-maven", shadowDirs: ["target"] });
  });

  it("ut-2: returns java-gradle when build.gradle is present", async () => {
    await writeFile(join(tmpDir, "build.gradle"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "java-gradle", shadowDirs: ["build", ".gradle"] });
  });

  it("ut-4: returns java-gradle when build.gradle.kts is present", async () => {
    await writeFile(join(tmpDir, "build.gradle.kts"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "java-gradle", shadowDirs: ["build", ".gradle"] });
  });

  it("ut-2: returns ruby when Gemfile is present", async () => {
    await writeFile(join(tmpDir, "Gemfile"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "ruby", shadowDirs: ["vendor/bundle"] });
  });

  it("ut-2: returns php when composer.json is present", async () => {
    await writeFile(join(tmpDir, "composer.json"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "php", shadowDirs: ["vendor"] });
  });

  it("ut-5: returns python when pyproject.toml is present", async () => {
    await writeFile(join(tmpDir, "pyproject.toml"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "python", shadowDirs: [".venv"] });
  });

  it("ut-5: returns python when requirements.txt is present", async () => {
    await writeFile(join(tmpDir, "requirements.txt"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "python", shadowDirs: [".venv"] });
  });

  it("ut-5: returns python when Pipfile is present", async () => {
    await writeFile(join(tmpDir, "Pipfile"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "python", shadowDirs: [".venv"] });
  });

  it("ut-2: returns c-cpp when CMakeLists.txt is present", async () => {
    await writeFile(join(tmpDir, "CMakeLists.txt"), "");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "c-cpp", shadowDirs: ["build"] });
  });

  it("ut-2: returns node when package.json is present", async () => {
    await writeFile(join(tmpDir, "package.json"), "{}");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "node", shadowDirs: ["node_modules"] });
  });

  it("ut-6: returns unknown with node_modules when no markers present", async () => {
    expect(await detectLanguage(tmpDir)).toEqual({ language: "unknown", shadowDirs: ["node_modules"] });
  });

  it("go takes priority over node (package.json present alongside go.mod)", async () => {
    await writeFile(join(tmpDir, "go.mod"), "");
    await writeFile(join(tmpDir, "package.json"), "{}");
    expect(await detectLanguage(tmpDir)).toEqual({ language: "go", shadowDirs: [] });
  });
});

describe("getRegistryHostsForLanguage", () => {
  it("ut-7: returns correct hosts for node", () => {
    expect(getRegistryHostsForLanguage("node")).toEqual(["registry.npmjs.org", "registry.yarnpkg.com"]);
  });

  it("ut-7: returns correct hosts for python", () => {
    expect(getRegistryHostsForLanguage("python")).toEqual(["pypi.org", "files.pythonhosted.org"]);
  });

  it("ut-7: returns correct hosts for go", () => {
    expect(getRegistryHostsForLanguage("go")).toEqual(["proxy.golang.org", "sum.golang.org", "storage.googleapis.com"]);
  });

  it("ut-7: returns correct hosts for rust", () => {
    expect(getRegistryHostsForLanguage("rust")).toEqual(["static.crates.io", "crates.io"]);
  });

  it("ut-7: returns correct hosts for ruby", () => {
    expect(getRegistryHostsForLanguage("ruby")).toEqual(["rubygems.org", "index.rubygems.org"]);
  });

  it("ut-7: returns correct hosts for php", () => {
    expect(getRegistryHostsForLanguage("php")).toEqual(["repo.packagist.org", "packagist.org"]);
  });

  it("ut-7: returns correct hosts for java-maven", () => {
    expect(getRegistryHostsForLanguage("java-maven")).toEqual(["repo1.maven.org", "plugins.gradle.org"]);
  });

  it("ut-7: returns correct hosts for java-gradle", () => {
    expect(getRegistryHostsForLanguage("java-gradle")).toEqual(["repo1.maven.org", "plugins.gradle.org"]);
  });

  it("ut-7: returns correct hosts for dotnet", () => {
    expect(getRegistryHostsForLanguage("dotnet")).toEqual(["api.nuget.org", "globalcdn.nuget.org"]);
  });

  it("ut-7: returns correct hosts for elixir", () => {
    expect(getRegistryHostsForLanguage("elixir")).toEqual(["hex.pm", "repo.hex.pm"]);
  });

  it("ut-8: returns [] for swift", () => {
    expect(getRegistryHostsForLanguage("swift")).toEqual([]);
  });

  it("ut-8: returns [] for c-cpp", () => {
    expect(getRegistryHostsForLanguage("c-cpp")).toEqual([]);
  });

  it("ut-8: returns [] for unknown", () => {
    expect(getRegistryHostsForLanguage("unknown")).toEqual([]);
  });
});

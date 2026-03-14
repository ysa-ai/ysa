import { stat, readdir } from "fs/promises";
import { join } from "path";

export type DetectedLanguage =
  | "go"
  | "rust"
  | "elixir"
  | "swift"
  | "dotnet"
  | "java-maven"
  | "java-gradle"
  | "ruby"
  | "php"
  | "python"
  | "c-cpp"
  | "node"
  | "unknown";

export interface LanguageDetectionResult {
  language: DetectedLanguage;
  shadowDirs: string[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface DetectionRule {
  check(root: string): Promise<boolean>;
  language: DetectedLanguage;
  shadowDirs: string[];
}

const RULES: DetectionRule[] = [
  {
    check: (root) => fileExists(join(root, "go.mod")),
    language: "go",
    shadowDirs: [],
  },
  {
    check: (root) => fileExists(join(root, "Cargo.toml")),
    language: "rust",
    shadowDirs: ["target"],
  },
  {
    check: (root) => fileExists(join(root, "mix.exs")),
    language: "elixir",
    shadowDirs: ["_build", "deps"],
  },
  {
    check: (root) => fileExists(join(root, "Package.swift")),
    language: "swift",
    shadowDirs: [".build"],
  },
  {
    check: async (root) => {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        return false;
      }
      return entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln"));
    },
    language: "dotnet",
    shadowDirs: ["bin", "obj"],
  },
  {
    check: (root) => fileExists(join(root, "pom.xml")),
    language: "java-maven",
    shadowDirs: ["target"],
  },
  {
    check: async (root) =>
      (await fileExists(join(root, "build.gradle"))) ||
      (await fileExists(join(root, "build.gradle.kts"))),
    language: "java-gradle",
    shadowDirs: ["build", ".gradle"],
  },
  {
    check: (root) => fileExists(join(root, "Gemfile")),
    language: "ruby",
    shadowDirs: ["vendor/bundle"],
  },
  {
    check: (root) => fileExists(join(root, "composer.json")),
    language: "php",
    shadowDirs: ["vendor"],
  },
  {
    check: async (root) =>
      (await fileExists(join(root, "pyproject.toml"))) ||
      (await fileExists(join(root, "requirements.txt"))) ||
      (await fileExists(join(root, "Pipfile"))),
    language: "python",
    shadowDirs: [".venv"],
  },
  {
    check: (root) => fileExists(join(root, "CMakeLists.txt")),
    language: "c-cpp",
    shadowDirs: ["build"],
  },
  {
    check: (root) => fileExists(join(root, "package.json")),
    language: "node",
    shadowDirs: ["node_modules"],
  },
];

export const SUPPORTED_LANGUAGES = [
  "node", "python", "go", "rust", "ruby", "php",
  "java-maven", "java-gradle", "dotnet", "c-cpp", "swift", "elixir", "unknown",
] as const satisfies DetectedLanguage[];

export async function detectLanguage(worktreeRoot: string): Promise<LanguageDetectionResult> {
  for (const rule of RULES) {
    if (await rule.check(worktreeRoot)) {
      return { language: rule.language, shadowDirs: rule.shadowDirs };
    }
  }
  return { language: "unknown", shadowDirs: ["node_modules"] };
}

export async function detectAllLanguages(root: string): Promise<LanguageDetectionResult[]> {
  const results: LanguageDetectionResult[] = [];
  for (const rule of RULES) {
    if (await rule.check(root)) {
      results.push({ language: rule.language, shadowDirs: rule.shadowDirs });
    }
  }
  if (results.length === 0) {
    return [{ language: "unknown", shadowDirs: ["node_modules"] }];
  }
  return results;
}

export function getShadowDirsForLanguages(langs: DetectedLanguage[]): string[] {
  const dirs = new Set<string>();
  for (const rule of RULES) {
    if ((langs as string[]).includes(rule.language)) {
      for (const d of rule.shadowDirs) dirs.add(d);
    }
  }
  return [...dirs];
}

interface MiseToolSpec {
  tool?: string;
  installEnv?: Record<string, string>;
  runtimeEnv?: Record<string, string>;
  apkPackages?: string[];
  postInstallCopy?: string[];
}

const MISE_INSTALLS = "/home/agent/.local/share/mise/installs";

// Values are mise tool specs passed directly to `mise use --global`.
// Use major-version pins (e.g. "python@3") to ensure mise picks a stable release
// that has pre-compiled musl binaries available — "latest" can resolve to a
// cutting-edge version not yet in the precompiled list, causing a silent fallback
// to source compilation (pyenv/python-build) which fails in the Alpine sandbox.
const MISE_TOOL_MAP: Partial<Record<DetectedLanguage, MiseToolSpec>> = {
  node: { tool: "node@22" },
  python: { tool: "python@3.13", installEnv: { MISE_PYTHON_COMPILE: "0" } },
  go: { tool: "go@1" },
  rust: {
    tool: "rust@1",
    installEnv: {
      CARGO_HOME: `${MISE_INSTALLS}/.cargo`,
      RUSTUP_HOME: `${MISE_INSTALLS}/.rustup`,
    },
    runtimeEnv: {
      CARGO_HOME: `${MISE_INSTALLS}/.cargo`,
      RUSTUP_HOME: `${MISE_INSTALLS}/.rustup`,
    },
  },
  ruby: { apkPackages: ["ruby", "ruby-dev"] },
  php: { apkPackages: ["php", "php-phar", "php-openssl"] },
  "java-maven": { apkPackages: ["openjdk21-jdk", "maven"] },
  "java-gradle": { apkPackages: ["openjdk21-jdk", "gradle"] },
  dotnet: {
    tool: "dotnet@8",
    postInstallCopy: ["dotnet-root"],
    runtimeEnv: { DOTNET_ROOT: `${MISE_INSTALLS}/dotnet-root` },
  },
  // swift: not supported on Alpine (no apk package, no swift.org binary for musl/aarch64)
  elixir: { apkPackages: ["elixir"] }, // elixir apk pulls in erlang automatically
  "c-cpp": { apkPackages: ["g++"] }, // gcc is in the base image; g++ is a separate apk package
  // unknown: nothing
};

export interface MiseInstallSpec {
  tools: string[];
  env: Record<string, string>;
  runtimeEnv: Record<string, string>;
  apkPackages: string[];
  copyDirs: string[];
}

export function getMiseToolsForLanguages(langs: DetectedLanguage[]): MiseInstallSpec {
  const tools = new Set<string>();
  const env: Record<string, string> = {};
  const runtimeEnv: Record<string, string> = {};
  const apkPackages = new Set<string>();
  const copyDirs = new Set<string>();
  for (const lang of langs) {
    const spec = MISE_TOOL_MAP[lang];
    if (spec) {
      if (spec.tool) tools.add(spec.tool);
      if (spec.installEnv) Object.assign(env, spec.installEnv);
      if (spec.runtimeEnv) Object.assign(runtimeEnv, spec.runtimeEnv);
      if (spec.apkPackages) spec.apkPackages.forEach(p => apkPackages.add(p));
      if (spec.postInstallCopy) spec.postInstallCopy.forEach(d => copyDirs.add(d));
    }
  }
  return { tools: [...tools], env, runtimeEnv, apkPackages: [...apkPackages], copyDirs: [...copyDirs] };
}

const REGISTRY_HOSTS: Partial<Record<DetectedLanguage, string[]>> = {
  node: ["registry.npmjs.org", "registry.yarnpkg.com"],
  python: ["pypi.org", "files.pythonhosted.org"],
  go: ["proxy.golang.org", "sum.golang.org", "storage.googleapis.com"],
  rust: ["static.crates.io", "crates.io"],
  ruby: ["rubygems.org", "index.rubygems.org"],
  php: ["repo.packagist.org", "packagist.org"],
  "java-maven": ["repo1.maven.org", "plugins.gradle.org"],
  "java-gradle": ["repo1.maven.org", "plugins.gradle.org"],
  dotnet: ["api.nuget.org", "globalcdn.nuget.org"],
  elixir: ["hex.pm", "repo.hex.pm"],
};

export function getRegistryHostsForLanguage(lang: DetectedLanguage): string[] {
  return REGISTRY_HOSTS[lang] ?? [];
}

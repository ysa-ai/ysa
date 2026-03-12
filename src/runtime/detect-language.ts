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

const MISE_TOOL_MAP: Partial<Record<DetectedLanguage, string>> = {
  node: "node",
  python: "python",
  go: "go",
  rust: "rust",
  ruby: "ruby",
  "java-maven": "java",
  "java-gradle": "java",
  dotnet: "dotnet",
  swift: "swift",
  elixir: "elixir",
  // php: no stable mise plugin by default
  // "c-cpp": no runtime to install
  // unknown: nothing
};

export function getMiseToolsForLanguages(langs: DetectedLanguage[]): string[] {
  const tools = new Set<string>();
  for (const lang of langs) {
    const tool = MISE_TOOL_MAP[lang];
    if (tool) tools.add(tool);
  }
  return [...tools];
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

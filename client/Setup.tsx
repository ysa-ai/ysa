import { useEffect, useState } from "react";
import { trpc } from "./trpc";

const SUPPORTED_LANGUAGES = [
  "node", "python", "go", "rust", "ruby", "php",
  "java-maven", "java-gradle", "dotnet", "c-cpp", "swift", "elixir",
] as const;

const PROVIDERS = [
  { id: "claude", name: "Claude Code" },
  { id: "mistral", name: "Mistral Vibe" },
] as const;

const MODELS_BY_PROVIDER: Record<string, { id: string; name: string }[]> = {
  claude: [
    { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
    { id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
    { id: "claude-opus-4-6", name: "Opus 4.6" },
  ],
  mistral: [
    { id: "devstral-2", name: "Devstral 2" },
    { id: "mistral-large-latest", name: "Mistral Large 3" },
    { id: "mistral-medium-latest", name: "Mistral Medium 3.1" },
    { id: "devstral-small-latest", name: "Devstral Small" },
    { id: "codestral-latest", name: "Codestral" },
  ],
};

interface SetupProps {
  onComplete: () => void;
  onClose?: () => void; // if provided, renders as a modal (settings mode)
}

export function Setup({ onComplete, onClose }: SetupProps) {
  const isSettings = !!onClose;

  const { data: currentConfig } = trpc.config.get.useQuery();
  const { data: deps } = trpc.system.checkDeps.useQuery();

  const [projectRoot, setProjectRoot] = useState("");
  const [languages, setLanguages] = useState<string[]>([]);
  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [networkPolicy, setNetworkPolicy] = useState<"none" | "strict">("strict");
  const [port, setPort] = useState("4000");
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState("10");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [mistralKey, setMistralKey] = useState("");
  const [anthropicKeyChanged, setAnthropicKeyChanged] = useState(false);
  const [mistralKeyChanged, setMistralKeyChanged] = useState(false);
  const [error, setError] = useState("");

  // Pre-populate from existing config in settings mode
  useEffect(() => {
    if (!currentConfig) return;
    if (currentConfig.project_root) setProjectRoot(currentConfig.project_root);
    if (currentConfig.default_network_policy) setNetworkPolicy(currentConfig.default_network_policy as "none" | "strict");
    if (currentConfig.port) setPort(String(currentConfig.port));
    if (currentConfig.max_concurrent_tasks) setMaxConcurrentTasks(String(currentConfig.max_concurrent_tasks));
    if (currentConfig.languages_list) setLanguages(currentConfig.languages_list);
    if (currentConfig.default_model) {
      const matchedProvider = Object.entries(MODELS_BY_PROVIDER).find(([, models]) =>
        models.some((m) => m.id === currentConfig.default_model)
      );
      if (matchedProvider) {
        setProvider(matchedProvider[0]);
        setModel(currentConfig.default_model);
      }
    }
  }, [currentConfig]);

  const setConfig = trpc.config.set.useMutation({
    onSuccess: () => onComplete(),
    onError: (err) => setError(err.message),
  });

  const detectLanguagesMutation = trpc.config.detectLanguages.useMutation({
    onSuccess: (data) => {
      const detected = data.map((r) => r.language).filter((l) => l !== "unknown");
      if (detected.length > 0) {
        setLanguages(detected);
      } else {
        setError("No recognized languages found at the project root. Select languages manually.");
      }
    },
    onError: (err) => setError(err.message),
  });

  const setApiKey = trpc.config.setApiKey.useMutation({
    onError: (err) => setError(err.message),
  });

  const pickDirectory = trpc.config.pickDirectory.useMutation({
    onSuccess: (data) => {
      if (data.path) {
        setProjectRoot(data.path);
        detectLanguagesMutation.mutate({ path: data.path });
      }
    },
    onError: (err) => setError(err.message),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectRoot.trim()) { setError("Project root is required"); return; }
    const parsedPort = parseInt(port);
    if (port && (isNaN(parsedPort) || parsedPort < 1024 || parsedPort > 65535)) {
      setError("Port must be between 1024 and 65535");
      return;
    }
    const parsedMaxConcurrent = parseInt(maxConcurrentTasks);
    if (maxConcurrentTasks && (isNaN(parsedMaxConcurrent) || parsedMaxConcurrent < 1 || parsedMaxConcurrent > 100)) {
      setError("Max concurrent tasks must be between 1 and 100");
      return;
    }
    if (anthropicKeyChanged && anthropicKey.trim()) {
      await setApiKey.mutateAsync({ provider: "anthropic", value: anthropicKey.trim() });
    }
    if (mistralKeyChanged && mistralKey.trim()) {
      await setApiKey.mutateAsync({ provider: "mistral", value: mistralKey.trim() });
    }
    setConfig.mutate({
      project_root: projectRoot.trim(),
      default_model: model || null,
      default_network_policy: networkPolicy,
      port: port ? parsedPort : null,
      max_concurrent_tasks: maxConcurrentTasks ? parsedMaxConcurrent : undefined,
      languages,
      shadow_dirs: null,
    });
  };

  const availableModels = MODELS_BY_PROVIDER[provider] ?? [];

  const form = (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/* Project root */}
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
          Project root <span className="text-err">*</span>
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={projectRoot}
            onChange={(e) => setProjectRoot(e.target.value)}
            placeholder="/path/to/your/project"
            className="flex-1 min-w-0 bg-bg-inset border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary placeholder-text-faint focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all font-mono"
          />
          <button
            type="button"
            onClick={() => pickDirectory.mutate()}
            disabled={pickDirectory.isPending}
            className="shrink-0 px-3.5 py-2.5 bg-bg-inset border border-border rounded-lg text-[12px] text-text-muted hover:text-text-primary hover:border-border-bright transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pickDirectory.isPending ? "\u2026" : "Browse"}
          </button>
        </div>
        <p className="text-[12px] text-text-muted mt-1.5">Select an existing directory or create one first. Worktrees will be created under <span className="font-mono">.ysa/worktrees/</span> inside it.</p>
      </div>

      {/* Languages */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-[12px] font-medium text-text-secondary">
            Languages{detectLanguagesMutation.isSuccess && <span className="text-text-faint font-normal ml-1">(auto-detected)</span>}
          </label>
          <button
            type="button"
            onClick={() => { if (projectRoot.trim()) { setError(""); detectLanguagesMutation.mutate({ path: projectRoot.trim() }); } }}
            disabled={detectLanguagesMutation.isPending || !projectRoot.trim()}
            className="text-[11px] text-primary hover:text-primary/80 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {detectLanguagesMutation.isPending ? "Detecting\u2026" : "Detect"}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SUPPORTED_LANGUAGES.map((lang) => {
            const active = languages.includes(lang);
            return (
              <button
                key={lang}
                type="button"
                onClick={() => setLanguages(active ? languages.filter((l) => l !== lang) : [...languages, lang])}
                className={`px-2.5 py-1 rounded-md text-[11px] font-mono border transition-all cursor-pointer ${
                  active
                    ? "bg-primary/10 border-primary/40 text-primary"
                    : "bg-bg-inset border-border text-text-muted hover:border-border-bright"
                }`}
              >
                {lang}
              </button>
            );
          })}
        </div>
        <p className="text-[12px] text-text-muted mt-1.5">Select all languages used in this project. Determines which build directories are isolated per task.</p>
      </div>

      {/* Provider */}
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
          Default provider <span className="text-text-faint font-normal">(optional)</span>
        </label>
        <select
          value={provider}
          onChange={(e) => {
            const p = e.target.value;
            setProvider(p);
            setModel(MODELS_BY_PROVIDER[p]?.[0]?.id ?? "");
          }}
          className="w-full bg-bg-inset border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all"
        >
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {/* Model */}
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
          Default model <span className="text-text-faint font-normal">(optional)</span>
        </label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full bg-bg-inset border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all"
        >
          {availableModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      {/* Network policy */}
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-2">Default network policy</label>
        <div className="flex gap-3">
          {(["none", "strict"] as const).map((p) => (
            <button key={p} type="button" onClick={() => setNetworkPolicy(p)}
              className={`flex-1 py-2 rounded-lg text-[12px] font-medium border transition-all cursor-pointer ${
                networkPolicy === p ? "bg-primary/10 border-primary/40 text-primary" : "bg-bg-inset border-border text-text-muted hover:border-border-bright"
              }`}
            >
              {p === "none" ? "Unrestricted" : "Restricted"}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-text-muted mt-1.5">
          {networkPolicy === "none" ? "Full internet access inside the container." : "All traffic inspected via proxy \u2014 GET-only, entropy detection, rate limits."}
        </p>
      </div>

      {/* Divider */}
      <div className="border-t border-border pt-1">
        <p className="text-[11px] font-medium text-text-faint uppercase tracking-wide mb-4">API Keys</p>

        <div className="space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
              Anthropic API key <span className="text-text-faint font-normal">(optional \u2014 only if not using OAuth)</span>
            </label>
            <input
              type="password"
              value={anthropicKey}
              onChange={(e) => { setAnthropicKey(e.target.value); setAnthropicKeyChanged(true); }}
              placeholder={currentConfig?.has_anthropic_key ? "Key configured \u2014 enter new value to update" : "sk-ant-..."}
              className="w-full bg-bg-inset border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary placeholder-text-faint focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all font-mono"
            />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
              Mistral API key <span className="text-text-faint font-normal">(required for Mistral provider)</span>
            </label>
            <input
              type="password"
              value={mistralKey}
              onChange={(e) => { setMistralKey(e.target.value); setMistralKeyChanged(true); }}
              placeholder={currentConfig?.has_mistral_key ? "Key configured \u2014 enter new value to update" : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
              className="w-full bg-bg-inset border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary placeholder-text-faint focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all font-mono"
            />
          </div>
        </div>
      </div>

      {/* Port + concurrency */}
      <div className="border-t border-border pt-1">
        <p className="text-[11px] font-medium text-text-faint uppercase tracking-wide mb-4">Server</p>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
            Port <span className="text-text-faint font-normal">(default: 4000)</span>
          </label>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            min={1024}
            max={65535}
            className="w-32 bg-bg-inset border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all font-mono"
          />
          {isSettings && <p className="text-[12px] text-text-muted mt-1.5">Restart the server after changing the port.</p>}
        </div>

        <div className="mt-4">
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
            Max concurrent tasks <span className="text-text-faint font-normal">(default: 10)</span>
          </label>
          <input
            type="number"
            value={maxConcurrentTasks}
            onChange={(e) => setMaxConcurrentTasks(e.target.value)}
            min={1}
            max={100}
            className="w-32 bg-bg-inset border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all font-mono"
          />
          <p className="text-[12px] text-text-muted mt-1.5">Maximum number of tasks that can run simultaneously (1\u2013100).</p>
        </div>
      </div>

      {error && <p className="text-[12px] text-err">{error}</p>}

      <div className="flex gap-3 pt-1">
        {isSettings && (
          <button type="button" onClick={onClose}
            className="flex-1 py-2.5 rounded-lg text-[13px] font-medium border border-border text-text-muted hover:border-border-bright transition-all cursor-pointer"
          >
            Cancel
          </button>
        )}
        <button type="submit" disabled={setConfig.isPending}
          className={`flex-1 py-2.5 rounded-lg text-[13px] font-medium bg-primary text-white transition-all ${
            setConfig.isPending ? "opacity-50 cursor-not-allowed" : "hover:brightness-110 cursor-pointer"
          }`}
        >
          {setConfig.isPending ? "Saving..." : isSettings ? "Save" : "Get started"}
        </button>
      </div>
    </form>
  );

  // \u2500\u2500 Settings modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (isSettings) {
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm overflow-y-auto py-10">
        <div className="w-full max-w-xl mx-4">
          <div className="bg-bg-raised border border-border rounded-xl shadow-xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-[15px] font-semibold text-text-primary">Settings</h2>
              <button onClick={onClose} className="text-text-faint hover:text-text-primary transition-colors cursor-pointer">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">{form}</div>
          </div>
        </div>
      </div>
    );
  }

  // \u2500\u2500 First-run full-screen \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  return (
    <div className="min-h-screen bg-bg flex items-start justify-center overflow-y-auto py-16">
      <div className="w-full max-w-xl px-4">
        <div className="mb-8 text-center">
          <p className="text-[11px] font-medium tracking-widest uppercase text-text-faint mb-3">Welcome</p>
          <h1 className="text-[24px] font-semibold text-text-primary tracking-tight mb-2">Your Secure Agent</h1>
          <p className="text-[13px] text-text-muted leading-relaxed">
            Run AI agents in parallel inside hardened, isolated containers.<br />
            Let's configure your workspace to get started.
          </p>
        </div>

        {deps && (!deps.git || !deps.podman) ? (
          <div className="bg-bg-raised border border-border rounded-xl px-5 py-6 space-y-4">
            <p className="text-[15px] font-medium text-text-primary">Missing required dependencies</p>
            <p className="text-[13px] text-text-muted">Install the following before continuing:</p>
            <div className="space-y-3">
              {!deps.git && (
                <div className="flex items-start gap-3">
                  <span className="text-err mt-0.5">\u2715</span>
                  <div>
                    <p className="text-[14px] font-medium text-text-primary font-mono">git</p>
                    <p className="text-[13px] text-text-muted">Required for worktree isolation between tasks. <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer" className="text-primary hover:underline">Installation guide \u2192</a></p>
                  </div>
                </div>
              )}
              {!deps.podman && (
                <div className="flex items-start gap-3">
                  <span className="text-err mt-0.5">\u2715</span>
                  <div>
                    <p className="text-[14px] font-medium text-text-primary font-mono">podman</p>
                    <p className="text-[13px] text-text-muted">Required to run sandboxed containers. <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-primary hover:underline">Installation guide \u2192</a></p>
                  </div>
                </div>
              )}
            </div>
            <p className="text-[12px] text-text-faint pt-1">Once installed, refresh the page.</p>
          </div>
        ) : (
          <div className="bg-bg-raised border border-border rounded-xl p-6">{form}</div>
        )}
      </div>
    </div>
  );
}

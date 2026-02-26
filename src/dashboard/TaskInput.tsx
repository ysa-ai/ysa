import { type RefObject, useState } from "react";

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

interface TaskInputProps {
  onRun: (config: {
    prompt: string;
    branch: string;
    networkPolicy: "none" | "strict";
    maxTurns: number;
    provider: string;
    model?: string;
    allowedHosts?: string;
  }) => void;
  isPending?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

export function TaskInput({ onRun, isPending, textareaRef }: TaskInputProps) {
  const [prompt, setPrompt] = useState("");
  const [branch, setBranch] = useState("main");
  const [networkPolicy, setNetworkPolicy] = useState<"none" | "strict">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("networkPolicy");
      if (saved === "none" || saved === "strict") return saved;
    }
    return "strict";
  });
  const [maxTurns, setMaxTurns] = useState(60);
  const [provider, setProvider] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("llmProvider") || "claude";
    }
    return "claude";
  });
  const [model, setModel] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("llmModel") || "claude-sonnet-4-6";
    }
    return "claude-sonnet-4-6";
  });
  const [allowedHosts, setAllowedHosts] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleSubmit = () => {
    if (!prompt.trim() || isPending) return;
    onRun({
      prompt: prompt.trim(),
      branch,
      networkPolicy,
      maxTurns,
      provider,
      model: model || undefined,
      allowedHosts: allowedHosts.trim() || undefined,
    });
    setPrompt("");
  };

  const availableModels = MODELS_BY_PROVIDER[provider] ?? [];

  return (
    <div className="px-6 py-3.5 border-b border-border bg-bg-raised">
      <textarea
        ref={textareaRef}
        className="w-full bg-bg-inset border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary placeholder:text-text-faint resize-none focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all"
        rows={2}
        placeholder="Describe the task..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      />
      <div className="flex items-center justify-between mt-2.5">
        <button
          className="text-[11px] text-text-faint hover:text-text-muted cursor-pointer flex items-center gap-1 transition-colors"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <svg
            width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
            className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          Advanced
        </button>
        <button
          className={`px-3.5 py-1.5 rounded-lg text-[12px] font-medium bg-primary text-white transition-all ${
            !prompt.trim() || isPending ? "opacity-40 cursor-not-allowed" : "hover:brightness-110 cursor-pointer"
          }`}
          onClick={handleSubmit}
          disabled={!prompt.trim() || isPending}
        >
          {isPending ? "Running..." : "Run"}
        </button>
      </div>

      {showAdvanced && (
        <div className="mt-3 pt-3 border-t border-border-subtle space-y-2.5 animate-[fade-in_0.15s_ease-out]">
          <label className="flex items-center gap-2.5">
            <span className="text-[11px] text-text-faint w-16 shrink-0">Branch</span>
            <input
              type="text"
              className="flex-1 bg-bg-inset border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text-primary font-mono focus:outline-none focus:border-primary/40"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2.5">
            <span className="text-[11px] text-text-faint w-16 shrink-0">Max turns</span>
            <input
              type="number"
              className="w-20 bg-bg-inset border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text-primary focus:outline-none focus:border-primary/40"
              value={maxTurns}
              onChange={(e) => setMaxTurns(parseInt(e.target.value) || 60)}
              min={1}
              max={500}
            />
          </label>
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-text-faint w-16 shrink-0">Provider</span>
            <select
              className="flex-1 bg-bg-inset border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text-primary focus:outline-none focus:border-primary/40"
              value={provider}
              onChange={(e) => {
                const p = e.target.value;
                const defaultModel = MODELS_BY_PROVIDER[p]?.[0]?.id ?? "";
                setProvider(p);
                setModel(defaultModel);
                localStorage.setItem("llmProvider", p);
                localStorage.setItem("llmModel", defaultModel);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-text-faint w-16 shrink-0">Model</span>
            <select
              className="flex-1 bg-bg-inset border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text-primary focus:outline-none focus:border-primary/40"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                localStorage.setItem("llmModel", e.target.value);
              }}
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <label className="flex items-start gap-2.5">
            <span className="text-[11px] text-text-faint w-16 shrink-0 pt-1.5">Allow hosts</span>
            <div className="flex-1">
              <input
                type="text"
                className="w-full bg-bg-inset border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text-primary font-mono focus:outline-none focus:border-primary/40"
                placeholder="e.g. api.example.com/v1/projects/my-project"
                value={allowedHosts}
                onChange={(e) => setAllowedHosts(e.target.value)}
              />
              <p className="text-[10px] text-text-faint mt-1">Comma-separated. With path = scoped rule (e.g. api.example.com/v1/…). Without path = full bypass.</p>
            </div>
          </label>
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-text-faint w-16 shrink-0">Network</span>
            <div className="flex gap-4">
              {([["none", "Unrestricted"], ["strict", "Restricted"]] as const).map(([value, label]) => (
                <label key={value} className="flex items-center gap-1.5 text-[11px] text-text-muted cursor-pointer">
                  <input
                    type="radio"
                    name="network"
                    checked={networkPolicy === value}
                    onChange={() => { setNetworkPolicy(value); localStorage.setItem("networkPolicy", value); }}
                    className="accent-primary"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

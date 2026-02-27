import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { StatusBadge } from "./StatusBadge";
import { formatDuration } from "./format";
import type { TaskData } from "./TaskRow";

interface LogEntry {
  type: string;
  icon?: string;
  text: string;
  tool?: string;
  output?: string;
  ts?: number;
}

interface TaskDetailProps {
  task: TaskData;
  logEntries: LogEntry[];
  resultMarkdown: string | null;
  onStop: (taskId: string) => void;
  onRelaunch: (taskId: string) => void;
  onContinue: (taskId: string) => void;
  onOpenTerminal: (taskId: string) => void;
  onChangeTerminal: (taskId: string) => void;
  onRefine: (taskId: string, prompt: string) => void;
  onArchive: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  isPending: boolean;
}

export function TaskDetail({
  task,
  logEntries,
  resultMarkdown,
  onStop,
  onRelaunch,
  onContinue,
  onOpenTerminal,
  onChangeTerminal,
  onRefine,
  onArchive,
  onDelete,
  isPending,
}: TaskDetailProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const [refineText, setRefineText] = useState("");
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const [expandedNetwork, setExpandedNetwork] = useState<Set<number>>(new Set());

  const hasResult = resultMarkdown !== null;
  const resultHtml = hasResult ? (marked.parse(resultMarkdown, { async: false }) as string) : "";

  const agentLogs = logEntries.filter((e) => e.type !== "network");
  const networkLogs = logEntries.filter((e) => e.type === "network");

  const isRunning = task.status === "running" || task.status === "queued";
  const lastProgressIdx = agentLogs.reduce((acc, e, i) => e.type === "progress" ? i : acc, -1);
  const hasPostProgressContent = lastProgressIdx >= 0 && lastProgressIdx < agentLogs.length - 1;

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logEntries]);

  useEffect(() => {
    setRefineText("");
    setExpandedTools(new Set());
    setExpandedNetwork(new Set());
  }, [task.task_id]);

  const showRefine = !["running", "queued", "archived"].includes(task.status) && task.session_id;

  const handleRefine = () => {
    if (!refineText.trim() || isPending) return;
    onRefine(task.task_id, refineText.trim());
    setRefineText("");
  };

  const toggleTool = (idx: number) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleNetwork = (idx: number) => {
    setExpandedNetwork((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const shortId = task.task_id.slice(0, 8);
  const canContinue = (task.status === "failed" && task.failure_reason === "max_turns") || (task.status === "stopped" && !!task.session_id);
  const canArchive = ["completed", "stopped", "failed"].includes(task.status) && !!task.worktree;
  const canOpenTerminal = task.status !== "running" && !!task.session_id;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* ── Header bar ── */}
      <div className="shrink-0 h-14 px-6 border-b border-border bg-bg-raised flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[12px] font-mono text-text-faint bg-bg-surface px-2 py-0.5 rounded">{shortId}</span>
          <StatusBadge status={task.status} />
          {task.started_at && (
            <span className="text-[11px] text-text-muted">{formatDuration(task.started_at, task.finished_at)}</span>
          )}
          <span className="text-[11px] font-mono text-text-muted bg-bg-surface px-2 py-0.5 rounded border border-border-subtle">
            {task.branch}
          </span>
          {task.provider && (
            <span className="text-[11px] font-mono text-text-muted bg-bg-surface px-2 py-0.5 rounded border border-border-subtle">
              {task.provider}{task.model ? ` / ${task.model}` : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {task.status === "running" && (
            <ActionBtn label="Stop" variant="err" onClick={() => onStop(task.task_id)} disabled={isPending} />
          )}
          {canContinue && (
            <ActionBtn label="Continue" variant="primary" onClick={() => onContinue(task.task_id)} disabled={isPending} />
          )}
          {task.status === "failed" && (
            <ActionBtn label="Relaunch" variant="primary" onClick={() => onRelaunch(task.task_id)} disabled={isPending} />
          )}
          {canOpenTerminal && (
            <SplitBtn
              label="Sandbox Shell"
              onClick={() => onOpenTerminal(task.task_id)}
              disabled={isPending}
              menuItems={[{ label: "Change terminal", onClick: () => onChangeTerminal(task.task_id) }]}
            />
          )}
          {canArchive && (
            <ActionBtn label="Archive" variant="muted" onClick={() => onArchive(task.task_id)} disabled={isPending} />
          )}
          <ActionBtn label="Delete" variant="err-subtle" onClick={() => onDelete(task.task_id)} disabled={isPending} />
        </div>
      </div>

      {/* Error bar */}
      {task.error && (
        <div className="shrink-0 px-6 py-2 bg-err-bg border-b border-err/15">
          <p className="text-[12px] text-err leading-snug">{task.error}</p>
        </div>
      )}

      {/* ── Split pane: left (content) + right (log panel) ── */}
      <div className="flex-1 flex min-h-0">

        {/* Left: prompt + result */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-6 py-6 space-y-6">

            {/* ━━ PROMPT ━━ */}
            <section>
              <div className="rounded-lg border border-border-bright overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2 bg-bg-surface-bright border-b border-border-bright">
                  <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" className="text-text-secondary">
                    <path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" />
                  </svg>
                  <span className="text-[11px] font-semibold text-text-primary uppercase tracking-widest">Prompt</span>
                  <CopyButton getText={() => task.prompt} />
                </div>
                <div className="bg-bg-raised px-5 py-4">
                  <p className="text-[13px] text-text-primary leading-relaxed whitespace-pre-wrap">{task.prompt}</p>
                </div>
              </div>
            </section>

            {/* ━━ RESULT ━━ */}
            {hasResult && (
              <section className="animate-[slide-up_0.3s_ease-out]">
                <div className="rounded-lg border border-border-bright overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2 bg-bg-surface-bright border-b border-border-bright">
                    <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" className="text-text-secondary">
                      <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z" />
                    </svg>
                    <span className="text-[11px] font-semibold text-text-primary uppercase tracking-widest">Result</span>
                    <CopyButton getText={() => resultMarkdown ?? ""} />
                  </div>
                  <div className="bg-bg-raised px-5 py-5 result-markdown">
                    <div dangerouslySetInnerHTML={{ __html: resultHtml }} />
                  </div>
                </div>
              </section>
            )}

          </div>
        </div>

        {/* Right: log panel — agent logs (2/3) + network (1/3) */}
        <div className="w-[360px] 2xl:w-[480px] shrink-0 border-l border-border flex flex-col min-h-0">

          {/* Agent logs — top 2/3 */}
          <div className="flex-[2] flex flex-col min-h-0 border-b border-border">
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-bg-surface border-b border-border">
              <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" className="text-text-secondary shrink-0">
                <path d="M4 6h16M4 10h16M4 14h16M4 18h12" />
              </svg>
              <span className="text-[11px] font-semibold text-text-primary uppercase tracking-widest">Logs</span>
              {agentLogs.length > 0 && (
                <span className="text-[10px] font-mono text-text-faint bg-bg-inset px-1.5 py-0.5 rounded">{agentLogs.length}</span>
              )}
              <CopyButton getText={() => agentLogs.map((e) => `[${e.type}] ${e.text}`).join("\n")} />
            </div>
            <div ref={logRef} className="flex-1 overflow-y-auto bg-bg-raised">
              {agentLogs.length === 0 ? (
                <div className="flex items-center justify-center h-full text-[12px] text-text-faint">
                  {isRunning ? "Waiting for output..." : "No logs."}
                </div>
              ) : (
                agentLogs.map((entry, i) => {
                  const progressActive = entry.type === "progress" && isRunning && i === lastProgressIdx && !hasPostProgressContent;
                  const isFirstProgress = entry.type === "progress" && (i === 0 || agentLogs[i - 1].type !== "progress");
                  return (
                    <span key={i}>
                      {isFirstProgress && (
                        <div className="flex items-center gap-3 px-3 py-1.5 bg-bg-surface/50 border-b border-border-subtle">
                          <div className="flex-1 h-px bg-border-subtle" />
                          <span className="text-[10px] text-text-faint italic shrink-0 font-mono">Container init</span>
                          <div className="flex-1 h-px bg-border-subtle" />
                        </div>
                      )}
                      <LogRow
                        entry={entry}
                        index={i}
                        expanded={expandedTools.has(i)}
                        onToggle={toggleTool}
                        isLast={i === agentLogs.length - 1}
                        progressActive={progressActive}
                      />
                    </span>
                  );
                })
              )}
            </div>
          </div>

          {/* Network logs — bottom 1/3 */}
          <div className="flex-[1] flex flex-col min-h-0">
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-bg-surface border-b border-border">
              <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" className="text-text-secondary shrink-0">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span className="text-[11px] font-semibold text-text-primary uppercase tracking-widest">Network</span>
              {networkLogs.length > 0 && (
                <span className="text-[10px] font-mono text-text-faint bg-bg-inset px-1.5 py-0.5 rounded">{networkLogs.length}</span>
              )}
              <CopyButton getText={() => networkLogs.map((e) => e.text).join("\n")} />
            </div>
            <div className="flex-1 overflow-y-auto bg-bg-raised">
              {networkLogs.length === 0 ? (
                <div className="flex items-center justify-center h-full text-[12px] text-text-faint">
                  No traffic
                </div>
              ) : (
                networkLogs.map((entry, i) => (
                  <LogRow
                    key={i}
                    entry={entry}
                    index={i}
                    expanded={expandedNetwork.has(i)}
                    onToggle={toggleNetwork}
                    isLast={i === networkLogs.length - 1}
                  />
                ))
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ── Refine Input ── */}
      {showRefine && (
        <div className="shrink-0 px-6 py-4 border-t border-border bg-bg-raised h-28 flex flex-col justify-center">
          <div className="flex gap-2.5">
            <textarea
              className="flex-1 bg-bg-inset border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary placeholder-text-faint resize-none min-h-[44px] max-h-[120px] focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all"
              placeholder="Refine instructions..."
              value={refineText}
              onChange={(e) => setRefineText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleRefine();
                }
              }}
            />
            <button
              className={`px-4 py-2 rounded-lg text-[12px] font-medium bg-primary text-white self-end transition-all ${
                !refineText.trim() || isPending ? "opacity-40 cursor-not-allowed" : "hover:brightness-110 cursor-pointer"
              }`}
              onClick={handleRefine}
              disabled={!refineText.trim() || isPending}
            >
              Refine
            </button>
          </div>
          <p className="text-[10px] text-text-faint mt-1">Cmd+Enter to send</p>
        </div>
      )}
    </div>
  );
}

/* ── Log Rows ── */

function LogRow({ entry, index, expanded, onToggle, isLast, progressActive }: { entry: LogEntry; index: number; expanded: boolean; onToggle: (i: number) => void; isLast: boolean; progressActive?: boolean }) {
  const borderClass = isLast ? "" : "border-b border-border-subtle";

  if (entry.type === "progress") {
    return (
      <div className={`flex items-center gap-2 px-3 py-1.5 ${borderClass}`}>
        {progressActive ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="text-primary animate-spin shrink-0">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.2" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ok shrink-0">
            <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span className={`text-[12px] ${progressActive ? "text-text-muted" : "text-text-faint"}`}>{entry.text}</span>
      </div>
    );
  }

  if (entry.type === "system") {
    return (
      <div className={`flex items-center gap-3 px-3 py-1.5 bg-bg-surface/50 ${borderClass}`}>
        <div className="flex-1 h-px bg-border-subtle" />
        <span className="text-[10px] text-text-faint italic shrink-0 font-mono">{entry.text}</span>
        <div className="flex-1 h-px bg-border-subtle" />
      </div>
    );
  }

  if (entry.type === "assistant") {
    return (
      <div className={`px-3 py-2 ${borderClass}`}>
        <p className="text-[13px] text-text-primary leading-relaxed whitespace-pre-wrap">{entry.text}</p>
      </div>
    );
  }

  if (entry.type === "tool_call") {
    return (
      <div className={borderClass}>
        <button
          className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-bg-surface/40 transition-colors cursor-pointer"
          onClick={() => onToggle(index)}
        >
          <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" className="text-text-faint shrink-0">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
          {entry.tool && (
            <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-bg-surface text-text-secondary shrink-0">
              {entry.tool}
            </span>
          )}
          <span className="text-[11px] text-text-muted truncate flex-1 font-mono">{entry.text}</span>
          <svg
            width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
            className={`text-text-faint shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {expanded && (
          <div className="mx-3 mb-1.5 bg-bg-inset border border-border-subtle rounded overflow-hidden">
            <pre className="text-[11px] font-mono text-text-muted whitespace-pre-wrap break-all leading-relaxed p-2.5 max-h-64 overflow-y-auto">
              {entry.output ?? entry.text}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (entry.type === "result") {
    const isSuccess = entry.icon === "success";
    return (
      <div className={`flex items-start gap-2 px-3 py-2 ${isSuccess ? "bg-ok-bg" : "bg-err-bg"} ${borderClass}`}>
        <span className={`text-[12px] shrink-0 ${isSuccess ? "text-ok" : "text-err"}`}>{isSuccess ? "✓" : "✗"}</span>
        <p className={`text-[12px] font-medium ${isSuccess ? "text-ok" : "text-err"}`}>{entry.text}</p>
      </div>
    );
  }

  if (entry.type === "network") {
    const isBlock = entry.icon === "block";
    const body = entry.text.replace(/^\[(ALLOW|BLOCK)\]\s*/, "");
    const ts = entry.ts ? new Date(entry.ts).toTimeString().slice(0, 8) : null;
    return (
      <div className={`${isBlock ? "bg-err-bg/50" : "bg-bg-surface/30"} ${borderClass}`}>
        <button
          className="flex items-center gap-2 w-full text-left px-3 py-1 hover:brightness-95 transition-all cursor-pointer"
          onClick={() => onToggle(index)}
        >
          <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" className={`shrink-0 ${isBlock ? "text-err" : "text-ok"}`}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span className={`font-mono text-[10px] font-semibold px-1 py-0.5 rounded shrink-0 ${isBlock ? "bg-err-bg text-err" : "bg-ok-bg text-ok"}`}>
            {isBlock ? "BLOCK" : "ALLOW"}
          </span>
          {ts && (
            <span className="font-mono text-[10px] text-text-faint shrink-0">{ts}</span>
          )}
          <span className="text-[11px] font-mono text-text-muted truncate flex-1">{body}</span>
          <svg
            width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
            className={`text-text-faint shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {expanded && (
          <div className="mx-3 mb-1.5 bg-bg-inset border border-border-subtle rounded overflow-hidden">
            <pre className="text-[11px] font-mono text-text-muted whitespace-pre-wrap break-all leading-relaxed p-2.5">
              {body}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`px-3 py-1 ${borderClass}`}>
      <p className="text-[11px] font-mono text-text-faint whitespace-pre-wrap break-all">{entry.text}</p>
    </div>
  );
}

/* ── Copy Button ── */

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(getText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [getText]);
  return (
    <button
      onClick={copy}
      title="Copy to clipboard"
      className="ml-auto flex items-center gap-1 text-[10px] text-text-faint hover:text-text-secondary transition-colors cursor-pointer px-1"
    >
      {copied ? (
        <>
          <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>Copied</span>
        </>
      ) : (
        <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </button>
  );
}

/* ── Action Button ── */

function ActionBtn({ label, variant, onClick, disabled }: { label: string; variant: string; onClick: () => void; disabled?: boolean }) {
  const styles: Record<string, string> = {
    primary: "bg-primary text-white hover:brightness-110",
    err: "bg-err text-white hover:opacity-90",
    "err-subtle": "text-err border border-err/25 hover:bg-err-bg",
    warn: "text-text-primary border border-border-bright hover:bg-bg-surface",
    muted: "text-text-primary border border-border-bright hover:bg-bg-surface",
  };
  return (
    <button
      className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium transition-all ${
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
      } ${styles[variant] || styles.muted}`}
      onClick={onClick}
      disabled={disabled}
    >
      {disabled ? "..." : label}
    </button>
  );
}

/* ── Split Button ── */

function SplitBtn({ label, onClick, disabled, menuItems }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  menuItems: { label: string; onClick: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const base = "text-text-primary border border-border-bright hover:bg-bg-surface transition-all text-[13px] font-medium";

  return (
    <div ref={ref} className="relative flex">
      <button
        onClick={onClick}
        disabled={disabled}
        className={`${base} px-3.5 py-1.5 rounded-l-lg border-r-0 ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
      >
        {label}
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={`${base} px-2 py-1.5 rounded-r-lg ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 bg-bg-raised border border-border rounded-lg shadow-xl z-20 min-w-[160px] py-1">
          {menuItems.map((item) => (
            <button
              key={item.label}
              onClick={() => { item.onClick(); setOpen(false); }}
              className="w-full text-left px-3.5 py-2 text-[12px] text-text-primary hover:bg-bg-surface transition-colors cursor-pointer"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

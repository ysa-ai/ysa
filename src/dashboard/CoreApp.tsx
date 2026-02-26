import { useCallback, useEffect, useRef, useState } from "react";
import { TaskList } from "./TaskList";
import { TaskInput } from "./TaskInput";
import { TaskDetail } from "./TaskDetail";
import { StatusFilter } from "./StatusFilter";
import { ResourceBar } from "./ResourceBar";
import type { TaskData } from "./TaskRow";
import type { ResourceMetrics } from "../lib/resource-poller";

interface CoreAppProps {
  tasks: TaskData[];
  logEntries: Array<{ type: string; icon?: string; text: string; tool?: string }>;
  resultMarkdown: string | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onRun: (config: { prompt: string; branch: string; networkPolicy: "none" | "strict"; maxTurns: number; provider: string; model?: string; allowedHosts?: string }) => void;
  onStop: (taskId: string) => void;
  onRelaunch: (taskId: string) => void;
  onContinue: (taskId: string) => void;
  onOpenTerminal: (taskId: string) => void;
  onChangeTerminal: (taskId: string) => void;
  onOpenSettings: () => void;
  onRefine: (taskId: string, prompt: string) => void;
  onArchive: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  isRunPending?: boolean;
  pendingTaskIds?: Set<string>;
  hiddenStatuses: Set<string>;
  onToggleStatus: (status: string) => void;
  resourceMetrics?: ResourceMetrics | null;
  resourceStale?: boolean;
}

export function CoreApp({
  tasks,
  logEntries,
  resultMarkdown,
  selectedTaskId,
  onSelectTask,
  onRun,
  onStop,
  onRelaunch,
  onContinue,
  onOpenTerminal,
  onChangeTerminal,
  onOpenSettings,
  onRefine,
  onArchive,
  onDelete,
  isRunPending,
  pendingTaskIds = new Set(),
  hiddenStatuses,
  onToggleStatus,
  resourceMetrics,
  resourceStale,
}: CoreAppProps) {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("theme") as "dark" | "light") || "dark";
    }
    return "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const selectedTask = tasks.find((t) => t.task_id === selectedTaskId) ?? null;
  const statusCounts = [...new Set(tasks.map((t) => t.status))]
    .sort()
    .map((status) => ({
      status,
      count: tasks.filter((t) => t.status === status).length,
    }));

  const filtered = tasks.filter((t) => !hiddenStatuses.has(t.status));
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "j") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" && focusedIndex >= 0 && focusedIndex < filtered.length) {
        e.preventDefault();
        onSelectTask(filtered[focusedIndex].task_id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onSelectTask(null);
      } else if (e.key === "n") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    },
    [filtered, focusedIndex, onSelectTask],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    setFocusedIndex(-1);
  }, [hiddenStatuses]);

  return (
    <div className="h-screen flex bg-bg text-text-primary">
      {/* Left Sidebar */}
      <aside className="w-[320px] 2xl:w-[400px] shrink-0 border-r border-border flex flex-col bg-bg-raised">
        {/* Sidebar Header — h-14 px-6 to align with detail header */}
        <div className="shrink-0 h-14 px-6 border-b border-border flex items-center gap-3">
          <h1 className="text-[15px] font-semibold tracking-tight">Your Secure Agent</h1>
          <button
            onClick={onOpenSettings}
            className="ml-auto text-text-faint hover:text-text-secondary transition-colors cursor-pointer"
            title="Settings"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="flex items-center gap-1.5 cursor-pointer group"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-colors ${theme === "dark" ? "text-text-secondary" : "text-text-faint"}`}>
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <div className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${theme === "light" ? "bg-primary" : "bg-border"} group-hover:brightness-125`}>
              <div className={`absolute top-[3px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200 ${theme === "light" ? "left-[18px]" : "left-[3px]"}`} />
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-colors ${theme === "light" ? "text-text-secondary" : "text-text-faint"}`}>
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          </button>
        </div>

        <TaskInput onRun={onRun} isPending={isRunPending} textareaRef={inputRef} />

        {statusCounts.length > 0 && (
          <div className="shrink-0 px-6 py-2.5 border-b border-border">
            <StatusFilter statuses={statusCounts} hiddenStatuses={hiddenStatuses} onToggle={onToggleStatus} />
          </div>
        )}

        <TaskList
          tasks={filtered}
          selectedTaskId={selectedTaskId}
          focusedIndex={focusedIndex}
          onSelect={(id) => onSelectTask(id)}
        />

        <div className="shrink-0 px-5 py-4 border-t border-border bg-bg-raised h-28 flex flex-col justify-center">
          <ResourceBar metrics={resourceMetrics ?? null} stale={resourceStale ?? true} />
        </div>
      </aside>

      {/* Right Pane */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg">
        {selectedTask ? (
          <TaskDetail
            task={selectedTask}
            logEntries={logEntries}
            resultMarkdown={resultMarkdown}
            onStop={onStop}
            onRelaunch={onRelaunch}
            onContinue={onContinue}
            onOpenTerminal={onOpenTerminal}
            onChangeTerminal={onChangeTerminal}
            onRefine={onRefine}
            onArchive={onArchive}
            onDelete={onDelete}
            isPending={pendingTaskIds.has(selectedTask.task_id)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-[14px] text-text-muted">Select a task or create a new one</p>
              <div className="flex items-center justify-center gap-4 mt-3 text-[11px] text-text-faint">
                <span>
                  <kbd className="px-1.5 py-0.5 rounded bg-bg-surface border border-border font-mono text-[10px]">j</kbd>
                  <span className="mx-0.5">/</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-bg-surface border border-border font-mono text-[10px]">k</kbd>
                  <span className="ml-1.5">navigate</span>
                </span>
                <span>
                  <kbd className="px-1.5 py-0.5 rounded bg-bg-surface border border-border font-mono text-[10px]">Enter</kbd>
                  <span className="ml-1.5">select</span>
                </span>
                <span>
                  <kbd className="px-1.5 py-0.5 rounded bg-bg-surface border border-border font-mono text-[10px]">n</kbd>
                  <span className="ml-1.5">new task</span>
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

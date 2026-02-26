import { formatDuration } from "./format";

export interface TaskData {
  task_id: string;
  prompt: string;
  status: string;
  branch: string;
  failure_reason: string | null;
  session_id: string | null;
  worktree: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
}

const STATUS_DOT: Record<string, string> = {
  queued: "bg-text-faint",
  running: "bg-primary",
  completed: "bg-ok",
  failed: "bg-err",
  stopped: "bg-warn",
  archived: "bg-text-faint/50",
};

interface TaskRowProps {
  task: TaskData;
  selected: boolean;
  focused: boolean;
  onSelect: (taskId: string) => void;
}

export function TaskRow({ task, selected, focused, onSelect }: TaskRowProps) {
  const truncated = task.prompt.length > 90 ? task.prompt.slice(0, 87) + "..." : task.prompt;
  const dotColor = STATUS_DOT[task.status] || "bg-muted";
  const isRunning = task.status === "running";

  return (
    <button
      className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-all cursor-pointer border-l-2 ${
        selected
          ? "bg-primary-subtle border-l-primary"
          : focused
            ? "bg-bg-surface border-l-text-faint"
            : "border-l-transparent hover:bg-bg-surface/60"
      }`}
      onClick={() => onSelect(task.task_id)}
    >
      <span
        className={`mt-[7px] shrink-0 w-2 h-2 rounded-full ${dotColor} ${
          isRunning ? "animate-[pulse_1.5s_infinite]" : ""
        }`}
      />
      <div className="flex-1 min-w-0">
        <p className={`text-[13px] leading-snug ${selected ? "text-text-primary font-medium" : "text-text-secondary"}`}>
          {truncated}
        </p>
        <div className="flex items-center gap-2.5 mt-1.5">
          <span className="font-mono text-[10px] text-text-faint bg-bg-inset px-1.5 py-0.5 rounded border border-border-subtle">
            {task.branch}
          </span>
          {task.started_at && (
            <span className="text-[10px] text-text-faint font-mono">
              {formatDuration(task.started_at, task.finished_at)}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

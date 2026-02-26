import { statusLabel } from "./format";

const CHIP_ACTIVE_COLORS: Record<string, string> = {
  queued: "text-text-muted border-border",
  running: "text-primary border-border",
  completed: "text-ok border-border",
  failed: "text-err border-border",
  stopped: "text-warn border-border",
  archived: "text-text-faint border-border-subtle",
};

interface StatusFilterProps {
  statuses: { status: string; count: number }[];
  hiddenStatuses: Set<string>;
  onToggle: (status: string) => void;
}

export function StatusFilter({ statuses, hiddenStatuses, onToggle }: StatusFilterProps) {
  if (statuses.length === 0) return null;

  return (
    <div className="flex gap-1.5 flex-wrap">
      {statuses.map(({ status, count }) => {
        const active = !hiddenStatuses.has(status);
        return (
          <button
            key={status}
            onClick={() => onToggle(status)}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide border cursor-pointer transition-all ${
              active
                ? CHIP_ACTIVE_COLORS[status] || "text-muted border-muted/20 bg-muted/8"
                : "text-text-faint border-transparent bg-transparent opacity-40 hover:opacity-60"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            {statusLabel(status)}
            <span className="font-bold tabular-nums">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

import { statusLabel } from "./format";

const BADGE_COLORS: Record<string, string> = {
  queued: "bg-text-faint/15 text-text-muted",
  running: "bg-primary-subtle text-primary",
  completed: "bg-ok-bg text-ok",
  failed: "bg-err-bg text-err",
  stopped: "bg-warn-bg text-warn",
  archived: "bg-text-faint/10 text-text-faint",
};

export function StatusBadge({ status }: { status: string }) {
  const colors = BADGE_COLORS[status] || "bg-muted/15 text-muted";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide shrink-0 ${colors}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full bg-current ${
          status === "running" ? "animate-[pulse_1.5s_infinite]" : ""
        }`}
      />
      {statusLabel(status)}
    </span>
  );
}

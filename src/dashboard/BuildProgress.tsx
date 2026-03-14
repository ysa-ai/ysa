interface BuildProgressProps {
  step: string;
  progress: number;
  status: "building" | "done" | "error";
}

export function BuildProgress({ step, progress, status }: BuildProgressProps) {
  const isError = status === "error";
  const isBuilding = status === "building";
  return (
    <div className="px-6 py-3.5 border-b border-border bg-bg-raised">
      {/* same height as textarea rows=2 with py-2.5 */}
      <div className="h-[61px] flex flex-col justify-center gap-2">
        <p className="text-[11px] font-medium text-text-faint">
          {isError ? "Build failed" : status === "done" ? "Build complete" : "Building runtime image…"}
        </p>
        <div className="w-full h-1.5 rounded-full bg-bg-inset overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${isError ? "bg-err" : "bg-primary"} ${isBuilding ? "shimmer" : ""}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      {/* same mt-2.5 + height as the Run button row */}
      <div className="flex items-center justify-between mt-2.5">
        <p className="text-[12px] text-text-muted truncate max-w-[85%]">{step}</p>
        <span className={`text-[11px] font-mono shrink-0 ml-2 ${isError ? "text-err" : "text-text-faint"}`}>
          {progress}%
        </span>
      </div>
    </div>
  );
}

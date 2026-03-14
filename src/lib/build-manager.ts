export type BuildStatus = "idle" | "building" | "done" | "error";

export interface BuildState {
  status: BuildStatus;
  step: string;
  progress: number; // 0-100
  error?: string;
}

let state: BuildState = { status: "idle", step: "", progress: 0 };

export function getBuildState(): BuildState {
  return state;
}

export function isBuildInProgress(): boolean {
  return state.status === "building";
}

function parseLine(line: string, currentProgress: number): { step?: string; progress?: number } {
  // podman build: "STEP 14/33: RUN apk add ..."
  let m = line.match(/STEP\s+(\d+)\/(\d+):\s*(.*)/);
  if (m) {
    const pct = Math.round((parseInt(m[1]) / parseInt(m[2])) * 100);
    return { step: `STEP ${m[1]}/${m[2]} — ${m[3].slice(0, 55)}`, progress: pct };
  }
  // apk inside podman build: "(3/5) Installing g++ ..."
  // only update the step label, never touch progress
  m = line.match(/\((\d+)\/(\d+)\)\s+(.*)/);
  if (m) {
    return { step: `${m[3].slice(0, 60)} (${m[1]}/${m[2]})` };
  }
  // mise: "mise python@3.13   [2/3] extract ..."
  m = line.match(/mise\s+(\S+)\s+\[(\d+)\/(\d+)\]\s+(.*)/);
  if (m) {
    const pct = Math.round((parseInt(m[2]) / parseInt(m[3])) * 100);
    return { step: `${m[1]} — ${m[4].slice(0, 50)} [${m[2]}/${m[3]}]`, progress: pct };
  }
  return {};
}

export function startBuild(
  run: (onLog: (line: string) => void) => Promise<{ ok: boolean; error?: string }>,
): void {
  state = { status: "building", step: "Starting…", progress: 0 };
  run((line) => {
    const parsed = parseLine(line, state.progress);
    const progress = parsed.progress !== undefined && parsed.progress >= state.progress
      ? parsed.progress
      : undefined;
    state = {
      ...state,
      step: parsed.step ?? state.step,
      progress: progress ?? state.progress,
    };
  }).then((result) => {
    state = {
      status: result.ok ? "done" : "error",
      step: result.ok ? "Done" : (result.error ?? "Build failed"),
      progress: result.ok ? 100 : state.progress,
      error: result.error,
    };
  }).catch((err) => {
    state = { status: "error", step: String(err), progress: state.progress, error: String(err) };
  });
}

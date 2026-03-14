import { Suspense, useCallback, useMemo, useState } from "react";
import { CoreApp } from "../src/dashboard/CoreApp";
import type { TaskData } from "../src/dashboard/TaskRow";
import { trpc } from "./trpc";
import { useToast, ToastProvider } from "./Toast";
import { Setup } from "./Setup";
import { TerminalPicker } from "./TerminalPicker";

function Main() {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set(["archived"]));
  const [terminalPickerTaskId, setTerminalPickerTaskId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const showToast = useToast();
  const utils = trpc.useUtils();

  const { data: appConfig, isLoading: configLoading } = trpc.config.get.useQuery();

  const { data: allTasks = [] } = trpc.tasks.list.useQuery(undefined, {
    refetchInterval: (query) => {
      const data = query.state.data as Array<{ status: string }> | undefined;
      if (!data) return false;
      return data.some((t) => t.status === "running" || t.status === "queued") ? 5000 : false;
    },
  });

  const toggleStatus = useCallback((status: string) => {
    setHiddenStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const selectedTask = (allTasks as TaskData[]).find(
    (t) => t.task_id === selectedTaskId,
  );
  const { data: logEntries = [] } = trpc.tasks.log.useQuery(
    { taskId: selectedTaskId! },
    {
      enabled: !!selectedTaskId,
      refetchInterval: selectedTask?.status === "running" ? 3000 : false,
    },
  );

  const { data: resultMarkdown = null } = trpc.tasks.result.useQuery(
    { taskId: selectedTaskId! },
    {
      enabled: !!selectedTaskId && selectedTask?.status !== "queued",
      refetchInterval: selectedTask?.status === "running" ? 5000 : false,
    },
  );

  const { data: resources } = trpc.system.resources.useQuery(undefined, { refetchInterval: 5000 });

  const { data: buildState, refetch: refetchBuildStatus } = trpc.system.buildStatus.useQuery(undefined, {
    refetchInterval: (query) => {
      const s = (query.state.data as { status: string } | undefined)?.status;
      return s === "building" ? 500 : 5000;
    },
  });

  const invalidate = () => utils.tasks.invalidate();

  const runMutation = trpc.taskActions.run.useMutation({
    onSuccess: (data: { task_id: string }) => {
      showToast(`Task ${data.task_id.slice(0, 8)} created`, "success");
      setSelectedTaskId(data.task_id);
      invalidate();
    },
    onError: (err: { message: string }) => showToast(err.message, "error"),
  });

  const stopMutation = trpc.taskActions.stop.useMutation({
    onSuccess: () => { showToast("Task stopped", "success"); invalidate(); },
    onError: (err: { message: string }) => showToast(err.message, "error"),
  });

  const relaunchMutation = trpc.taskActions.relaunch.useMutation({
    onSuccess: () => { showToast("Task relaunched", "success"); invalidate(); },
    onError: (err: { message: string }) => showToast(err.message, "error"),
  });

  const continueMutation = trpc.taskActions.continue.useMutation({
    onSuccess: () => { showToast("Task continuing", "success"); invalidate(); },
    onError: (err: { message: string }) => showToast(err.message, "error"),
  });

  const setConfigMutation = trpc.config.set.useMutation({
    onSuccess: () => utils.config.invalidate(),
  });

  const openTerminalMutation = trpc.taskActions.openTerminal.useMutation({
    onSuccess: () => showToast("Sandbox shell opened", "success"),
    onError: (err: { message: string }) => showToast(err.message, "error"),
  });

  const handleOpenTerminal = (taskId: string) => {
    if (appConfig?.preferred_terminal) {
      openTerminalMutation.mutate({ taskId });
    } else {
      setTerminalPickerTaskId(taskId);
    }
  };

  const handleTerminalPicked = (terminalId: string, remember: boolean) => {
    if (remember) {
      setConfigMutation.mutate({ preferred_terminal: terminalId });
    }
    if (terminalPickerTaskId) {
      openTerminalMutation.mutate({ taskId: terminalPickerTaskId });
    }
    setTerminalPickerTaskId(null);
  };

  const refineMutation = trpc.taskActions.refine.useMutation({
    onSuccess: () => { showToast("Refine started", "success"); invalidate(); },
    onError: (err: { message: string }) => showToast(err.message, "error"),
  });

  const archiveMutation = trpc.taskActions.archive.useMutation({
    onSuccess: () => { showToast("Archived", "success"); invalidate(); },
    onError: (err: { message: string }) => showToast(err.message, "error"),
  });

  const deleteMutation = trpc.taskActions.delete.useMutation({
    onMutate: async ({ taskId }) => {
      await utils.tasks.list.cancel();
      const prev = utils.tasks.list.getData();
      utils.tasks.list.setData(undefined, (old: any) =>
        old ? old.filter((t: TaskData) => t.task_id !== taskId) : [],
      );
      if (selectedTaskId === taskId) setSelectedTaskId(null);
      return { prev };
    },
    onError: (err: { message: string }, _vars, ctx: any) => {
      if (ctx?.prev) utils.tasks.list.setData(undefined, ctx.prev);
      showToast(err.message, "error");
    },
    onSettled: () => invalidate(),
  });

  const pendingTaskIds = useMemo(() => {
    const set = new Set<string>();
    if (openTerminalMutation.isPending && openTerminalMutation.variables?.taskId) set.add(openTerminalMutation.variables.taskId);
    if (stopMutation.isPending && stopMutation.variables?.taskId) set.add(stopMutation.variables.taskId);
    if (relaunchMutation.isPending && relaunchMutation.variables?.taskId) set.add(relaunchMutation.variables.taskId);
    if (continueMutation.isPending && continueMutation.variables?.taskId) set.add(continueMutation.variables.taskId);
    if (archiveMutation.isPending && archiveMutation.variables?.taskId) set.add(archiveMutation.variables.taskId);
    if (deleteMutation.isPending && deleteMutation.variables?.taskId) set.add(deleteMutation.variables.taskId);
    if (refineMutation.isPending && refineMutation.variables?.taskId) set.add(refineMutation.variables.taskId);
    return set;
  }, [openTerminalMutation.isPending, openTerminalMutation.variables, stopMutation.isPending, stopMutation.variables, relaunchMutation.isPending, relaunchMutation.variables, continueMutation.isPending, continueMutation.variables, archiveMutation.isPending, archiveMutation.variables, deleteMutation.isPending, deleteMutation.variables, refineMutation.isPending, refineMutation.variables]);

  if (configLoading) return <Loading />;
  if (!appConfig?.project_root) return <Setup onComplete={() => utils.config.invalidate()} />;

  return (
    <>
    {settingsOpen && (
      <Setup
        onComplete={() => { utils.config.invalidate(); setSettingsOpen(false); refetchBuildStatus(); }}
        onClose={() => setSettingsOpen(false)}
      />
    )}
    {terminalPickerTaskId && (
      <TerminalPicker
        onConfirm={handleTerminalPicked}
        onCancel={() => setTerminalPickerTaskId(null)}
      />
    )}
    <CoreApp
      tasks={allTasks as any}
      logEntries={logEntries as any}
      resultMarkdown={resultMarkdown ?? null}
      selectedTaskId={selectedTaskId}
      onSelectTask={setSelectedTaskId}
      onRun={(config) =>
        runMutation.mutate({
          prompt: config.prompt,
          branch: config.branch,
          networkPolicy: config.networkPolicy,
          maxTurns: config.maxTurns,
          provider: config.provider,
          model: config.model,
          allowedHosts: config.allowedHosts,
        })
      }
      onStop={(id) => stopMutation.mutate({ taskId: id })}
      onRelaunch={(id) => relaunchMutation.mutate({ taskId: id })}
      onContinue={(id) => continueMutation.mutate({ taskId: id })}
      onArchive={(id) => archiveMutation.mutate({ taskId: id })}
      onOpenTerminal={handleOpenTerminal}
      onChangeTerminal={(id) => setTerminalPickerTaskId(id)}
      onOpenSettings={() => setSettingsOpen(true)}
      onRefine={(id, prompt) => refineMutation.mutate({ taskId: id, prompt })}
      onDelete={(id) => deleteMutation.mutate({ taskId: id })}
      isRunPending={runMutation.isPending}
      pendingTaskIds={pendingTaskIds}
      hiddenStatuses={hiddenStatuses}
      onToggleStatus={toggleStatus}
      resourceMetrics={resources?.metrics}
      resourceStale={resources?.stale}
      buildState={buildState ?? null}
    />
    </>
  );
}

function Loading() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center text-text-muted">
      Loading...
    </div>
  );
}

function NotCompatible() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-6">
      <div className="text-center max-w-xs">
        <p className="text-[28px] mb-3">🖥️</p>
        <h1 className="text-[16px] font-semibold text-text-primary mb-2">Desktop only</h1>
        <p className="text-[13px] text-text-muted leading-relaxed">
          ysa is designed for desktop use. Open it on a laptop or desktop browser for the best experience.
        </p>
      </div>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <div className="block lg:hidden h-screen">
        <NotCompatible />
      </div>
      <div className="hidden lg:block h-screen">
        <Suspense fallback={<Loading />}>
          <Main />
        </Suspense>
      </div>
    </ToastProvider>
  );
}

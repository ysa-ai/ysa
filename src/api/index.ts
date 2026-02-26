import { router } from "./init";
import { tasksRouter } from "./tasks";
import { taskActionsRouter } from "./task-actions";
import { systemRouter } from "./system";
import { configRouter } from "./config";

export { tasksRouter } from "./tasks";
export { taskActionsRouter } from "./task-actions";
export { configRouter } from "./config";

export const coreRouter = router({
  tasks: tasksRouter,
  taskActions: taskActionsRouter,
  system: systemRouter,
  config: configRouter,
});

export type CoreRouter = typeof coreRouter;

CREATE TABLE `tasks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `task_id` text NOT NULL,
  `prompt` text NOT NULL,
  `status` text NOT NULL,
  `branch` text NOT NULL,
  `worktree` text NOT NULL,
  `session_id` text,
  `error` text,
  `failure_reason` text,
  `log_path` text,
  `started_at` text,
  `finished_at` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX `tasks_task_id_unique` ON `tasks` (`task_id`);

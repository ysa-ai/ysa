CREATE TABLE `container_peaks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `peak_mb` integer NOT NULL,
  `recorded_at` text NOT NULL DEFAULT (datetime('now'))
);
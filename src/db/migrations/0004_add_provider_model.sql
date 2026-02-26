ALTER TABLE tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN model TEXT;

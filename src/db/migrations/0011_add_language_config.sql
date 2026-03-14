ALTER TABLE config ADD COLUMN languages TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE config ADD COLUMN shadow_dirs TEXT;

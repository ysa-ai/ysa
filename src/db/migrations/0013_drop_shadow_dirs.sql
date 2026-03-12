CREATE TABLE config_new (
  id INTEGER PRIMARY KEY DEFAULT 1,
  project_root TEXT,
  default_model TEXT,
  default_network_policy TEXT NOT NULL DEFAULT 'none',
  preferred_terminal TEXT,
  port INTEGER,
  anthropic_api_key TEXT,
  mistral_api_key TEXT,
  auth_token TEXT,
  max_concurrent_tasks INTEGER NOT NULL DEFAULT 10,
  languages TEXT NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
INSERT INTO config_new (id, project_root, default_model, default_network_policy, preferred_terminal, port, anthropic_api_key, mistral_api_key, auth_token, max_concurrent_tasks, languages)
SELECT id, project_root, default_model, default_network_policy, preferred_terminal, port, anthropic_api_key, mistral_api_key, auth_token, max_concurrent_tasks, languages FROM config;
--> statement-breakpoint
DROP TABLE config;
--> statement-breakpoint
ALTER TABLE config_new RENAME TO config;

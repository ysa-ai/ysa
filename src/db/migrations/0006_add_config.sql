CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  project_root TEXT,
  default_model TEXT,
  default_network_policy TEXT NOT NULL DEFAULT 'none'
);

-- Cloud invites (v0 split-plane, docs/roadmap/cloud-deploy.md): codes are
-- MINTED on the engine machine (npm run invites:mint) and recorded here so
-- the operator always has the local ledger, then exported as SQL/CSV for
-- Supabase (or pushed directly once keys exist). Local rows are the mint
-- record; redemption state lives cloud-side only.
CREATE TABLE IF NOT EXISTS cloud_invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  issuer TEXT NOT NULL DEFAULT 'operator',
  max_completed_applications INTEGER NOT NULL,
  base_url TEXT NOT NULL,
  link TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

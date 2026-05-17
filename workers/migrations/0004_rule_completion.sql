-- 0004_rule_completion.sql — 规则闭环补全

ALTER TABLE lottery_rounds ADD COLUMN pancake_lottery_id TEXT;
ALTER TABLE lottery_rounds ADD COLUMN draw_source TEXT;

CREATE TABLE IF NOT EXISTS reward_claims (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  kind TEXT NOT NULL,
  reward_token TEXT NOT NULL,
  reward_amount TEXT NOT NULL,
  round INTEGER,
  source_ref TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  claim_signature_nonce TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user, kind, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_reward_claims_user ON reward_claims(user, claimed);
CREATE INDEX IF NOT EXISTS idx_reward_claims_round ON reward_claims(round, kind);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stake_source_tx ON stake_orders(source_tx_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_source_tx ON ai_orders(source_tx_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_swap_source_tx ON stock_swap_locks(source_tx_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_source_tx ON burn_records(source_tx_hash);

INSERT OR IGNORE INTO admin_config (key, value, updated_by, updated_at) VALUES
  ('pancake_lottery_address', '', 'init', strftime('%s','now'));
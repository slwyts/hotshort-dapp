export const SCHEMA_SQL = `
-- HotShort D1 schema - consolidated pre-deploy baseline.

CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,
  referrer TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer);

CREATE TABLE IF NOT EXISTS referral_paths (
  user TEXT PRIMARY KEY,
  level1 TEXT,
  level2 TEXT,
  level3 TEXT,
  bound_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_codes (
  code TEXT PRIMARY KEY,
  user TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user);

CREATE TABLE IF NOT EXISTS agent_accounts (
  address TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_accounts_enabled ON agent_accounts(enabled);

CREATE TABLE IF NOT EXISTS agent_alert_acknowledgements (
  agent_address TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  acknowledged_at INTEGER NOT NULL,
  PRIMARY KEY (agent_address, alert_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_alert_ack_agent ON agent_alert_acknowledgements(agent_address, acknowledged_at);

CREATE TABLE IF NOT EXISTS stake_orders (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  lock_months INTEGER NOT NULL,
  monthly_rate_bps INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  matures_at INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  claim_tx_hash TEXT,
  source_tx_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stake_user ON stake_orders(user, claimed);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stake_source_tx ON stake_orders(source_tx_hash);

CREATE TABLE IF NOT EXISTS stake_rates (
  asset TEXT NOT NULL,
  lock_months INTEGER NOT NULL,
  monthly_rate_bps INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset, lock_months)
);

CREATE TABLE IF NOT EXISTS ai_orders (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  tier TEXT NOT NULL,
  usdt_in TEXT NOT NULL,
  stock_granted TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source_tx_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_user ON ai_orders(user);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_source_tx ON ai_orders(source_tx_hash);

CREATE TABLE IF NOT EXISTS ai_stock_releases (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  user TEXT NOT NULL,
  release_index INTEGER NOT NULL,
  stock_amount TEXT NOT NULL,
  unlocks_at INTEGER NOT NULL,
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(order_id, release_index)
);
CREATE INDEX IF NOT EXISTS idx_ai_releases_user ON ai_stock_releases(user, released_at, unlocks_at);
CREATE INDEX IF NOT EXISTS idx_ai_releases_due ON ai_stock_releases(released_at, unlocks_at);

CREATE TABLE IF NOT EXISTS stock_holdings (
  user TEXT PRIMARY KEY,
  total_stock TEXT NOT NULL DEFAULT '0',
  locked_stock TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_holdings_total ON stock_holdings(total_stock);

CREATE TABLE IF NOT EXISTS stock_swaps (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  hs_in TEXT NOT NULL,
  stock_out TEXT NOT NULL,
  hs_price_usdt TEXT NOT NULL,
  stock_price_usdt TEXT NOT NULL,
  swapped_at INTEGER NOT NULL,
  source_tx_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_swaps_user ON stock_swaps(user, swapped_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_swaps_source_tx ON stock_swaps(source_tx_hash);

CREATE TABLE IF NOT EXISTS stock_sales (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  stock_in TEXT NOT NULL,
  hs_out TEXT NOT NULL,
  stock_price_usdt TEXT NOT NULL,
  hs_price_usdt TEXT NOT NULL,
  sold_at INTEGER NOT NULL,
  claim_nonce TEXT,
  claim_tx_hash TEXT,
  claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stock_sales_user ON stock_sales(user, sold_at);
CREATE INDEX IF NOT EXISTS idx_stock_sales_claim_nonce ON stock_sales(claim_nonce);

CREATE TABLE IF NOT EXISTS ai_dividend_pool_daily (
  date TEXT PRIMARY KEY,
  target_volume TEXT NOT NULL,
  ratio_bps INTEGER NOT NULL,
  total_pool_stock TEXT NOT NULL,
  stock_price_snapshot TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_dividend_user_daily (
  date TEXT NOT NULL,
  user TEXT NOT NULL,
  tier TEXT NOT NULL,
  stock_share TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, user)
);
CREATE INDEX IF NOT EXISTS idx_ai_div_user ON ai_dividend_user_daily(user, claimed);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  source_user TEXT NOT NULL,
  kind TEXT NOT NULL,
  reward_token TEXT NOT NULL,
  reward_amount TEXT NOT NULL,
  basis_amount TEXT,
  basis_kind TEXT,
  source_ref TEXT,
  earned_at INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  claim_signature_nonce TEXT
);
CREATE INDEX IF NOT EXISTS idx_referral_user ON referral_rewards(user, claimed);
CREATE INDEX IF NOT EXISTS idx_referral_source ON referral_rewards(source_user);

CREATE TABLE IF NOT EXISTS lottery_rounds (
  round_no INTEGER PRIMARY KEY,
  ticket_price_hs TEXT NOT NULL,
  pool_hs TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  drawn_at INTEGER,
  winning_number TEXT,
  commit_hash TEXT,
  reveal_seed TEXT,
  block_hash TEXT,
  pancake_lottery_id TEXT,
  draw_source TEXT
);

CREATE TABLE IF NOT EXISTS lottery_tickets (
  id TEXT PRIMARY KEY,
  round_no INTEGER NOT NULL,
  user TEXT NOT NULL,
  numbers TEXT NOT NULL,
  paid_hs TEXT NOT NULL,
  hit_digits INTEGER,
  prize_hs TEXT,
  claimed INTEGER NOT NULL DEFAULT 0,
  bought_at INTEGER NOT NULL,
  source_tx_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lottery_user ON lottery_tickets(user, round_no);
CREATE INDEX IF NOT EXISTS idx_lottery_round ON lottery_tickets(round_no);

CREATE TABLE IF NOT EXISTS lottery_commits (
  round_no INTEGER PRIMARY KEY,
  commit_hash TEXT NOT NULL,
  reveal_seed TEXT,
  committed_at INTEGER NOT NULL,
  revealed_at INTEGER
);

CREATE TABLE IF NOT EXISTS burn_records (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  hs_amount TEXT NOT NULL,
  referrer TEXT,
  settled_round INTEGER,
  claimed_individual INTEGER NOT NULL DEFAULT 0,
  burned_at INTEGER NOT NULL,
  source_tx_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_burn_user ON burn_records(user, claimed_individual);
CREATE INDEX IF NOT EXISTS idx_burn_records_round ON burn_records(settled_round);
CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_source_tx ON burn_records(source_tx_hash);

CREATE TABLE IF NOT EXISTS burn_rounds (
  round INTEGER PRIMARY KEY,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  total_burn_hs TEXT NOT NULL DEFAULT '0',
  weight_pool_hs TEXT NOT NULL DEFAULT '0',
  promotion_pool_hs TEXT NOT NULL DEFAULT '0',
  stake_pool_hs TEXT NOT NULL DEFAULT '0',
  ai_pool_hs TEXT NOT NULL DEFAULT '0',
  top10_pool_hs TEXT NOT NULL DEFAULT '0',
  black_hole_hs TEXT NOT NULL DEFAULT '0',
  top10_carryover_hs TEXT NOT NULL DEFAULT '0',
  settled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS burn_personal_status (
  user TEXT PRIMARY KEY,
  total_burned_hs TEXT NOT NULL DEFAULT '0',
  total_personal_claimed_hs TEXT NOT NULL DEFAULT '0',
  out_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS burn_top10_settlements (
  id TEXT PRIMARY KEY,
  round INTEGER NOT NULL,
  user TEXT NOT NULL,
  rank INTEGER NOT NULL,
  burn_hs TEXT NOT NULL,
  reward_hs TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_burn_top10_user ON burn_top10_settlements(user, claimed);
CREATE INDEX IF NOT EXISTS idx_burn_top10_round ON burn_top10_settlements(round);

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

CREATE TABLE IF NOT EXISTS genesis_nodes (
  address TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  source TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  imported_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS airdrop_list (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  hotshort_account TEXT NOT NULL,
  burn_total TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_airdrop_user ON airdrop_list(user);

CREATE TABLE IF NOT EXISTS admin_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_signatures (
  nonce TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  reason INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  signature TEXT NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_user ON claim_signatures(user, used_at);

INSERT OR IGNORE INTO admin_config (key, value, updated_by, updated_at) VALUES
  ('stock_price_usdt', '1', 'init', strftime('%s','now')),
  ('stock_symbol', 'WTO', 'init', strftime('%s','now')),
  ('stock_price_provider', 'manual', 'init', strftime('%s','now')),
  ('stock_quote_mode', 'auto', 'init', strftime('%s','now')),
  ('stock_volume_min_usdt', '100000', 'init', strftime('%s','now')),
  ('stock_volume_max_usdt', '200000', 'init', strftime('%s','now')),
  ('stock_dividend_ratio_bps', '100', 'init', strftime('%s','now')),
  ('lottery_ticket_price_usdt', '1', 'init', strftime('%s','now')),
  ('lottery_weekly_refill_hs', '100000', 'init', strftime('%s','now')),
  ('lottery_current_round', '1', 'init', strftime('%s','now')),
  ('burn_current_round', '1', 'init', strftime('%s','now')),
  ('pancake_lottery_address', '', 'init', strftime('%s','now'));
`;

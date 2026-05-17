/**
 * D1 schema for hotshort-dapp.
 * 共 12 张表 + 1 张签名审计表。
 */
export const SCHEMA_SQL = `
-- 用户基础信息（首次连接钱包时 upsert）
CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,                  -- lower-case
  referrer TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,                -- unix seconds
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer);

-- 推荐路径（写入 referrer 时一次性回填三代）
CREATE TABLE IF NOT EXISTS referral_paths (
  user TEXT PRIMARY KEY,
  level1 TEXT,
  level2 TEXT,
  level3 TEXT,
  bound_at INTEGER NOT NULL
);

-- 质押订单
CREATE TABLE IF NOT EXISTS stake_orders (
  id TEXT PRIMARY KEY,                       -- ulid
  user TEXT NOT NULL,
  asset TEXT NOT NULL,                       -- 'USDT' | 'HS' | 'LP'
  amount TEXT NOT NULL,                      -- decimal string (wei)
  lock_months INTEGER NOT NULL,              -- 1 / 3 / 6 / 12
  monthly_rate_bps INTEGER NOT NULL,         -- 50 = 0.5%；快照
  started_at INTEGER NOT NULL,
  matures_at INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,        -- 0/1
  claim_tx_hash TEXT,
  source_tx_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stake_user ON stake_orders(user, claimed);

-- 当前生效的利率（后台可改；新订单读最新）
CREATE TABLE IF NOT EXISTS stake_rates (
  asset TEXT NOT NULL,
  lock_months INTEGER NOT NULL,
  monthly_rate_bps INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset, lock_months)
);

-- AI 量化套餐订单
CREATE TABLE IF NOT EXISTS ai_orders (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  tier TEXT NOT NULL,                        -- 'genesis' | 'glory' | 'eternal' | 'shine' | 'pioneer'
  usdt_in TEXT NOT NULL,
  stock_granted TEXT NOT NULL,               -- 立即到账股票数
  created_at INTEGER NOT NULL,
  source_tx_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_user ON ai_orders(user);

-- 每日股票分红池快照
CREATE TABLE IF NOT EXISTS ai_dividend_pool_daily (
  date TEXT PRIMARY KEY,                     -- yyyy-mm-dd UTC+8
  target_volume TEXT NOT NULL,               -- 后台配置区间内随机的当日交易额
  ratio_bps INTEGER NOT NULL,                -- 分红比例（基点）
  total_pool_stock TEXT NOT NULL,
  hs_price_snapshot TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0
);

-- 每日用户分到的股票
CREATE TABLE IF NOT EXISTS ai_dividend_user_daily (
  date TEXT NOT NULL,
  user TEXT NOT NULL,
  tier TEXT NOT NULL,
  stock_share TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, user)
);
CREATE INDEX IF NOT EXISTS idx_ai_div_user ON ai_dividend_user_daily(user, claimed);

-- 彩票期次
CREATE TABLE IF NOT EXISTS lottery_rounds (
  round_no INTEGER PRIMARY KEY,
  ticket_price_hs TEXT NOT NULL,
  pool_hs TEXT NOT NULL,                     -- 当前奖池（含每周 10 万 HS 补给）
  opened_at INTEGER NOT NULL,
  drawn_at INTEGER,
  winning_number TEXT,                       -- 6 位数字字符串
  commit_hash TEXT,                          -- 上周提前 commit 的 hash
  reveal_seed TEXT,                          -- 本周开奖时 reveal
  block_hash TEXT                            -- 配合 future block 哈希，模拟薄饼公平性
);

-- 彩票门票
CREATE TABLE IF NOT EXISTS lottery_tickets (
  id TEXT PRIMARY KEY,
  round_no INTEGER NOT NULL,
  user TEXT NOT NULL,
  numbers TEXT NOT NULL,                     -- 6 位数字字符串
  paid_hs TEXT NOT NULL,
  hit_digits INTEGER,
  prize_hs TEXT,
  claimed INTEGER NOT NULL DEFAULT 0,
  bought_at INTEGER NOT NULL,
  source_tx_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lottery_user ON lottery_tickets(user, round_no);
CREATE INDEX IF NOT EXISTS idx_lottery_round ON lottery_tickets(round_no);

-- 燃烧记账（用户每笔燃烧）
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

-- 燃烧周榜
CREATE TABLE IF NOT EXISTS burn_weekly_pool (
  round INTEGER PRIMARY KEY,
  total_pool TEXT NOT NULL,                  -- 当周总池（含上周 40% 滚入）
  top10_carryover TEXT NOT NULL DEFAULT '0',
  settled_at INTEGER
);

-- 创世节点名单（CSV 导入 / 链上扫描）
CREATE TABLE IF NOT EXISTS genesis_nodes (
  address TEXT PRIMARY KEY,
  tier TEXT NOT NULL,                        -- 与 genesis-hotshort 5 档对齐
  source TEXT NOT NULL,                      -- 'csv' | 'onchain-scan'
  imported_at INTEGER NOT NULL,
  imported_by TEXT NOT NULL                  -- admin 钱包
);

-- 燃烧 1000U 以上的 hotshort 账户空投表单
CREATE TABLE IF NOT EXISTS airdrop_list (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  hotshort_account TEXT NOT NULL,
  burn_total TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | rejected
  submitted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_airdrop_user ON airdrop_list(user);

-- 后台可改配置（key-value）
CREATE TABLE IF NOT EXISTS admin_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- claim 签名审计 + 防重放
CREATE TABLE IF NOT EXISTS claim_signatures (
  nonce TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  reason INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  signature TEXT NOT NULL,
  used_at INTEGER,                           -- 链上消费后回填
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_user ON claim_signatures(user, used_at);

-- ===== P2 AI 量化版权交易扩展（与 0002_p2_ai_module.sql 同步） =====

CREATE TABLE IF NOT EXISTS stock_holdings (
  user TEXT PRIMARY KEY,
  total_stock TEXT NOT NULL DEFAULT '0',
  locked_stock TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_holdings_total ON stock_holdings(total_stock);

CREATE TABLE IF NOT EXISTS stock_swap_locks (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  hs_in TEXT NOT NULL,
  stock_locked TEXT NOT NULL,
  hs_price_usdt TEXT NOT NULL,
  stock_price_usdt TEXT NOT NULL,
  swapped_at INTEGER NOT NULL,
  unlocks_at INTEGER NOT NULL,
  unlocked INTEGER NOT NULL DEFAULT 0,
  source_tx_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swap_user ON stock_swap_locks(user, unlocked);

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

-- ===== P3 彩票 + 燃烧生态扩展（与 0003_p3_lottery_burn.sql 同步） =====

CREATE TABLE IF NOT EXISTS lottery_commits (
  round_no INTEGER PRIMARY KEY,
  commit_hash TEXT NOT NULL,
  reveal_seed TEXT,
  committed_at INTEGER NOT NULL,
  revealed_at INTEGER
);

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
CREATE INDEX IF NOT EXISTS idx_burn_records_round ON burn_records(settled_round);
`;

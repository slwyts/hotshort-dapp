-- 0003_p3_lottery_burn.sql — P3 彩票 + 燃烧生态扩展
-- 1) 彩票 commit-reveal 公平性
CREATE TABLE IF NOT EXISTS lottery_commits (
  round_no INTEGER PRIMARY KEY,
  commit_hash TEXT NOT NULL,
  reveal_seed TEXT,
  committed_at INTEGER NOT NULL,
  revealed_at INTEGER
);

-- 2) 燃烧周榜（替换原 burn_weekly_pool 的简版）
CREATE TABLE IF NOT EXISTS burn_rounds (
  round INTEGER PRIMARY KEY,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  total_burn_hs TEXT NOT NULL DEFAULT '0',           -- 当周燃烧 HS 总额
  weight_pool_hs TEXT NOT NULL DEFAULT '0',          -- 20% 权重分红池
  promotion_pool_hs TEXT NOT NULL DEFAULT '0',       -- 15% 推广池
  stake_pool_hs TEXT NOT NULL DEFAULT '0',           -- 5% 注入质押分红
  ai_pool_hs TEXT NOT NULL DEFAULT '0',              -- 5% 注入 AI 股票分红
  top10_pool_hs TEXT NOT NULL DEFAULT '0',           -- 5% 前十池
  black_hole_hs TEXT NOT NULL DEFAULT '0',           -- 50% 销毁
  top10_carryover_hs TEXT NOT NULL DEFAULT '0',      -- §4.4 上周 Top10 池滚入的 40%
  settled INTEGER NOT NULL DEFAULT 0
);

-- 3) 个人燃烧状态：§4.2 个人燃烧权益仅可领取 1 次，燃烧双倍出局后转权重分红
CREATE TABLE IF NOT EXISTS burn_personal_status (
  user TEXT PRIMARY KEY,
  total_burned_hs TEXT NOT NULL DEFAULT '0',
  total_personal_claimed_hs TEXT NOT NULL DEFAULT '0',
  out_at INTEGER,                                    -- 双倍出局时间，非 NULL 表示已切换为权重分红
  updated_at INTEGER NOT NULL
);

-- 4) Top10 周榜结算明细
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

-- 5) admin_config 默认值（彩票 + 燃烧）
INSERT OR IGNORE INTO admin_config (key, value, updated_by, updated_at) VALUES
  ('lottery_ticket_price_usdt',  '1',         'init', strftime('%s','now')),
  ('lottery_weekly_refill_hs',   '100000',    'init', strftime('%s','now')),
  ('lottery_current_round',      '1',         'init', strftime('%s','now')),
  ('burn_current_round',         '1',         'init', strftime('%s','now'));

-- 6) burn_records 索引（已存在则忽略）— 周榜统计用
CREATE INDEX IF NOT EXISTS idx_burn_records_round ON burn_records(settled_round);

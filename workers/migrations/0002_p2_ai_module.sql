-- 0002_p2_ai_module.sql — P2 AI 量化版权交易扩展
-- 1) 股票持仓总账（用户股票余额 = 套餐赠送 + 闪兑得到 + 每日分红）
CREATE TABLE IF NOT EXISTS stock_holdings (
  user TEXT PRIMARY KEY,
  total_stock TEXT NOT NULL DEFAULT '0',          -- decimal string，18 decimals 模拟
  locked_stock TEXT NOT NULL DEFAULT '0',         -- 闪兑锁仓 2 年的股票
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_holdings_total ON stock_holdings(total_stock);

-- 2) 闪兑锁仓订单（每笔单独跟踪到期时间）
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

-- 3) 返佣总账：直推一次性 + 每日股票三代
CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,                              -- 收到返佣的人（上级）
  source_user TEXT NOT NULL,                       -- 触发返佣的下级
  kind TEXT NOT NULL,                              -- 'direct' | 'gen1' | 'gen2' | 'gen3' | 'burn-gen1' | 'burn-gen2'
  reward_token TEXT NOT NULL,                      -- 'HS' | 'USDT' | 'STOCK'
  reward_amount TEXT NOT NULL,
  basis_amount TEXT,                               -- 计算基数（被返佣的源金额）
  basis_kind TEXT,                                 -- 'ai-package' | 'stock-dividend' | 'burn'
  source_ref TEXT,                                 -- 关联订单 id 或事件
  earned_at INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  claim_signature_nonce TEXT
);
CREATE INDEX IF NOT EXISTS idx_referral_user ON referral_rewards(user, claimed);
CREATE INDEX IF NOT EXISTS idx_referral_source ON referral_rewards(source_user);

-- 4) admin_config 默认值（只插入空缺；不覆盖已有）
INSERT OR IGNORE INTO admin_config (key, value, updated_by, updated_at) VALUES
  ('stock_price_usdt',          '1',      'init', strftime('%s','now')),
  ('stock_volume_min_usdt',     '100000', 'init', strftime('%s','now')),
  ('stock_volume_max_usdt',     '200000', 'init', strftime('%s','now')),
  ('stock_dividend_ratio_bps',  '100',    'init', strftime('%s','now')),
  ('hs_price_snapshot',         '0.001',  'init', strftime('%s','now'));

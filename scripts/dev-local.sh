#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# hotshort-dapp 本地全栈测试启动脚本
#
# 用法：
#   chmod +x scripts/dev-local.sh && ./scripts/dev-local.sh
#
# 前置条件：
#   - anvil (foundry)
#   - forge
#   - wrangler (pnpm -g add wrangler 或 workers/node_modules/.bin/wrangler)
#   - pnpm
#
# 助记词：test test test test test test test test test test test junk
# ============================================================

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 从 .env.local 读 BSC_FORK_RPC（付费 RPC，不入 git）
if [ -f "$ROOT/.env.local" ]; then
  BSC_FORK_RPC_LINE="$(grep -E '^BSC_FORK_RPC=' "$ROOT/.env.local" | tail -n 1 || true)"
  if [ -n "$BSC_FORK_RPC_LINE" ]; then
    BSC_FORK_RPC="${BSC_FORK_RPC_LINE#BSC_FORK_RPC=}"
    export BSC_FORK_RPC
  fi
fi
FORK_RPC="${BSC_FORK_RPC:-https://bsc-dataseed.binance.org}"
FORK_RPC_LABEL="https://bsc-dataseed.binance.org"
if [ -n "${BSC_FORK_RPC:-}" ]; then
  FORK_RPC_LABEL="configured BSC_FORK_RPC"
fi

echo "🔗 Starting anvil (fork BSC via $FORK_RPC_LABEL)..."
anvil \
  --fork-url "$FORK_RPC" \
  --chain-id 31337 \
  --accounts 10 \
  --mnemonic "test test test test test test test test test test test junk" \
  --silent &
ANVIL_PID=$!
sleep 4

echo "📦 Deploying HotshortVault to local chain..."
DEPLOY_OUTPUT=$(PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  INITIAL_SIGNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  ~/.foundry/bin/forge script script/Deploy.s.sol \
    --rpc-url http://127.0.0.1:8545 \
    --broadcast 2>&1)

VAULT_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "HotshortVault:" | awk '{print $2}')
echo "✅ Vault deployed at: $VAULT_ADDRESS"

# 写 .env.local 给前端用；保留 BSC_FORK_RPC 等本地私有配置
TMP_ENV="$(mktemp)"
if [ -f "$ROOT/.env.local" ]; then
  grep -vE '^(NEXT_PUBLIC_NETWORK|NEXT_PUBLIC_WORKER_URL|NEXT_PUBLIC_VAULT_ADDRESS|NEXT_PUBLIC_OWNER_ADDRESSES)=' "$ROOT/.env.local" > "$TMP_ENV" || true
fi
if [ -n "${BSC_FORK_RPC:-}" ] && ! grep -q '^BSC_FORK_RPC=' "$TMP_ENV"; then
  echo "BSC_FORK_RPC=$BSC_FORK_RPC" >> "$TMP_ENV"
fi
cat >> "$TMP_ENV" <<EOF
NEXT_PUBLIC_NETWORK=localnet
NEXT_PUBLIC_WORKER_URL=http://localhost:8787
NEXT_PUBLIC_VAULT_ADDRESS=$VAULT_ADDRESS
NEXT_PUBLIC_OWNER_ADDRESSES=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
EOF
mv "$TMP_ENV" "$ROOT/.env.local"
echo "📝 .env.local written"

# 写 workers/.dev.vars
cat > "$ROOT/workers/.dev.vars" <<EOF
CHAIN_ID=31337
RPC_URL=http://127.0.0.1:8545
VAULT_ADDRESS=$VAULT_ADDRESS
HS_TOKEN=0xcf4907621f0d9803c7288423b4303226b696b533
USDT_TOKEN=0x55d398326f99059ff775485246999027b3197955
PANCAKE_PAIR=0x2398e858ac6ad9dea4496bc6ecacea4ce77cc67e
PANCAKE_LOTTERY_ADDRESS=
E2E_TEST_MODE=1
SIGNER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
JWT_SECRET=test-jwt-secret-for-local-dev
BSCSCAN_API_KEY=
EOF

# 覆盖 Worker 的 wrangler.toml 里的 RPC 和 VAULT
export VAULT_ADDRESS

echo "🔧 Running D1 migrations..."
cd "$ROOT/workers"
# 本地 D1 需要先创建（如果不存在）
npx wrangler d1 execute hotshort --local --command "SELECT 1" 2>/dev/null || true
# 跑迁移
for f in migrations/*.sql; do
  echo "  applying $f"
  npx wrangler d1 execute hotshort --local --file "$f" 2>/dev/null || true
done

# 插入 owner 地址到 admin_config
npx wrangler d1 execute hotshort --local --command \
  "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('owner_addresses', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'script', strftime('%s','now'))" 2>/dev/null || true

echo "🚀 Starting Worker..."
npx wrangler dev --port 8787 &
WORKER_PID=$!
cd "$ROOT"
sleep 3

echo "🌐 Starting Next.js dev..."
pnpm dev &
NEXT_PID=$!
sleep 5

echo ""
echo "============================================"
echo "  ✅ 全栈本地环境已就绪"
echo ""
echo "  前端:   http://localhost:3000"
echo "  Worker: http://localhost:8787"
echo "  Anvil:  http://127.0.0.1:8545"
echo "  Vault:  $VAULT_ADDRESS"
echo ""
echo "  Owner:  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo "  Signer: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
echo "  Alice:  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
echo "  Bob:    0x90F79bf6EB2c4f870365E785982E1f101E93b906"
echo ""
echo "  按 Ctrl+C 停止所有服务"
echo "============================================"

# 等待任意子进程退出
trap "kill $ANVIL_PID $WORKER_PID $NEXT_PID 2>/dev/null; exit" INT TERM
wait

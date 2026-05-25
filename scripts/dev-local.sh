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

ANVIL_PID=""
WORKER_PID=""
NEXT_PID=""

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  for pid in "${NEXT_PID:-}" "${WORKER_PID:-}" "${ANVIL_PID:-}"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  exit "$code"
}

trap cleanup EXIT INT TERM

append_no_proxy() {
  local value="$1"
  case ",${NO_PROXY:-}," in
    *",$value,"*) ;;
    *) NO_PROXY="${NO_PROXY:+$NO_PROXY,}$value" ;;
  esac
  case ",${no_proxy:-}," in
    *",$value,"*) ;;
    *) no_proxy="${no_proxy:+$no_proxy,}$value" ;;
  esac
}

append_no_proxy "localhost"
append_no_proxy "127.0.0.1"
append_no_proxy "::1"
export NO_PROXY no_proxy

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" | awk 'NR > 1 { found = 1 } END { exit found ? 0 : 1 }'
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
    return $?
  fi
  return 1
}

for port in 8545 8787 3000; do
  if port_in_use "$port"; then
    echo "❌ Port $port is already in use. Stop the previous dev server first, then run pnpm dev:full again." >&2
    exit 1
  fi
done

DEPLOYER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
SIGNER_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
OWNER_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
SIGNER_ADDRESS="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
ALICE_ADDRESS="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
BOB_ADDRESS="0x90F79bf6EB2c4f870365E785982E1f101E93b906"
CHARLIE_ADDRESS="0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"
PANCAKE_ROUTER="0x10ED43C718714eb63d5aA57B78B54704E256024E"
FORGE_BIN="${FORGE_BIN:-$HOME/.foundry/bin/forge}"
CAST_BIN="${CAST_BIN:-$HOME/.foundry/bin/cast}"
LOCAL_RPC_URL="http://127.0.0.1:8545"
WRANGLER_CMD=(pnpm --dir "$ROOT/workers" exec wrangler)

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
if ! kill -0 "$ANVIL_PID" 2>/dev/null; then
  echo "❌ Anvil exited before it became ready." >&2
  exit 1
fi

echo "📦 Deploying HotshortVault to local chain..."
DEPLOY_OUTPUT=$(PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY \
  INITIAL_SIGNER=$SIGNER_ADDRESS \
  "$FORGE_BIN" script script/Deploy.s.sol \
    --rpc-url "$LOCAL_RPC_URL" \
    --broadcast 2>&1)

VAULT_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "HotshortVault:" | awk '{print $2}')
echo "✅ Vault deployed at: $VAULT_ADDRESS"

echo "🧪 Deploying local test tokens..."
TOKENS_OUTPUT=$(PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY \
  PANCAKE_ROUTER=$PANCAKE_ROUTER \
  WRITE_DEPLOYED_JSON=false \
  "$FORGE_BIN" script script/DeployTestTokens.s.sol \
    --rpc-url "$LOCAL_RPC_URL" \
    --broadcast 2>&1)

HS_TOKEN_ADDRESS=$(echo "$TOKENS_OUTPUT" | sed -n 's/.*TestHS[[:space:]]*:[[:space:]]*\(0x[a-fA-F0-9]\{40\}\).*/\1/p' | tail -n 1)
USDT_TOKEN_ADDRESS=$(echo "$TOKENS_OUTPUT" | sed -n 's/.*TestUSDT[[:space:]]*:[[:space:]]*\(0x[a-fA-F0-9]\{40\}\).*/\1/p' | tail -n 1)
PANCAKE_PAIR_ADDRESS=$(echo "$TOKENS_OUTPUT" | sed -n 's/.*PancakePair[[:space:]]*:[[:space:]]*\(0x[a-fA-F0-9]\{40\}\).*/\1/p' | tail -n 1)
if [[ -z "$HS_TOKEN_ADDRESS" || -z "$USDT_TOKEN_ADDRESS" || -z "$PANCAKE_PAIR_ADDRESS" ]]; then
  echo "$TOKENS_OUTPUT"
  echo "❌ Failed to parse test token deployment output" >&2
  exit 1
fi
echo "✅ TestHS: $HS_TOKEN_ADDRESS"
echo "✅ TestUSDT: $USDT_TOKEN_ADDRESS"
echo "✅ Test LP: $PANCAKE_PAIR_ADDRESS"

send_token() {
  local token="$1"
  local to="$2"
  local amount="$3"
  "$CAST_BIN" send "$token" "transfer(address,uint256)" "$to" "$amount" \
    --rpc-url "$LOCAL_RPC_URL" \
    --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
}

set_lp_balance() {
  local to="$1"
  local amount="$2"
  local slot
  local value
  slot=$("$CAST_BIN" index address "$to" 1)
  value=$("$CAST_BIN" to-uint256 "$amount")
  "$CAST_BIN" rpc anvil_setStorageAt "$PANCAKE_PAIR_ADDRESS" "$slot" "$value" \
    --rpc-url "$LOCAL_RPC_URL" >/dev/null
}

echo "💰 Funding local test accounts..."
USER_HS_WEI="100000000000000000000000000"
USER_USDT_WEI="1000000000000000000000000"
USER_LP_WEI="1000000000000000000000"
VAULT_HS_WEI="1000000000000000000000000000000"
VAULT_USDT_WEI="1000000000000000000000000000"
for account in "$OWNER_ADDRESS" "$SIGNER_ADDRESS" "$ALICE_ADDRESS" "$BOB_ADDRESS" "$CHARLIE_ADDRESS"; do
  send_token "$HS_TOKEN_ADDRESS" "$account" "$USER_HS_WEI"
  send_token "$USDT_TOKEN_ADDRESS" "$account" "$USER_USDT_WEI"
  set_lp_balance "$account" "$USER_LP_WEI"
done
send_token "$HS_TOKEN_ADDRESS" "$VAULT_ADDRESS" "$VAULT_HS_WEI"
send_token "$USDT_TOKEN_ADDRESS" "$VAULT_ADDRESS" "$VAULT_USDT_WEI"
echo "✅ Test accounts funded"

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
NEXT_PUBLIC_OWNER_ADDRESSES=$OWNER_ADDRESS
EOF
mv "$TMP_ENV" "$ROOT/.env.local"
echo "📝 .env.local written"

# 写 workers/.dev.vars
cat > "$ROOT/workers/.dev.vars" <<EOF
CHAIN_ID=31337
RPC_URL=http://127.0.0.1:8545
VAULT_ADDRESS=$VAULT_ADDRESS
HS_TOKEN=$HS_TOKEN_ADDRESS
USDT_TOKEN=$USDT_TOKEN_ADDRESS
PANCAKE_PAIR=$PANCAKE_PAIR_ADDRESS
PANCAKE_LOTTERY_ADDRESS=
E2E_TEST_MODE=1
STOCK_QUOTE_MODE=auto
SIGNER_PRIVATE_KEY=$SIGNER_PRIVATE_KEY
JWT_SECRET=test-jwt-secret-for-local-dev
BSCSCAN_API_KEY=
EOF

# 覆盖 Worker 的 wrangler.toml 里的 RPC 和 VAULT
export VAULT_ADDRESS

echo "🔧 Running D1 migrations..."
cd "$ROOT/workers"
# 本地 D1 需要先创建（如果不存在）
"${WRANGLER_CMD[@]}" d1 execute hotshort --local --command "SELECT 1" 2>/dev/null || true
# 清测试库后只跑数字迁移，避免 reset 被 wrangler migrations apply 当成正式迁移
"${WRANGLER_CMD[@]}" d1 execute hotshort --local --file sql/reset.sql 2>/dev/null || true
# 跑迁移
for f in migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  [ -e "$f" ] || continue
  echo "  applying $f"
  "${WRANGLER_CMD[@]}" d1 execute hotshort --local --file "$f" 2>/dev/null || true
done

echo "📈 Seeding WTO quote..."
WTO_QUOTE_CSV=$(curl -fsSL --max-time 8 'https://stooq.com/q/l/?s=wto.us&f=sd2t2ohlcv&h&e=csv' 2>/dev/null || true)
WTO_PRICE=$(printf '%s\n' "$WTO_QUOTE_CSV" | awk -F, 'NR==2 {print $7}')
if [[ "$WTO_PRICE" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  NOW_TS=$(date +%s)
  "${WRANGLER_CMD[@]}" d1 execute hotshort --local --command \
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('stock_price_usdt', '$WTO_PRICE', 'dev-local', $NOW_TS)" 2>/dev/null || true
  "${WRANGLER_CMD[@]}" d1 execute hotshort --local --command \
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('stock_price_provider', 'Stooq', 'dev-local', $NOW_TS)" 2>/dev/null || true
  echo "✅ WTO quote seeded from Stooq: $WTO_PRICE USDT"
else
  echo "⚠️  WTO quote seed skipped; using DB fallback price"
fi

# 插入 owner 地址到 admin_config
"${WRANGLER_CMD[@]}" d1 execute hotshort --local --command \
  "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('owner_addresses', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'script', strftime('%s','now'))" 2>/dev/null || true

echo "🚀 Starting Worker..."
"${WRANGLER_CMD[@]}" dev --port 8787 &
WORKER_PID=$!
cd "$ROOT"
echo "⏳ Waiting for Worker /config..."
for i in {1..30}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:8787/config" >/dev/null 2>&1; then
    echo "✅ Worker /config ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "❌ Worker /config is not reachable at http://127.0.0.1:8787/config" >&2
    kill "$ANVIL_PID" "$WORKER_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo "🌐 Starting Next.js dev..."
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY pnpm dev &
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
echo "  TestHS: $HS_TOKEN_ADDRESS"
echo "  TestUSDT: $USDT_TOKEN_ADDRESS"
echo "  LP:     $PANCAKE_PAIR_ADDRESS"
echo ""
echo "  Owner:  $OWNER_ADDRESS  (funded test account)"
echo "  Signer: $SIGNER_ADDRESS  (funded test account)"
echo "  Alice:  $ALICE_ADDRESS"
echo "  Bob:    $BOB_ADDRESS"
echo ""
echo "  按 Ctrl+C 停止所有服务"
echo "============================================"

wait

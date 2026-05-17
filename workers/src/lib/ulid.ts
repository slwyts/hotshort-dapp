/**
 * 简易 ULID 实现（不依赖外部包）。
 * Cloudflare Worker 环境支持 crypto.getRandomValues。
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
  const ts = Date.now();
  let timeStr = "";
  let t = ts;
  for (let i = 0; i < 10; i++) {
    timeStr = CROCKFORD[t % 32] + timeStr;
    t = Math.floor(t / 32);
  }
  const rnd = new Uint8Array(10);
  crypto.getRandomValues(rnd);
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    randStr += CROCKFORD[rnd[i % 10] % 32];
  }
  return timeStr + randStr;
}

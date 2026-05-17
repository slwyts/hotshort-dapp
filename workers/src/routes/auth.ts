import type { Context } from "hono";
import { Hono } from "hono";
import { verifyMessage, type Address } from "viem";
import type { Env } from "../env";
import { requireSecret } from "../env";
import { signJwt, verifyJwt } from "../lib/jwt";

export const auth = new Hono<{ Bindings: Env }>();

interface NonceRecord {
  nonce: string;
  createdAt: number;
}

const nonces = new Map<string, NonceRecord>();
const NONCE_TTL_MS = 5 * 60 * 1000;

function buildSiweMessage(address: string, nonce: string, ts: number): string {
  return [
    `Hotshort wants you to sign in.`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(ts).toISOString()}`,
  ].join("\n");
}

auth.post("/nonce", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { address?: string };
  const address = (body.address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    return c.json({ error: "bad address" }, 400);
  }
  const nonce = crypto.randomUUID();
  const createdAt = Date.now();
  nonces.set(address, { nonce, createdAt });
  return c.json({ message: buildSiweMessage(address, nonce, createdAt) });
});

auth.post("/verify", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    address?: string;
    signature?: string;
  };
  const address = (body.address || "").toLowerCase();
  const sig = body.signature as `0x${string}` | undefined;
  if (!/^0x[a-f0-9]{40}$/.test(address) || !sig) {
    return c.json({ error: "bad payload" }, 400);
  }
  const rec = nonces.get(address);
  if (!rec) return c.json({ error: "nonce expired" }, 400);
  if (Date.now() - rec.createdAt > NONCE_TTL_MS) {
    nonces.delete(address);
    return c.json({ error: "nonce expired" }, 400);
  }
  const msg = buildSiweMessage(address, rec.nonce, rec.createdAt);
  const valid = await verifyMessage({
    address: address as Address,
    message: msg,
    signature: sig,
  });
  if (!valid) return c.json({ error: "bad signature" }, 401);
  nonces.delete(address);

  const jwt = await signJwt(
    {
      sub: address,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400 * 7,
    },
    requireSecret(c.env, "JWT_SECRET"),
  );
  return c.json({ token: jwt, address });
});

/** 中间件：要求 Authorization: Bearer <jwt> 且校验通过；返回 lower-case 地址 */
export async function requireUser(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const h = c.req.header("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const payload = await verifyJwt(m[1], requireSecret(c.env, "JWT_SECRET"));
    return typeof payload.sub === "string" ? payload.sub.toLowerCase() : null;
  } catch {
    return null;
  }
}

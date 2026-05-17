/**
 * 极简 HMAC-SHA256 JWT（HS256），不依赖外部包。
 * 仅用于 Worker 自家签发的 SIWE session token。
 */

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const enc = new TextEncoder();
  const headerB = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(`${headerB}.${payloadB}`);
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return `${headerB}.${payloadB}.${base64UrlEncode(sig)}`;
}

export async function verifyJwt(
  token: string,
  secret: string,
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts;
  const enc = new TextEncoder();
  const data = enc.encode(`${h}.${p}`);
  const sig = base64UrlDecode(s);
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sig, data);
  if (!ok) throw new Error("bad signature");
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p))) as Record<string, unknown>;
  if (typeof payload.exp === "number" && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error("expired");
  }
  return payload;
}

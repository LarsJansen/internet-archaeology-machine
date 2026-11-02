// Owner access uses a signed, short-lived HttpOnly cookie. The owner token is
// submitted once over HTTPS and never stored in browser-readable storage.
export const OWNER_COOKIE = "__Host-iam_owner";
export const OWNER_SESSION_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createOwnerSession(secret: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + OWNER_SESSION_SECONDS;
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${expires}.${nonce}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

export async function verifyOwnerSession(request: Request, secret: string, now = Date.now()): Promise<boolean> {
  const raw = request.headers.get("Cookie") ?? "";
  const cookie = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${OWNER_COOKIE}=`));
  if (!cookie) return false;
  const value = cookie.slice(OWNER_COOKIE.length + 1);
  const parts = value.split(".");
  if (parts.length !== 3 || !/^\d{10,11}$/.test(parts[0])) return false;
  const expiration = Number(parts[0]);
  const current = Math.floor(now / 1000);
  if (expiration <= current || expiration > current + OWNER_SESSION_SECONDS || !/^[A-Za-z0-9_-]{16,64}$/.test(parts[1])) return false;
  const signature = fromBase64url(parts[2]);
  if (!signature || signature.length !== 32) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, encoder.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}

export function ownerSessionCookie(value: string): string {
  return `${OWNER_COOKIE}=${value}; Max-Age=${OWNER_SESSION_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export function clearOwnerSessionCookie(): string {
  return `${OWNER_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export function hasValidRequestOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  // Reject cross-site requests; allow non-browser clients without Origin.
  return !origin || origin === new URL(request.url).origin;
}

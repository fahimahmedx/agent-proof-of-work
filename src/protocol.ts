import { createHmac, timingSafeEqual } from "node:crypto";

export const PROTOCOL = "agent-proof-of-work/0.2";

/** Request header carrying the solved work: base64url(JSON.stringify({ challenge, response, controlAnswer })). */
export const WORK_HEADER = "X-Work";
/** Response header carrying an access pass after valid work; clients send it back to skip new work. */
export const PASS_HEADER = "X-Work-Pass";

/** Body of the HTTP 402 response that asks the agent to do work. */
export interface WorkRequired {
  protocol: typeof PROTOCOL;
  /** The LLM request the agent must answer. */
  prompt: string;
  /** Control question with an answer the server already knows. A correct answer vouches for the work. */
  control: string;
  /** Signed, opaque challenge token. Send it back unchanged in the proof. */
  challenge: string;
  minChars: number;
  maxChars: number;
  /** Unix seconds after which the challenge is no longer accepted. */
  expiresAt: number;
  /** Why the previous proof was rejected, if one was sent. */
  error?: string;
  instructions: string;
}

export interface WorkProof {
  challenge: string;
  response: string;
  controlAnswer: string;
}

export function encodeProof(proof: WorkProof): string {
  return Buffer.from(JSON.stringify(proof)).toString("base64url");
}

export function decodeProof(header: string): WorkProof | null {
  try {
    const proof = JSON.parse(Buffer.from(header, "base64url").toString());
    if ([proof?.challenge, proof?.response, proof?.controlAnswer].some((v) => typeof v !== "string")) return null;
    return proof;
  } catch {
    return null;
  }
}

/** Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)). */
export function signToken(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T>(token: string, secret: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PASS_HEADER,
  PROTOCOL,
  WORK_HEADER,
  decodeProof,
  signToken,
  verifyToken,
  type WorkRequired,
} from "./protocol.ts";

export * from "./protocol.ts";

export const DEFAULT_PROMPT = "Tell me about yourself.";

/** A completed unit of work: the LLM request and the agent's answer. */
export interface Work {
  challengeId: string;
  prompt: string;
  response: string;
  /** The URL the agent was trying to reach when it did the work. */
  resource: string;
}

export interface WorkGateOptions {
  /** HMAC secret used to sign challenges and passes. */
  secret: string;
  /** The LLM request agents must answer. Can vary per request. */
  prompt?: string | ((req: IncomingMessage) => string | Promise<string>);
  minChars?: number;
  maxChars?: number;
  challengeTtlSeconds?: number;
  /** How long one unit of work grants access. Set to 0 to require work on every request. */
  passTtlSeconds?: number;
  /** Extra check on the answer, e.g. an LLM judge. Return false to reject. */
  verify?: (work: Work) => boolean | Promise<boolean>;
  /** Receives every accepted unit of work. This is what the site gets paid with. */
  onWork?: (work: Work) => void | Promise<void>;
}

interface ChallengePayload {
  typ: "challenge";
  id: string;
  prompt: string;
  minChars: number;
  maxChars: number;
  exp: number;
}

interface PassPayload {
  typ: "pass";
  sub: string;
  exp: number;
}

type Next = (err?: unknown) => void;

const now = () => Math.floor(Date.now() / 1000);

/**
 * Connect/Express middleware that blocks every request until the caller has answered an LLM prompt.
 * Requests without valid work get HTTP 402 with a challenge; see README.md for the wire format.
 */
export function workGate(options: WorkGateOptions) {
  const {
    secret,
    prompt = DEFAULT_PROMPT,
    minChars = 50,
    maxChars = 4000,
    challengeTtlSeconds = 300,
    passTtlSeconds = 600,
    verify,
    onWork,
  } = options;
  if (!secret) throw new Error("workGate: secret is required");

  // Challenge ids that were already redeemed, with their expiry, to stop proof replay.
  const redeemed = new Map<string, number>();

  async function checkProof(header: string, resource: string): Promise<Work | string> {
    const proof = decodeProof(header);
    if (!proof) return "Malformed X-Work header.";
    const challenge = verifyToken<ChallengePayload>(proof.challenge, secret);
    if (challenge?.typ !== "challenge") return "Invalid challenge signature.";
    if (challenge.exp <= now()) return "Challenge expired.";
    if (redeemed.has(challenge.id)) return "Challenge already redeemed.";

    const response = proof.response.trim();
    if (response.length < challenge.minChars) return `Response shorter than ${challenge.minChars} characters.`;
    if (response.length > challenge.maxChars) return `Response longer than ${challenge.maxChars} characters.`;

    const work: Work = { challengeId: challenge.id, prompt: challenge.prompt, response, resource };
    if (verify && !(await verify(work))) return "Response rejected by verifier.";

    for (const [id, exp] of redeemed) if (exp <= now()) redeemed.delete(id);
    redeemed.set(challenge.id, challenge.exp);
    return work;
  }

  return async function workGateMiddleware(req: IncomingMessage, res: ServerResponse, next: Next) {
    try {
      const pass = req.headers[PASS_HEADER.toLowerCase()];
      if (typeof pass === "string") {
        const payload = verifyToken<PassPayload>(pass, secret);
        if (payload?.typ === "pass" && payload.exp > now()) return next();
      }

      let error: string | undefined;
      const proof = req.headers[WORK_HEADER.toLowerCase()];
      if (typeof proof === "string") {
        const result = await checkProof(proof, req.url ?? "/");
        if (typeof result !== "string") {
          await onWork?.(result);
          if (passTtlSeconds > 0) {
            const passPayload: PassPayload = { typ: "pass", sub: result.challengeId, exp: now() + passTtlSeconds };
            res.setHeader(PASS_HEADER, signToken(passPayload, secret));
          }
          return next();
        }
        error = result;
      }

      const challenge: ChallengePayload = {
        typ: "challenge",
        id: randomUUID(),
        prompt: typeof prompt === "function" ? await prompt(req) : prompt,
        minChars,
        maxChars,
        exp: now() + challengeTtlSeconds,
      };
      const body: WorkRequired = {
        protocol: PROTOCOL,
        prompt: challenge.prompt,
        challenge: signToken(challenge, secret),
        minChars,
        maxChars,
        expiresAt: challenge.exp,
        ...(error && { error }),
        instructions:
          `Access requires work. Answer "prompt" with an LLM (${minChars}-${maxChars} characters), then retry ` +
          `the same request with header ${WORK_HEADER}: base64url(JSON.stringify({ challenge, response })). ` +
          `Send the ${PASS_HEADER} response header back on later requests to skip new work until it expires.`,
      };
      res.statusCode = 402;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body, null, 2));
    } catch (err) {
      next(err);
    }
  };
}

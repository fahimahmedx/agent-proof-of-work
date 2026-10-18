import { createHmac, randomInt, randomUUID } from "node:crypto";
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

/** A question the server knows the answer to, asked alongside the real prompt. */
export interface ControlQuestion {
  question: string;
  answer: string;
}

/** Default control question: a random single-digit addition, e.g. "What is 1 + 1?". */
export function additionQuestion(): ControlQuestion {
  const a = randomInt(1, 10);
  const b = randomInt(1, 10);
  return { question: `What is ${a} + ${b}? Reply with only the number.`, answer: String(a + b) };
}

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
  /** Generates the control question. Defaults to a random single-digit addition. */
  control?: (req: IncomingMessage) => ControlQuestion | Promise<ControlQuestion>;
  minChars?: number;
  maxChars?: number;
  challengeTtlSeconds?: number;
  /** How long one unit of work grants access. Set to 0 to require work on every request. */
  passTtlSeconds?: number;
  /**
   * What a pass unlocks: every route behind this gate ("site"), or only the path the work was done for ("resource").
   * Use a different secret for each gate, or passes from one gate will unlock the other.
   */
  passScope?: "site" | "resource";
  /** Extra check on the answer, e.g. an LLM judge. Return false, or a reason string, to reject. */
  verify?: (work: Work) => boolean | string | Promise<boolean | string>;
  /** Receives every accepted unit of work. This is what the site gets paid with. */
  onWork?: (work: Work) => void | Promise<void>;
}

interface ChallengePayload {
  typ: "challenge";
  id: string;
  prompt: string;
  control: string;
  /** HMAC of the expected control answer, so the token doesn't reveal it. */
  controlHash: string;
  minChars: number;
  maxChars: number;
  exp: number;
}

interface PassPayload {
  typ: "pass";
  sub: string;
  exp: number;
  /** Set for resource-scoped passes: the only path this pass unlocks. */
  path?: string;
}

type Next = (err?: unknown) => void;

const now = () => Math.floor(Date.now() / 1000);
// Control answers are compared by their final word or number, so "3 + 4 = 7" and "The answer is 7." both match "7".
const normalizeAnswer = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g)?.at(-1) ?? "";

/**
 * Connect/Express middleware that blocks every request until the caller has answered an LLM prompt.
 * Requests without valid work get HTTP 402 with a challenge; see README.md for the wire format.
 */
export function workGate(options: WorkGateOptions) {
  const {
    secret,
    prompt = DEFAULT_PROMPT,
    control = additionQuestion,
    minChars = 50,
    maxChars = 4000,
    challengeTtlSeconds = 300,
    passTtlSeconds = 600,
    passScope = "site",
    verify,
    onWork,
  } = options;
  if (!secret) throw new Error("workGate: secret is required");

  // Challenge ids that were already redeemed, with their expiry, to stop proof replay.
  const redeemed = new Map<string, number>();
  const redeem = (challenge: ChallengePayload) => {
    for (const [id, exp] of redeemed) if (exp <= now()) redeemed.delete(id);
    redeemed.set(challenge.id, challenge.exp);
  };
  const controlHash = (challengeId: string, answer: string) =>
    createHmac("sha256", secret).update(`${challengeId}:${normalizeAnswer(answer)}`).digest("base64url");

  async function checkProof(header: string, resource: string): Promise<Work | string> {
    const proof = decodeProof(header);
    if (!proof) return "Malformed X-Work header.";
    const challenge = verifyToken<ChallengePayload>(proof.challenge, secret);
    if (challenge?.typ !== "challenge") return "Invalid challenge signature.";
    if (challenge.exp <= now()) return "Challenge expired.";
    if (redeemed.has(challenge.id)) return "Challenge already redeemed.";
    if (controlHash(challenge.id, proof.controlAnswer) !== challenge.controlHash) {
      // Burn the challenge so the control answer can't be guessed by retrying.
      redeem(challenge);
      return "Wrong control answer.";
    }

    const response = proof.response.trim();
    if (response.length < challenge.minChars) return `Response shorter than ${challenge.minChars} characters.`;
    if (response.length > challenge.maxChars) return `Response longer than ${challenge.maxChars} characters.`;

    const work: Work = { challengeId: challenge.id, prompt: challenge.prompt, response, resource };
    const verdict = verify ? await verify(work) : true;
    if (verdict !== true) return typeof verdict === "string" ? verdict : "Response rejected by verifier.";

    redeem(challenge);
    return work;
  }

  return async function workGateMiddleware(req: IncomingMessage, res: ServerResponse, next: Next) {
    try {
      const path = (req.url ?? "/").split("?")[0];
      const passes = req.headers[PASS_HEADER.toLowerCase()];
      for (const pass of typeof passes === "string" ? passes.split(",") : []) {
        const payload = verifyToken<PassPayload>(pass.trim(), secret);
        if (payload?.typ === "pass" && payload.exp > now() && (!payload.path || payload.path === path)) return next();
      }

      let error: string | undefined;
      const proof = req.headers[WORK_HEADER.toLowerCase()];
      if (typeof proof === "string") {
        const result = await checkProof(proof, req.url ?? "/");
        if (typeof result !== "string") {
          await onWork?.(result);
          if (passTtlSeconds > 0) {
            const passPayload: PassPayload = { typ: "pass", sub: result.challengeId, exp: now() + passTtlSeconds };
            if (passScope === "resource") passPayload.path = path;
            res.setHeader(PASS_HEADER, signToken(passPayload, secret));
          }
          return next();
        }
        error = result;
      }

      const id = randomUUID();
      const { question, answer } = await control(req);
      const challenge: ChallengePayload = {
        typ: "challenge",
        id,
        prompt: typeof prompt === "function" ? await prompt(req) : prompt,
        control: question,
        controlHash: controlHash(id, answer),
        minChars,
        maxChars,
        exp: now() + challengeTtlSeconds,
      };
      const body: WorkRequired = {
        protocol: PROTOCOL,
        id,
        prompt: challenge.prompt,
        control: question,
        challenge: signToken(challenge, secret),
        minChars,
        maxChars,
        expiresAt: challenge.exp,
        ...(error && { error }),
        instructions:
          `Access requires work. Answer "prompt" with an LLM (${minChars}-${maxChars} characters) and answer ` +
          `"control", then retry the same request with header ` +
          `${WORK_HEADER}: base64url(JSON.stringify({ challenge, response, controlAnswer })). ` +
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

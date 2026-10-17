import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { withWork } from "../src/client.ts";
import { PASS_HEADER, WORK_HEADER, encodeProof, signToken, workGate, type Work } from "../src/server.ts";

const secret = "test-secret";
const answer = "I am a test agent. I read websites, summarize articles, and pay for access with compute.";
const accepted: Work[] = [];
let base: string;
let close: () => void;

before(async () => {
  const app = express();
  app.use(workGate({ secret, onWork: (work) => void accepted.push(work) }));
  app.get("/secret", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

// Solves the default control question ("What is a + b? ...") the way an honest agent would.
const add = (question: string) => {
  const [, a, b] = question.match(/What is (\d+) \+ (\d+)\?/)!;
  return String(Number(a) + Number(b));
};

async function challenge() {
  const res = await fetch(`${base}/secret`);
  assert.equal(res.status, 402);
  const body = await res.json();
  return { ...body, controlAnswer: add(body.control) };
}

const withProof = (challenge: string, response: string, controlAnswer: string) =>
  fetch(`${base}/secret`, { headers: { [WORK_HEADER]: encodeProof({ challenge, response, controlAnswer }) } });

test("blocks requests without work and asks for the LLM request", async () => {
  const body = await challenge();
  assert.equal(body.protocol, "agent-proof-of-work/0.2");
  assert.equal(body.prompt, "Tell me about yourself.");
  assert.match(body.control, /^What is [1-9] \+ [1-9]\? Reply with only the number\.$/);
  // The token must not leak the control answer.
  assert.doesNotMatch(Buffer.from(body.challenge.split(".")[0], "base64url").toString(), /"answer"/);
});

test("client solves the challenge once, then reuses its pass", async () => {
  const prompts: string[] = [];
  const workFetch = withWork(async (prompt, { control }) => {
    prompts.push(prompt);
    return prompt === control ? add(control) : answer;
  });

  const first = await workFetch(`${base}/secret`);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });
  assert.equal(accepted.at(-1)?.response, answer);
  assert.equal(accepted.at(-1)?.resource, "/secret");

  const second = await workFetch(`${base}/secret`);
  assert.equal(second.status, 200);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], "Tell me about yourself.");
});

test("client retries with a fresh challenge after a wrong control answer", async () => {
  let controlAttempts = 0;
  const workFetch = withWork(async (prompt, { control }) => {
    if (prompt !== control) return answer;
    return ++controlAttempts === 1 ? "I don't know" : add(control);
  });
  assert.equal((await workFetch(`${base}/secret`)).status, 200);
  assert.equal(controlAttempts, 2);
});

test("a proof cannot be redeemed twice", async () => {
  const { challenge: token, controlAnswer } = await challenge();
  assert.equal((await withProof(token, answer, controlAnswer)).status, 200);
  const replay = await withProof(token, answer, controlAnswer);
  assert.equal(replay.status, 402);
  assert.equal((await replay.json()).error, "Challenge already redeemed.");
});

test("a wrong control answer is rejected and burns the challenge", async () => {
  const { challenge: token, controlAnswer } = await challenge();
  const wrong = String(Number(controlAnswer) + 1);
  const res = await withProof(token, answer, wrong);
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, "Wrong control answer.");
  const retry = await withProof(token, answer, controlAnswer);
  assert.equal((await retry.json()).error, "Challenge already redeemed.");
});

test("accepts a control answer phrased as a sentence", async () => {
  const { challenge: token, controlAnswer } = await challenge();
  assert.equal((await withProof(token, answer, `The answer is ${controlAnswer}.`)).status, 200);
});

test("rejects tampered, expired, and low-effort proofs", async () => {
  const { challenge: token, controlAnswer } = await challenge();
  const [payload] = token.split(".");
  const original = JSON.parse(Buffer.from(payload, "base64url").toString());

  const easier = { ...original, minChars: 0 };
  const tampered = `${Buffer.from(JSON.stringify(easier)).toString("base64url")}.${token.split(".")[1]}`;
  const expired = signToken({ ...original, exp: Math.floor(Date.now() / 1000) - 1 }, secret);

  const cases: [string, string, string][] = [
    [tampered, "ok", "Invalid challenge signature."],
    [expired, answer, "Challenge expired."],
    [token, "Sure!", "Response shorter than 50 characters."],
    [token, "x".repeat(4001), "Response longer than 4000 characters."],
  ];
  for (const [challengeToken, response, error] of cases) {
    const res = await withProof(challengeToken, response, controlAnswer);
    assert.equal(res.status, 402, error);
    assert.equal((await res.json()).error, error);
  }
  // None of the rejections consumed the challenge.
  assert.equal((await withProof(token, answer, controlAnswer)).status, 200);
});

test("rejects forged and expired passes", async () => {
  const forged = signToken({ typ: "pass", sub: "x", exp: 9999999999 }, "wrong-secret");
  const expired = signToken({ typ: "pass", sub: "x", exp: 1 }, secret);
  const challengeAsPass = (await challenge()).challenge;
  for (const pass of [forged, expired, challengeAsPass]) {
    const res = await fetch(`${base}/secret`, { headers: { [PASS_HEADER]: pass } });
    assert.equal(res.status, 402);
  }
});

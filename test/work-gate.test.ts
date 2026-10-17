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

async function challenge() {
  const res = await fetch(`${base}/secret`);
  assert.equal(res.status, 402);
  return res.json();
}

const withProof = (challenge: string, response: string) =>
  fetch(`${base}/secret`, { headers: { [WORK_HEADER]: encodeProof({ challenge, response }) } });

test("blocks requests without work and asks for the LLM request", async () => {
  const body = await challenge();
  assert.equal(body.protocol, "agent-proof-of-work/0.1");
  assert.equal(body.prompt, "Tell me about yourself.");
});

test("client solves the challenge once, then reuses its pass", async () => {
  const prompts: string[] = [];
  const workFetch = withWork(async (prompt) => {
    prompts.push(prompt);
    return answer;
  });

  const first = await workFetch(`${base}/secret`);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });
  assert.equal(accepted.at(-1)?.response, answer);
  assert.equal(accepted.at(-1)?.resource, "/secret");

  const second = await workFetch(`${base}/secret`);
  assert.equal(second.status, 200);
  assert.deepEqual(prompts, ["Tell me about yourself."]);
});

test("a proof cannot be redeemed twice", async () => {
  const { challenge: token } = await challenge();
  assert.equal((await withProof(token, answer)).status, 200);
  const replay = await withProof(token, answer);
  assert.equal(replay.status, 402);
  assert.equal((await replay.json()).error, "Challenge already redeemed.");
});

test("rejects tampered, expired, and low-effort proofs", async () => {
  const { challenge: token } = await challenge();
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
    const res = await withProof(challengeToken, response);
    assert.equal(res.status, 402, error);
    assert.equal((await res.json()).error, error);
  }
  // None of the rejections consumed the challenge.
  assert.equal((await withProof(token, answer)).status, 200);
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

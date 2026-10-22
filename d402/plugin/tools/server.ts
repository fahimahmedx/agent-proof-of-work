#!/usr/bin/env node
// D402 local tool server: a stdio MCP server exposing open, submit, resume, and fallback.
// It keeps the cookie jar, challenge, attempt, and grant capabilities in memory, so none of them ever enter the
// model's context or the labeler's prompt. Requests only go to allowlisted website origins.
import { createInterface } from "node:readline";

const PROTOCOL = "d402-v0";
const GRANT_HEADER = "D402-Grant";
const MAX_PAGE_CHARS = 100_000;
const allowedOrigins = new Set(
  (process.env.D402_ALLOWED_ORIGINS || "http://localhost:4020")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s).origin),
);
const deadlineMs = Number(process.env.D402_WORKER_DEADLINE_MS || 120_000);

interface Challenge {
  url: URL;
  token: string;
  claimUrl: URL;
  fallbackUrl: URL;
  attemptId?: string;
  attemptToken?: string;
  submitUrl?: URL;
  taskIssuedAt?: number;
  grant?: { token: string; accessReason: string; detail?: string };
}

const cookies = new Map<string, Map<string, string>>(); // origin -> name -> value
const challenges = new Map<string, Challenge>();

class ToolError extends Error {}

function sameOrigin(base: URL, target: string) {
  const url = new URL(target, base);
  if (url.origin !== base.origin) throw new ToolError(`Refusing cross-origin D402 URL ${url.origin}.`);
  return url;
}

/** Fetch with this origin's cookies. Only same-origin redirects are followed, so credentials never leave the site. */
async function request(url: URL, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  for (let hops = 0; hops < 5; hops++) {
    if (!allowedOrigins.has(url.origin)) throw new ToolError(`Origin ${url.origin} is not in D402_ALLOWED_ORIGINS.`);
    const jar = cookies.get(url.origin) ?? new Map<string, string>();
    cookies.set(url.origin, jar);
    const headers: Record<string, string> = { Accept: "application/json, text/html;q=0.9, */*;q=0.8", ...init.headers };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      if (next.origin !== url.origin) throw new ToolError(`Not following cross-origin redirect to ${next.origin}.`);
      url = next;
      continue;
    }
    return res;
  }
  throw new ToolError("Too many redirects.");
}

async function postJson(url: URL, body: unknown) {
  const res = await request(url, { method: "POST", body });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new ToolError(`${url.pathname} returned HTTP ${res.status}: ${data?.error ?? "no body"}`);
  return data;
}

async function page(res: Response, grant?: Challenge["grant"]) {
  const content = await res.text();
  return {
    status: res.ok ? "page" : "blocked",
    http_status: res.status,
    access: res.headers.get("d402-access") ?? grant?.accessReason ?? null,
    ...(grant?.detail && { access_detail: grant.detail }),
    content: content.length > MAX_PAGE_CHARS ? `${content.slice(0, MAX_PAGE_CHARS)}\n[truncated]` : content,
  };
}

function challengeById(id: unknown) {
  const challenge = challenges.get(String(id));
  if (!challenge) throw new ToolError(`Unknown challenge_id ${id}. Call open first.`);
  return challenge;
}

function keepGrant(challenge: Challenge, data: any) {
  if (data?.status !== "granted") throw new ToolError("Coordinator did not return a grant.");
  challenge.grant = { token: data.grant_token, accessReason: data.access_reason, detail: data.detail };
  return { access_reason: data.access_reason, ...(data.detail && { detail: data.detail }), ...(data.errors && { errors: data.errors }) };
}

const tools = {
  async open({ url }: { url: string }) {
    const target = new URL(url);
    const res = await request(target);
    if (res.status !== 402) return page(res);
    const body = await res.json().catch(() => null);
    if (body?.protocol !== PROTOCOL) return { status: "blocked", http_status: 402, content: "402 without a D402 challenge." };

    const challenge: Challenge = {
      url: target,
      token: body.challenge_token,
      claimUrl: sameOrigin(target, body.claim_url),
      fallbackUrl: sameOrigin(target, body.fallback_url),
    };
    challenges.set(body.challenge_id, challenge);
    let claim: any;
    try {
      claim = await postJson(challenge.claimUrl, { challenge_token: challenge.token });
    } catch (err) {
      // Service failure: take the free-access path and return the page without a task.
      await tools.fallback({ challenge_id: body.challenge_id, reason: `claim_failed: ${(err as Error).message}` }).catch(() => {});
      return tools.resume({ challenge_id: body.challenge_id });
    }
    if (claim.status === "granted") {
      // No task or no sponsorship: the coordinator already granted free access.
      keepGrant(challenge, claim);
      return tools.resume({ challenge_id: body.challenge_id });
    }
    challenge.attemptId = claim.attempt_id;
    challenge.attemptToken = claim.attempt_token;
    challenge.submitUrl = sameOrigin(target, claim.submit_url);
    challenge.taskIssuedAt = Date.now();
    return {
      status: "task",
      challenge_id: body.challenge_id,
      attempt_id: claim.attempt_id,
      deadline_seconds: Math.round(deadlineMs / 1000),
      task: claim.task,
    };
  },

  async submit({ attempt_id, labels }: { attempt_id: string; labels: unknown }) {
    const entry = [...challenges].find(([, c]) => c.attemptId === attempt_id);
    if (!entry) throw new ToolError(`Unknown attempt_id ${attempt_id}.`);
    const [challengeId, challenge] = entry;
    if (Date.now() - challenge.taskIssuedAt! > deadlineMs) {
      const result = await tools.fallback({ challenge_id: challengeId, reason: "worker_timeout" });
      return { ...result, note: "Labels arrived after the worker deadline; access falls back to free." };
    }
    // Accept the labeler's raw output: an array, {labels: [...]}, or a JSON string of either.
    let parsed: any = labels;
    if (typeof parsed === "string") {
      const json = parsed.match(/[[{][\s\S]*[\]}]/)?.[0];
      try {
        parsed = JSON.parse(json ?? parsed);
      } catch {}
    }
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.labels)) parsed = parsed.labels;
    const data = await postJson(challenge.submitUrl!, { attempt_token: challenge.attemptToken, attempt_id, labels: parsed });
    return { status: "submitted", challenge_id: challengeId, ...keepGrant(challenge, data) };
  },

  async resume({ challenge_id }: { challenge_id: string }) {
    const challenge = challengeById(challenge_id);
    const headers: Record<string, string> = challenge.grant ? { [GRANT_HEADER]: challenge.grant.token } : {};
    return page(await request(challenge.url, { headers }), challenge.grant);
  },

  async fallback({ challenge_id, reason }: { challenge_id: string; reason?: string }) {
    const challenge = challengeById(challenge_id);
    const data = await postJson(challenge.fallbackUrl, { challenge_token: challenge.token, reason: reason ?? "unspecified" });
    return { status: "fallback", challenge_id, ...keepGrant(challenge, data) };
  },
};

const definitions = [
  {
    name: "open",
    description:
      "GET a D402-protected URL. Returns {status:'page', content} when access is granted, or {status:'task', " +
      "challenge_id, attempt_id, task} when a trace-labeling task must be done first.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "submit",
    description:
      "Submit the labeler's labels for an attempt. `labels` is the labeler's JSON output (array of " +
      "{trace_id, needs_review, reason}, or {labels:[...]}). Stores the access grant; call resume next.",
    inputSchema: {
      type: "object",
      properties: { attempt_id: { type: "string" }, labels: { description: "Labels array or the labeler's raw JSON text." } },
      required: ["attempt_id", "labels"],
    },
  },
  {
    name: "resume",
    description: "Retry the original page request with the stored access grant and return the page.",
    inputSchema: { type: "object", properties: { challenge_id: { type: "string" } }, required: ["challenge_id"] },
  },
  {
    name: "fallback",
    description:
      "Request free access when the labeling worker fails, times out, returns unusable output, or is denied. " +
      "Call resume afterwards.",
    inputSchema: {
      type: "object",
      properties: { challenge_id: { type: "string" }, reason: { type: "string" } },
      required: ["challenge_id", "reason"],
    },
  },
];

// ---- MCP stdio transport (newline-delimited JSON-RPC 2.0) -------------------------------------------------------

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (msg.id === undefined) return; // notification
  try {
    switch (msg.method) {
      case "initialize":
        return send({
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "d402", version: "0.1.0" },
          },
        });
      case "ping":
        return send({ id: msg.id, result: {} });
      case "tools/list":
        return send({ id: msg.id, result: { tools: definitions } });
      case "tools/call": {
        const tool = tools[msg.params?.name as keyof typeof tools];
        if (!tool) return send({ id: msg.id, error: { code: -32602, message: `Unknown tool ${msg.params?.name}` } });
        try {
          const result = await tool((msg.params.arguments ?? {}) as any);
          return send({ id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
        } catch (err) {
          return send({ id: msg.id, result: { content: [{ type: "text", text: (err as Error).message }], isError: true } });
        }
      }
      default:
        return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (err) {
    send({ id: msg.id, error: { code: -32603, message: (err as Error).message } });
  }
});

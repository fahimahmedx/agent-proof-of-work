import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { connectToolServer } from "../d402/mcp-client.ts";
import { FIXTURES_DIR, fixtureTasks, startD402, type StartOptions } from "../d402/server/main.ts";

let clock = 1_800_000_000;
const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
});

async function setup(options: StartOptions & { tasks?: number } = {}) {
  const d402 = await startD402({ now: () => clock, ...options });
  running.push(d402);
  const tasks = fixtureTasks(d402.sandboxUrl).slice(0, options.tasks ?? 3);
  if (tasks.length) d402.coordinator.enqueue(d402.lab, tasks);
  const labApi = (path: string, init: RequestInit = {}) =>
    fetch(`${d402.siteUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${d402.lab.apiKey}`, "Content-Type": "application/json" } });
  return { ...d402, labApi, ledger: () => d402.coordinator.snapshot() };
}

/** One visiting agent speaking the D402 HTTP protocol directly, with its own session cookie. */
async function visitor(siteUrl: string) {
  let cookie = "";
  const send = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${siteUrl}${path}`, {
      ...init,
      headers: { ...(cookie && { Cookie: cookie }), "Content-Type": "application/json", ...(init.headers as object) },
    });
    const set = res.headers.getSetCookie()[0];
    if (set) cookie = set.split(";")[0];
    return res;
  };
  const post = async (path: string, body: object) => (await send(path, { method: "POST", body: JSON.stringify(body) })).json();
  const challenge = await (await send("/article")).json();
  return {
    challenge,
    claim: () => post("/d402/claim", { challenge_token: challenge.challenge_token }),
    submit: (claim: any, labels: unknown) => post(claim.submit_url, { attempt_token: claim.attempt_token, labels }),
    fallback: (reason: string) => post("/d402/fallback", { challenge_token: challenge.challenge_token, reason }),
    page: (grant?: string) => send("/article", { headers: grant ? { "D402-Grant": grant } : {} }),
    post,
  };
}

const labelsFor = (claim: any, needsReview = false) =>
  claim.task.traces.map((t: any) => ({ trace_id: t.trace_id, needs_review: needsReview, reason: "ok" }));

test("normal path through the plugin tool server: one sponsored charge, labels exported to the lab", async () => {
  const d402 = await setup();
  const plugin = await connectToolServer({ D402_ALLOWED_ORIGINS: d402.siteUrl });
  try {
    const opened = await plugin.call("open", { url: `${d402.siteUrl}/article` });
    assert.equal(opened.status, "task");
    assert.equal(opened.task.task_id, "batch-001");
    // Capabilities stay inside the tool server; the model only sees IDs and the task.
    assert.doesNotMatch(JSON.stringify(opened), /token/);

    const labels = opened.task.traces.map((t: any) => ({ trace_id: t.trace_id, needs_review: t.trace_id === "trace_b", reason: "r" }));
    const submitted = await plugin.call("submit", { attempt_id: opened.attempt_id, labels: `Here you go:\n${JSON.stringify({ labels })}` });
    assert.equal(submitted.access_reason, "sponsored");
    for (let i = 0; i < 3; i++) {
      const page = await plugin.call("resume", { challenge_id: opened.challenge_id });
      assert.equal(page.http_status, 200);
      assert.equal(page.access, "sponsored");
      assert.match(page.content, /Labeling for access/);
    }

    const ledger = d402.ledger();
    assert.deepEqual(ledger.accessEvents.map((e) => [e.reason, e.amount_cents, e.payment_reference]), [["sponsored", 25, "INV-PILOT-0001"]]);
    assert.equal(ledger.sponsorships[0].remaining_units, 99);

    const exported = await (await d402.labApi("/lab/attempts?after=0")).json();
    assert.equal(exported.attempts.length, 1);
    assert.equal(exported.attempts[0].attempt_id, opened.attempt_id);
    assert.equal(exported.attempts[0].external_id, "batch-001");
    assert.deepEqual(exported.attempts[0].labels, labels);
    assert.deepEqual((await (await d402.labApi("/lab/attempts?after=0")).json()).attempts, exported.attempts);
    assert.deepEqual((await (await d402.labApi(`/lab/attempts?after=${exported.next_cursor}`)).json()).attempts, []);
  } finally {
    plugin.close();
  }
});

test("wrong but schema-valid labels unlock; malformed labels grant free access and requeue the task", async () => {
  const d402 = await setup({ tasks: 1 });
  const bad = await visitor(d402.siteUrl);
  const claim = await bad.claim();
  const result = await bad.submit(claim, [...labelsFor(claim).slice(1), { trace_id: "trace_zz", needs_review: "yes", reason: "x" }]);
  assert.equal(result.access_reason, "free");
  assert.equal(result.detail, "invalid_labels");
  assert.ok(result.errors.some((e: string) => e.includes("missing label for trace_a")));
  assert.ok(result.errors.some((e: string) => e.includes("unknown trace_id")));
  assert.equal((await bad.page(result.grant_token)).headers.get("d402-access"), "free");
  assert.equal(d402.ledger().tasks[0].status, "queued");

  const wrong = await visitor(d402.siteUrl);
  const claim2 = await wrong.claim();
  assert.equal(claim2.task.task_id, "batch-001");
  const ok = await wrong.submit(claim2, labelsFor(claim2, true)); // every label wrong, still schema-valid
  assert.equal(ok.access_reason, "sponsored");
  await wrong.page(ok.grant_token);
  const events = d402.ledger().accessEvents;
  assert.deepEqual(events.map((e) => e.amount_cents).sort(), [0, 25]);
});

test("availability: empty queue, missing sponsorship, lab outage, and coordinator outage all return the page", async () => {
  const empty = await setup({ tasks: 0 });
  const v1 = await visitor(empty.siteUrl);
  const r1 = await v1.claim();
  assert.deepEqual([r1.access_reason, r1.detail], ["free", "no_task"]);
  assert.equal((await v1.page(r1.grant_token)).status, 200);

  const unsponsored = await setup({ sponsorship: null });
  const r2 = await (await visitor(unsponsored.siteUrl)).claim();
  assert.deepEqual([r2.access_reason, r2.detail], ["free", "no_sponsorship"]);
  assert.equal(unsponsored.ledger().tasks[0].status, "queued");

  const outage = await setup({ tasks: 1 });
  outage.sandbox.state.down = true;
  const r3 = await (await visitor(outage.siteUrl)).claim();
  assert.deepEqual([r3.access_reason, r3.detail], ["free", "sandbox_unavailable"]);
  const snap = outage.ledger();
  assert.equal(snap.tasks[0].status, "queued");
  assert.equal(snap.sponsorships[0].reserved_units, 0);
  assert.match(snap.attempts[0].error, /sandbox_unavailable: sandbox returned HTTP 503/);

  const down = await setup({ tasks: 0 });
  down.coordinator.db.close();
  const res = await fetch(`${down.siteUrl}/article`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("d402-access"), "free");
});

test("expired or forged grants still get the page for free and are recorded", async () => {
  const d402 = await setup({ tasks: 1 });
  const v = await visitor(d402.siteUrl);
  const claim = await v.claim();
  const { grant_token } = await v.submit(claim, labelsFor(claim));
  clock += 601;
  assert.equal((await v.page(grant_token)).headers.get("d402-access"), "free");
  assert.equal((await v.page("gr_forged.abc")).headers.get("d402-access"), "free");
  const snap = d402.ledger();
  assert.deepEqual(snap.accessEvents.map((e) => e.reason).sort(), ["free:grant_expired", "free:unknown_grant"]);
  // The expired, never-redeemed sponsored grant gives back its reserved unit.
  assert.deepEqual([snap.sponsorships[0].remaining_units, snap.sponsorships[0].reserved_units], [100, 0]);
});

test("retries and concurrency: stable claims and submissions, one lease per task, one unit per page", async () => {
  const d402 = await setup({ tasks: 1, sponsorship: { paymentReference: "P", unitPriceCents: 10, units: 1 } });
  const a = await visitor(d402.siteUrl);
  const b = await visitor(d402.siteUrl);
  const [claimA, claimB] = await Promise.all([a.claim(), b.claim()]);
  assert.equal(claimA.status, "task");
  assert.deepEqual([claimB.status, claimB.detail], ["granted", "no_task"]);

  const replay = await a.claim();
  assert.equal(replay.attempt_id, claimA.attempt_id);
  assert.equal(replay.attempt_token, claimA.attempt_token);

  const first = await a.submit(claimA, labelsFor(claimA, true));
  const conflicting = await a.submit(claimA, labelsFor(claimA, false));
  assert.equal(conflicting.grant_token, first.grant_token);
  assert.equal((await a.claim()).grant_token, first.grant_token);

  // A capability from another session is refused.
  assert.equal((await b.post(claimA.submit_url, { attempt_token: claimA.attempt_token, labels: [] })).error, "Unknown attempt or capability.");
  assert.equal((await b.post("/d402/claim", { challenge_token: a.challenge.challenge_token })).error?.includes("another session"), true);

  await Promise.all([a.page(first.grant_token), a.page(first.grant_token), a.page(first.grant_token)]);
  const snap = d402.ledger();
  assert.deepEqual(snap.accessEvents.map((e) => e.amount_cents), [10]);
  assert.equal(snap.sponsorships[0].remaining_units, 0);
  const exported = await (await d402.labApi("/lab/attempts")).json();
  assert.equal(exported.attempts[0].labels[0].needs_review, true); // the first labels were kept
});

test("recovery: expired leases requeue the task, late labels are ignored, fallback releases the reservation", async () => {
  const d402 = await setup({ tasks: 1 });
  const slow = await visitor(d402.siteUrl);
  const claim = await slow.claim();
  clock += 181;
  const fast = await visitor(d402.siteUrl);
  const reassigned = await fast.claim();
  assert.equal(reassigned.task.task_id, "batch-001");
  assert.notEqual(reassigned.attempt_id, claim.attempt_id);

  const late = await slow.submit(claim, labelsFor(claim));
  assert.deepEqual([late.access_reason, late.detail], ["free", "late_submission"]);

  const fb = await fast.fallback("worker_crashed");
  assert.deepEqual([fb.access_reason, fb.detail], ["free", "fallback:worker_crashed"]);
  const afterFallback = await fast.submit(reassigned, labelsFor(reassigned));
  assert.equal(afterFallback.grant_token, fb.grant_token);

  const snap = d402.ledger();
  assert.deepEqual(snap.attempts.map((x) => x.status).sort(), ["abandoned", "failed"]);
  assert.equal(snap.tasks[0].status, "queued");
  assert.equal(snap.sponsorships[0].reserved_units, 0);
  const exported = await (await d402.labApi("/lab/attempts")).json();
  assert.deepEqual(exported.attempts.map((x: any) => x.status), ["abandoned", "failed"]);
});

test("a task whose payload changes mid-attempt, or exceeds the limits, is not used", async () => {
  const dir = mkdtempSync(join(tmpdir(), "d402-"));
  cpSync(FIXTURES_DIR, dir, { recursive: true });
  const d402 = await setup({ tasks: 0, sandboxDir: dir });
  const big = JSON.parse(readFileSync(join(dir, "batch-001.json"), "utf8"));
  big.traces.push({ trace_id: "trace_extra", messages: [] });
  writeFileSync(join(dir, "big.json"), JSON.stringify(big));
  d402.coordinator.enqueue(d402.lab, [{ external_id: "big", payload_ref: `${d402.sandboxUrl}/tasks/big.json`, rubric_version: "review-v1" }]);
  const r = await (await visitor(d402.siteUrl)).claim();
  assert.deepEqual([r.access_reason, r.detail], ["free", "task_skipped"]);
  assert.equal(d402.ledger().tasks[0].status, "skipped");

  d402.coordinator.enqueue(d402.lab, fixtureTasks(d402.sandboxUrl).slice(1, 2));
  const v = await visitor(d402.siteUrl);
  assert.equal((await v.claim()).status, "task");
  writeFileSync(join(dir, "batch-002.json"), JSON.stringify({ ...big, task_id: "changed", traces: big.traces.slice(0, 1) }));
  const replay = await v.claim();
  assert.deepEqual([replay.access_reason, replay.detail], ["free", "sandbox_unavailable"]);
});

test("lab API authenticates, deduplicates by external ID, and only accepts sandbox URLs", async () => {
  const d402 = await setup({ tasks: 0 });
  const tasks = fixtureTasks(d402.sandboxUrl).slice(0, 1);
  assert.equal((await fetch(`${d402.siteUrl}/lab/attempts`, { headers: { Authorization: "Bearer nope" } })).status, 401);
  const first = await (await d402.labApi("/lab/tasks", { method: "POST", body: JSON.stringify({ tasks }) })).json();
  const again = await (await d402.labApi("/lab/tasks", { method: "POST", body: JSON.stringify({ tasks }) })).json();
  assert.equal(first.tasks[0].created, true);
  assert.equal(again.tasks[0].created, false);
  assert.equal(again.tasks[0].task_id, first.tasks[0].task_id);
  for (const payload_ref of ["https://evil.example/tasks/x.json", `${d402.sandboxUrl}/admin/x.json`]) {
    const res = await d402.labApi("/lab/tasks", { method: "POST", body: JSON.stringify({ tasks: [{ ...tasks[0], external_id: "x", payload_ref }] }) });
    assert.equal(res.status, 400);
  }
});

test("the plugin tool server refuses origins outside its allowlist", async () => {
  const plugin = await connectToolServer({ D402_ALLOWED_ORIGINS: "http://localhost:1" });
  try {
    await assert.rejects(plugin.call("open", { url: "http://example.com/article" }), /not in D402_ALLOWED_ORIGINS/);
  } finally {
    plugin.close();
  }
});

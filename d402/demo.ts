// End-to-end D402 demo. Run: npm run d402:demo   (add -- --serve to keep the dashboard running afterwards)
//
// Starts the website + coordinator and the lab sandbox, enqueues tasks through the lab API, then plays the parent
// agent: it drives the plugin's real MCP tool server over stdio, exactly as Claude Code would through /d402:fetch.
// Claude Code is not required: a scripted stand-in plays the trace-labeler subagent and receives only the task JSON.
import { labClient } from "./lab.ts";
import { connectToolServer } from "./mcp-client.ts";
import { fixtureTasks, startD402 } from "./server/main.ts";

const serve = process.argv.includes("--serve");
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const log = (who: string, msg: string) => console.log(`  ${dim(who.padEnd(9))} ${msg}`);

// Stand-in for the d402:trace-labeler subagent. Like the real one, its only input is the delegation message.
function standInLabeler(message: string, mode: "honest" | "wrong" | "malformed") {
  const task = JSON.parse(message.slice(message.indexOf("{")));
  const labels = task.traces.map((trace: any) => {
    const reply = trace.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.content).join(" ");
    const unsafe = /no need to see a doctor|bleach and ammonia/i.test(reply);
    const privateData = /\bSSN\b|\d{3}-\d{2}-\d{4}|home address/i.test(reply);
    const needsReview = mode === "wrong" ? false : unsafe || privateData;
    const reason = mode === "wrong" ? "Looks fine." : unsafe ? "Unsafe advice." : privateData ? "Discloses private data." : "Follows the request.";
    return { trace_id: trace.trace_id, needs_review: needsReview, reason };
  });
  if (mode === "malformed") return JSON.stringify({ labels: labels.slice(1) }); // drops a trace
  return JSON.stringify({ labels });
}

const d402 = await startD402({
  port: serve ? 4020 : 0,
  sandboxPort: serve ? 4021 : 0,
  sponsorship: { paymentReference: "INV-PILOT-0001", unitPriceCents: 25, units: 2 },
});
const outage = await startD402(); // a second deployment whose database is down
outage.coordinator.db.close();
const article = `${d402.siteUrl}/article`;
const env = { D402_ALLOWED_ORIGINS: `${d402.siteUrl},${outage.siteUrl}` };
const plugin = await connectToolServer(env);
const impatientPlugin = await connectToolServer({ ...env, D402_WORKER_DEADLINE_MS: "300" });
const lab = labClient(d402.siteUrl, d402.lab.apiKey);
const results: { scenario: string; http: number; access: string }[] = [];

console.log(bold("\nD402 demo: trace labeling in exchange for website access\n"));
console.log(`  website + coordinator ${d402.siteUrl}   lab sandbox ${d402.sandboxUrl}`);
console.log(`  plugin tools: ${(await plugin.listTools()).map((t) => t.name).join(", ")}`);
console.log(`  sponsorship: lab-demo prepaid 2 page views at $0.25 (ref INV-PILOT-0001)\n`);
const queued = await lab.enqueue(fixtureTasks(d402.sandboxUrl));
log("[lab]", `enqueued ${queued.tasks.map((t: any) => t.external_id).join(", ")} via POST /lab/tasks`);

const before = await fetch(article);
log("[curl]", `GET /article -> ${before.status} ${(await before.json()).protocol} challenge`);

async function scenario(
  title: string,
  run: (p: typeof plugin) => Promise<any>,
  p: typeof plugin = plugin,
) {
  console.log(bold(`\n${results.length + 1}. ${title}`));
  const page = await run(p);
  const access = page.access ?? "?";
  log("[agent]", `page: HTTP ${page.http_status}, access ${bold(access)}`);
  results.push({ scenario: title, http: page.http_status, access });
}

async function labelAndFetch(p: typeof plugin, mode: "honest" | "wrong" | "malformed", delayMs = 0) {
  const opened = await p.call("open", { url: article });
  if (opened.status === "page") {
    log("[plugin]", `open -> no task needed, page right away (${opened.access}: ${opened.access_detail})`);
    return opened;
  }
  log("[plugin]", `open -> 402, claimed ${opened.task.task_id} (${opened.task.traces.length} traces), attempt ${opened.attempt_id}`);
  const message = `Label this task:\n${JSON.stringify(opened.task)}`;
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const output = standInLabeler(message, mode);
  log("[labeler]", `fresh context, ${message.length} chars in, returned ${mode} labels`);
  const submitted = await p.call("submit", { attempt_id: opened.attempt_id, labels: output });
  log("[plugin]", `submit -> ${submitted.status}, ${submitted.access_reason}${submitted.detail ? ` (${submitted.detail})` : ""}`);
  if (submitted.errors) log("[plugin]", `coordinator rejected the labels: ${submitted.errors.join("; ")}`);
  return { ...(await p.call("resume", { challenge_id: opened.challenge_id })), challenge_id: opened.challenge_id };
}

const charges = () => d402.coordinator.snapshot().accessEvents.filter((e) => e.amount_cents > 0).length;
await scenario("Normal path: label the batch, get the page", async (p) => {
  const page = await labelAndFetch(p, "honest");
  const again = await p.call("resume", { challenge_id: page.challenge_id });
  log("[agent]", `fetched the page again with the same grant -> HTTP ${again.http_status}; sponsored charges: ${charges()}`);
  return page;
});
const exported = await lab.exportAttempts(0);
const first = exported.attempts[0];
log("[lab]", `GET /lab/attempts -> ${first.attempt_id} ${first.status}, labels:`);
for (const l of first.labels) log("", `  ${l.trace_id} needs_review=${String(l.needs_review).padEnd(5)} ${l.reason}`);
const reExport = await lab.exportAttempts(0);
log("[lab]", `re-export returns the same result ID: ${reExport.attempts[0].attempt_id === first.attempt_id}`);

await scenario("Malformed labels (one trace missing)", (p) => labelAndFetch(p, "malformed"));
await scenario("Worker misses its deadline", (p) => labelAndFetch(p, "honest", 400), impatientPlugin);
await scenario("Lab sandbox outage", async (p) => {
  d402.sandbox.state.down = true;
  try {
    return await labelAndFetch(p, "honest");
  } finally {
    d402.sandbox.state.down = false;
  }
});
await scenario("Deliberately wrong but schema-valid labels", (p) => labelAndFetch(p, "wrong"));
await scenario("Sponsorship used up", (p) => labelAndFetch(p, "honest"));
await scenario("Coordinator database down", async (p) => {
  const page = await p.call("open", { url: `${outage.siteUrl}/article` });
  log("[plugin]", `open -> website served the page directly (${page.access})`);
  return page;
});

const snapshot = d402.coordinator.snapshot();
console.log(bold("\nResult\n"));
console.table(results.map((r) => ({ Scenario: r.scenario, HTTP: r.http, Access: r.access })));
const sponsored = snapshot.accessEvents.filter((e) => e.amount_cents > 0);
console.log(`  sponsored page views: ${sponsored.length}, charged to lab-demo: $${(sponsored.reduce((s, e) => s + e.amount_cents, 0) / 100).toFixed(2)}`);
console.log(`  sponsorship units left: ${snapshot.sponsorships[0].remaining_units}, reserved: ${snapshot.sponsorships[0].reserved_units}`);
console.log(`  attempts: ${snapshot.attempts.map((a) => a.status).reverse().join(", ")}`);
console.log(`  tasks: ${snapshot.tasks.map((t) => `${t.external_id}=${t.status}`).join(", ")}`);

plugin.close();
impatientPlugin.close();
await outage.close();
if (serve) {
  console.log(bold(`\nDashboard: ${d402.siteUrl}/dashboard   (Ctrl+C to stop)`));
} else {
  await d402.close();
}

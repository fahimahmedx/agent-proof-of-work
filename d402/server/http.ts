// One Express app for the demo: the website adapter (GET /article), the D402 coordinator API (/d402/*),
// the eval lab API (/lab/*), and an operator dashboard. The website adapter only talks to the coordinator through
// createChallenge, redeemGrant, and recordFreeAccess, so it can move into another application later.
import { randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { CHALLENGE_TTL, Coordinator, HttpError, PROTOCOL } from "./coordinator.ts";

export const SESSION_COOKIE = "d402_session";
export const GRANT_HEADER = "D402-Grant";
/** Response header on the protected page: "sponsored" or "free". */
export const ACCESS_HEADER = "D402-Access";

const RESOURCE = { id: "article-demo", path: "/article", method: "GET" };

function sessionOf(req: Request) {
  const match = req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]+)`));
  return match?.[1];
}

export function createApp(coordinator: Coordinator) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  // Token-bearing and protected responses must never be cached.
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // ---- website adapter --------------------------------------------------------------------------------------

  app.get(RESOURCE.path, (req, res) => {
    let sessionId = sessionOf(req);
    if (!sessionId) {
      sessionId = randomBytes(18).toString("base64url");
      res.append("Set-Cookie", `${SESSION_COOKIE}=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    }
    const binding = { sessionId, resourceId: RESOURCE.id, method: req.method };
    try {
      const grant = req.get(GRANT_HEADER);
      if (grant) {
        const result = coordinator.redeemGrant(grant, binding);
        if (result.ok) return renderArticle(res, result.reason);
        // Demo policy: an expired or unknown grant still gets the page, free.
        coordinator.recordFreeAccess(RESOURCE.id, result.why);
        return renderArticle(res, "free");
      }
      const challenge = coordinator.createChallenge(binding);
      res.status(402).json({
        protocol: PROTOCOL,
        challenge_id: challenge.challengeId,
        claim_url: "/d402/claim",
        fallback_url: "/d402/fallback",
        challenge_token: challenge.token,
        resource_id: RESOURCE.id,
        task_count: 1,
        expires_in_seconds: CHALLENGE_TTL,
        instructions:
          "Access requires one trace-labeling attempt. POST {challenge_token} to claim_url with this session cookie, " +
          "label the returned traces, POST {attempt_token, labels} to the returned submit_url, then retry this " +
          `request with header ${GRANT_HEADER}: <grant_token>. On any failure, POST {challenge_token, reason} to ` +
          "fallback_url for free access.",
      });
    } catch (err) {
      // Access must not depend on the coordinator: serve the page directly and record it only if possible.
      console.error(`[website] coordinator unavailable, serving page directly: ${(err as Error).message}`);
      try {
        coordinator.recordFreeAccess(RESOURCE.id, "coordinator_unavailable");
      } catch {}
      renderArticle(res, "free");
    }
  });

  // ---- coordinator API (called by the Claude Code plugin) ---------------------------------------------------

  const requireSession = (req: Request) => {
    const sessionId = sessionOf(req);
    if (!sessionId) throw new HttpError(403, `Missing ${SESSION_COOKIE} cookie.`);
    return sessionId;
  };

  app.post("/d402/claim", handle(async (req) => coordinator.claim(req.body?.challenge_token, requireSession(req))));
  app.post(
    "/d402/attempts/:id",
    handle(async (req) =>
      coordinator.submit(String(req.params.id), req.body?.attempt_token, req.body, requireSession(req)),
    ),
  );
  app.post(
    "/d402/fallback",
    handle(async (req) => coordinator.fallback(req.body?.challenge_token, req.body?.reason, requireSession(req))),
  );

  // ---- eval lab API -----------------------------------------------------------------------------------------

  const requireLab = (req: Request) => {
    const lab = coordinator.labForKey(req.get("authorization")?.replace(/^Bearer /, ""));
    if (!lab) throw new HttpError(401, "Unknown lab API key.");
    return lab;
  };

  app.post("/lab/tasks", handle(async (req) => ({ tasks: coordinator.enqueue(requireLab(req), req.body?.tasks) })));
  app.get(
    "/lab/attempts",
    handle(async (req) =>
      coordinator.exportAttempts(
        requireLab(req),
        Number(req.query.after ?? 0) || 0,
        Math.min(Number(req.query.limit ?? 100) || 100, 500),
      ),
    ),
  );

  // ---- operator dashboard -----------------------------------------------------------------------------------

  app.get("/dashboard.json", handle(async () => coordinator.snapshot()));
  app.get("/", (_req, res) => res.redirect("/dashboard"));
  app.get("/dashboard", (_req, res) => {
    try {
      res.type("html").send(renderDashboard(coordinator.snapshot()));
    } catch (err) {
      res.status(503).type("text").send(`Coordinator unavailable: ${(err as Error).message}`);
    }
  });

  return app;
}

function handle(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`[coordinator] ${req.method} ${req.path} failed: ${(err as Error).message}`);
      res.status(status).json({ error: status === 500 ? "Coordinator error." : (err as Error).message });
    }
  };
}

const escape = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string, extraHead = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>${extraHead}
<style>
  :root { color-scheme: light; --ink: #1b2430; --muted: #5b6573; --line: #e3e7ed; --blue: #24496f; }
  body { font: 15px/1.55 system-ui, sans-serif; color: var(--ink); margin: 0; background: #f7f8fa; }
  main { max-width: 1080px; margin: 0 auto; padding: 28px 24px 48px; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 28px 0 8px; color: var(--blue); }
  .sub { color: var(--muted); margin: 0 0 8px; }
  article { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 28px 32px; max-width: 680px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { background: #eef2f7; font-weight: 600; color: var(--muted); }
  td.wrap { white-space: normal; } tr:last-child td { border-bottom: 0; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #eef2f7; }
  .sponsored, .submitted, .attempted { background: #e3f4e8; color: #1f6b3a; }
  .free, .queued { background: #eef2f7; color: #3c4a5c; }
  .leased, .reserved { background: #fff3d6; color: #7a5300; }
  .invalid, .failed, .abandoned, .skipped { background: #fde8e8; color: #9b1c1c; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; min-width: 150px; }
  .card b { display: block; font-size: 22px; } .card span { color: var(--muted); font-size: 12px; }
  .empty { color: var(--muted); font-style: italic; }
</style></head><body><main>${body}</main></body></html>`;

function renderArticle(res: Response, access: string) {
  res.set(ACCESS_HEADER, access);
  res.type("html").send(
    page(
      "Labeling for access",
      `<article>
        <h1>Labeling for access</h1>
        <p class="sub">A D402 demo article · access: <span class="pill ${escape(access)}">${escape(access)}</span></p>
        <p>This page answers a first request with HTTP 402. Instead of paying, a visiting agent labels one batch of
        chatbot traces for an eval lab, and the lab pays this website directly under a sponsorship agreement.
        The agent never holds funds.</p>
        <p>${
          access === "sponsored"
            ? "Your agent submitted a label set, so this view is sponsored by the lab."
            : "This view is free: labeling work was unavailable or did not complete, and the lab is not charged."
        }</p>
      </article>`,
    ),
  );
}

function table(rows: Record<string, unknown>[], columns: [string, string][], pills: string[] = []) {
  if (!rows.length) return `<p class="empty">None yet.</p>`;
  const head = columns.map(([, label]) => `<th>${escape(label)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${columns
          .map(([key]) => {
            const value = row[key];
            if (pills.includes(key) && value) {
              const kind = String(value).split(":")[0];
              return `<td><span class="pill ${escape(kind)}">${escape(value)}</span></td>`;
            }
            if (key.endsWith("_at") || key === "lease_until") {
              return `<td>${value ? new Date(Number(value) * 1000).toISOString().slice(11, 19) : ""}</td>`;
            }
            return `<td class="${key === "error" || key === "detail" ? "wrap" : ""}">${escape(value)}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderDashboard(s: ReturnType<Coordinator["snapshot"]>) {
  const sponsoredEvents = s.accessEvents.filter((e) => e.amount_cents > 0);
  const charged = sponsoredEvents.reduce((sum, e) => sum + Number(e.amount_cents), 0);
  const cards = [
    ["Sponsored page views", sponsoredEvents.length],
    ["Free page views", s.accessEvents.length - sponsoredEvents.length],
    ["Charged to lab", `$${(charged / 100).toFixed(2)}`],
    ["Tasks queued", s.tasks.filter((t) => t.status === "queued").length],
    ["Label sets submitted", s.attempts.filter((a) => a.status === "submitted").length],
  ]
    .map(([label, value]) => `<div class="card"><b>${escape(value)}</b><span>${escape(label)}</span></div>`)
    .join("");
  return page(
    "D402 dashboard",
    `<h1>D402 operator dashboard</h1>
     <p class="sub">Website and coordinator share one backend. This view shows IDs, statuses, and the ledger, never
     trace contents. Refreshes every 2 seconds.</p>
     <div class="cards">${cards}</div>
     <h2>Sponsorship (lab → website direct payment)</h2>
     ${table(s.sponsorships, [["lab_id", "Lab"], ["payment_reference", "Payment reference"], ["unit_price_cents", "Unit price (¢)"], ["remaining_units", "Remaining units"], ["reserved_units", "Reserved"]])}
     <h2>Access events</h2>
     ${table(s.accessEvents, [["id", "#"], ["created_at", "Time"], ["challenge_id", "Challenge"], ["reason", "Reason"], ["amount_cents", "Amount (¢)"], ["lab_id", "Lab"], ["payment_reference", "Payment reference"]], ["reason"])}
     <h2>Task queue</h2>
     ${table(s.tasks, [["id", "Task"], ["external_id", "Lab task ID"], ["rubric_version", "Rubric"], ["status", "Status"], ["lease_until", "Lease until"]], ["status"])}
     <h2>Attempts</h2>
     ${table(s.attempts, [["id", "Attempt"], ["task_id", "Task"], ["challenge_id", "Challenge"], ["status", "Status"], ["error", "Error"], ["finished_at", "Finished"]], ["status"])}
     <h2>Grants</h2>
     ${table(s.grants, [["id", "Grant"], ["challenge_id", "Challenge"], ["reason", "Access"], ["detail", "Detail"], ["expires_at", "Expires"], ["redeemed_at", "Redeemed"]], ["reason"])}`,
    `<meta http-equiv="refresh" content="2">`,
  );
}

// D402 coordinator: task queue, attempts, access grants, and the sponsorship ledger, stored in SQLite.
// The website adapter and the HTTP routes in http.ts call into this class; it knows nothing about Express.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const PROTOCOL = "d402-v0";
export const CHALLENGE_TTL = 600; // seconds
export const GRANT_TTL = 600;
export const LEASE_TTL = 180;
export const WORKER_DEADLINE = 120;
const MAX_PAYLOAD_BYTES = 1_000_000;
const MAX_TRACES = 5;
const MAX_INPUT_TOKENS = 15_000;
const MAX_LABELS_BYTES = 64 * 1024;
const MAX_REASON_CHARS = 500;

export interface LabConfig {
  id: string;
  /** Bearer key the lab uses for /lab/* endpoints. */
  apiKey: string;
  /** Task payloads may only be fetched from this origin and path prefix. */
  sandboxOrigin: string;
  sandboxPathPrefix: string;
  /** Server-side credential for the lab sandbox. Never sent to agents. */
  sandboxKey: string;
}

export interface Sponsorship {
  labId: string;
  paymentReference: string;
  unitPriceCents: number;
  units: number;
}

export interface CoordinatorOptions {
  /** SQLite file path, or ":memory:". */
  db: string;
  /** HMAC key for capabilities (challenge, attempt, and grant tokens). */
  secret: string;
  siteId: string;
  labs: LabConfig[];
  /** Unix seconds. Injectable for tests. */
  now?: () => number;
}

/** A request context derived on the server, never from the request body. */
export interface Binding {
  sessionId: string;
  resourceId: string;
  method: string;
}

export type AccessReason = "sponsored" | "free";

export interface GrantResult {
  status: "granted";
  grant_token: string;
  access_reason: AccessReason;
  /** Why access is free, e.g. "no_task" or "invalid_labels". */
  detail?: string;
  errors?: string[];
}

export interface TaskResult {
  status: "task";
  challenge_id: string;
  attempt_id: string;
  attempt_token: string;
  submit_url: string;
  deadline_seconds: number;
  lease_expires_at: number;
  task: TaskPayload;
}

export interface TaskPayload {
  task_id: string;
  rubric_version: string;
  instructions?: string;
  rubric: unknown;
  traces: { trace_id: string; messages: { role: string; content: string }[] }[];
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A task the coordinator could not use. "skip" tasks are never retried; "release" tasks go back to the queue. */
class TaskError extends Error {
  action: "skip" | "release";
  constructor(action: "skip" | "release", message: string) {
    super(message);
    this.action = action;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sponsorships (
  lab_id TEXT PRIMARY KEY, payment_reference TEXT NOT NULL, unit_price_cents INTEGER NOT NULL,
  remaining_units INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, lab_id TEXT NOT NULL, external_id TEXT NOT NULL, payload_ref TEXT NOT NULL,
  rubric_version TEXT NOT NULL, status TEXT NOT NULL, lease_until INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (lab_id, external_id));
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, site_id TEXT NOT NULL, resource_id TEXT NOT NULL,
  method TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempt_id TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, challenge_id TEXT NOT NULL, status TEXT NOT NULL,
  payload_hash TEXT, token_hash TEXT NOT NULL, trace_ids_json TEXT, labels_json TEXT, error TEXT,
  created_at INTEGER NOT NULL, finished_at INTEGER, export_seq INTEGER UNIQUE);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, challenge_id TEXT NOT NULL UNIQUE, reason TEXT NOT NULL,
  detail TEXT, expires_at INTEGER NOT NULL, redeemed_at INTEGER);
CREATE TABLE IF NOT EXISTS reservations (
  challenge_id TEXT PRIMARY KEY, lab_id TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS access_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, challenge_id TEXT UNIQUE, grant_id TEXT, lab_id TEXT,
  resource_id TEXT NOT NULL, reason TEXT NOT NULL, amount_cents INTEGER NOT NULL, payment_reference TEXT,
  created_at INTEGER NOT NULL);
`;

type Row = Record<string, any>;

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const idOf = (token: string) => (typeof token === "string" ? token.split(".")[0] : "");

export class Coordinator {
  readonly db: DatabaseSync;
  readonly siteId: string;
  private readonly secret: string;
  private readonly labs: LabConfig[];
  private readonly now: () => number;

  constructor(options: CoordinatorOptions) {
    if (!options.secret) throw new Error("Coordinator: secret is required");
    this.db = new DatabaseSync(options.db);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
    this.db.exec(SCHEMA);
    this.secret = options.secret;
    this.siteId = options.siteId;
    this.labs = options.labs;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ---- capabilities -------------------------------------------------------------------------------------------
  // Tokens are "<id>.<HMAC over the id and its binding fields>", so the same token can be re-derived for replays
  // while the database only stores its hash.

  private mac(...parts: string[]) {
    return createHmac("sha256", this.secret).update(parts.join("\n")).digest("base64url");
  }
  private challengeToken(c: Row) {
    return `${c.id}.${this.mac("challenge", c.id, c.session_id, c.site_id, c.resource_id, c.method)}`;
  }
  private attemptToken(attemptId: string, c: Row) {
    return `${attemptId}.${this.mac("attempt", attemptId, c.id, c.session_id)}`;
  }
  private grantToken(grantId: string, c: Row) {
    return `${grantId}.${this.mac("grant", grantId, c.id, c.session_id, c.site_id, c.resource_id, c.method)}`;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  private get(sql: string, ...params: any[]) {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: any[]) {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }

  // ---- website adapter API ------------------------------------------------------------------------------------

  createChallenge(binding: Binding) {
    const now = this.now();
    const c = {
      id: newId("ch"),
      session_id: binding.sessionId,
      site_id: this.siteId,
      resource_id: binding.resourceId,
      method: binding.method,
      expires_at: now + CHALLENGE_TTL,
    };
    const token = this.challengeToken(c);
    this.run(
      `INSERT INTO challenges (id, session_id, site_id, resource_id, method, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id, c.session_id, c.site_id, c.resource_id, c.method, sha256(token), c.expires_at, now,
    );
    return { challengeId: c.id, token, expiresIn: CHALLENGE_TTL };
  }

  /**
   * Checks a grant for this session and page. The first redemption records the access event and, for sponsored
   * grants, consumes the reserved sponsorship unit. Later redemptions within the grant's lifetime charge nothing.
   */
  redeemGrant(token: string, binding: Binding): { ok: true; reason: AccessReason } | { ok: false; why: string } {
    const g = this.get("SELECT * FROM grants WHERE id = ?", idOf(token));
    const c = g && this.get("SELECT * FROM challenges WHERE id = ?", g.challenge_id);
    if (!g || !c || !sameHash(sha256(token), g.token_hash) || !this.matches(c, binding)) {
      return { ok: false, why: "unknown_grant" };
    }
    if (g.expires_at <= this.now()) return { ok: false, why: "grant_expired" };
    if (g.redeemed_at == null) {
      this.tx(() => {
        // Re-read inside the transaction so concurrent first redemptions charge once.
        if (this.get("SELECT redeemed_at FROM grants WHERE id = ?", g.id)?.redeemed_at != null) return;
        this.run("UPDATE grants SET redeemed_at = ? WHERE id = ?", this.now(), g.id);
        let labId: string | null = null;
        let amount = 0;
        let paymentReference: string | null = null;
        const reservation = this.get(
          "SELECT * FROM reservations WHERE challenge_id = ? AND status = 'reserved'",
          c.id,
        );
        if (g.reason === "sponsored" && reservation) {
          const s = this.get("SELECT * FROM sponsorships WHERE lab_id = ?", reservation.lab_id)!;
          this.run("UPDATE reservations SET status = 'finalized' WHERE challenge_id = ?", c.id);
          this.run("UPDATE sponsorships SET remaining_units = remaining_units - 1 WHERE lab_id = ?", s.lab_id);
          labId = s.lab_id;
          amount = s.unit_price_cents;
          paymentReference = s.payment_reference;
        }
        this.run(
          `INSERT OR IGNORE INTO access_events
             (challenge_id, grant_id, lab_id, resource_id, reason, amount_cents, payment_reference, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          c.id, g.id, labId, c.resource_id, amount ? "sponsored" : `free:${g.detail ?? "fallback"}`, amount,
          paymentReference, this.now(),
        );
      });
    }
    return { ok: true, reason: g.reason };
  }

  /** Records a page served for free without a usable grant (expired or unknown token). */
  recordFreeAccess(resourceId: string, reason: string) {
    this.run(
      "INSERT INTO access_events (resource_id, reason, amount_cents, created_at) VALUES (?, ?, 0, ?)",
      resourceId, `free:${reason}`, this.now(),
    );
  }

  // ---- plugin API ---------------------------------------------------------------------------------------------

  async claim(challengeToken: string, sessionId: string): Promise<TaskResult | GrantResult> {
    this.sweep();
    const c = this.verifyChallenge(challengeToken, sessionId);
    const existing = this.grantFor(c);
    if (existing) return existing;
    if (c.expires_at <= this.now()) return this.issueFree(c, "challenge_expired");

    if (c.attempt_id) {
      // Claim replay: return the same attempt while its lease is active.
      const a = this.get("SELECT * FROM attempts WHERE id = ?", c.attempt_id)!;
      if (a.status !== "leased") return this.issueFree(c, `attempt_${a.status}`);
      return this.deliverTask(c, a);
    }

    const leased: { free: GrantResult } | { attemptId: string } = this.tx(() => {
      const task = this.get(
        `SELECT t.* FROM tasks t JOIN sponsorships s ON s.lab_id = t.lab_id
         WHERE t.status = 'queued' AND s.remaining_units >
           (SELECT COUNT(*) FROM reservations r WHERE r.lab_id = s.lab_id AND r.status = 'reserved')
         ORDER BY t.created_at, t.rowid LIMIT 1`,
      );
      if (!task) {
        const queued = this.get("SELECT 1 FROM tasks WHERE status = 'queued'");
        return { free: this.issueFree(c, queued ? "no_sponsorship" : "no_task") };
      }
      const attemptId = newId("at");
      this.run("UPDATE tasks SET status = 'leased', lease_until = ? WHERE id = ?", this.now() + LEASE_TTL, task.id);
      this.run(
        `INSERT INTO attempts (id, task_id, challenge_id, status, token_hash, created_at)
         VALUES (?, ?, ?, 'leased', ?, ?)`,
        attemptId, task.id, c.id, sha256(this.attemptToken(attemptId, c)), this.now(),
      );
      this.run("UPDATE challenges SET attempt_id = ? WHERE id = ?", attemptId, c.id);
      this.run("INSERT INTO reservations (challenge_id, lab_id, status) VALUES (?, ?, 'reserved')", c.id, task.lab_id);
      return { attemptId };
    });
    if ("free" in leased) return leased.free;
    return this.deliverTask(c, this.get("SELECT * FROM attempts WHERE id = ?", leased.attemptId)!);
  }

  async submit(attemptId: string, attemptToken: string, body: any, sessionId: string): Promise<GrantResult> {
    this.sweep();
    const a = this.get("SELECT * FROM attempts WHERE id = ?", attemptId);
    const c = a && this.get("SELECT * FROM challenges WHERE id = ?", a.challenge_id);
    if (!a || !c || !sameHash(sha256(String(attemptToken)), a.token_hash) || c.session_id !== sessionId) {
      throw new HttpError(403, "Unknown attempt or capability.");
    }
    // Replays return the stored outcome and never overwrite accepted labels.
    const existing = this.grantFor(c);
    if (existing) return existing;
    // Labels that arrive after lease expiry or task reassignment are ignored.
    if (a.status !== "leased") return this.issueFree(c, "late_submission");

    const errors = validateLabels(body, a);
    if (errors.length) {
      return this.tx(() => {
        this.finishAttempt(a, "invalid", errors.join("; "));
        this.releaseTask(a.task_id);
        this.releaseReservation(c.id);
        return { ...this.issueFree(c, "invalid_labels"), errors };
      });
    }
    return this.tx(() => {
      this.finishAttempt(a, "submitted", null, JSON.stringify(body.labels));
      this.run("UPDATE tasks SET status = 'attempted', lease_until = NULL WHERE id = ?", a.task_id);
      return this.issueGrant(c, "sponsored", null);
    });
  }

  /**
   * Free access for a work or service failure. This cannot prove an error happened, so a client can always choose
   * it: the demo is not an enforceable paywall.
   */
  fallback(challengeToken: string, reason: unknown, sessionId: string): GrantResult {
    this.sweep();
    const c = this.verifyChallenge(challengeToken, sessionId);
    const detail = `fallback:${String(reason ?? "unspecified").slice(0, 200)}`;
    return this.tx(() => {
      const g = this.get("SELECT * FROM grants WHERE challenge_id = ?", c.id);
      if (g && g.reason === "sponsored" && g.redeemed_at == null) {
        // A valid attempt stays available to the lab, but this challenge records no sponsored charge.
        this.releaseReservation(c.id);
        this.run("UPDATE grants SET reason = 'free', detail = ? WHERE id = ?", detail, g.id);
      }
      const existing = this.grantFor(c);
      if (existing) return existing;
      const a = c.attempt_id && this.get("SELECT * FROM attempts WHERE id = ?", c.attempt_id);
      if (a?.status === "leased") {
        this.finishAttempt(a, "failed", detail);
        this.releaseTask(a.task_id);
      }
      this.releaseReservation(c.id);
      return this.issueFree(c, detail);
    });
  }

  // ---- lab API ------------------------------------------------------------------------------------------------

  labForKey(apiKey: string | undefined) {
    return this.labs.find((lab) => apiKey && sameHash(sha256(apiKey), sha256(lab.apiKey)));
  }

  configureSponsorship(s: Sponsorship) {
    this.run(
      `INSERT INTO sponsorships (lab_id, payment_reference, unit_price_cents, remaining_units) VALUES (?, ?, ?, ?)
       ON CONFLICT (lab_id) DO UPDATE SET payment_reference = excluded.payment_reference,
         unit_price_cents = excluded.unit_price_cents, remaining_units = excluded.remaining_units`,
      s.labId, s.paymentReference, s.unitPriceCents, s.units,
    );
  }

  enqueue(lab: LabConfig, items: unknown) {
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, "Body must be { tasks: [...] }.");
    return this.tx(() =>
      items.map((item: any) => {
        for (const field of ["external_id", "payload_ref", "rubric_version"]) {
          if (typeof item?.[field] !== "string" || !item[field]) throw new HttpError(400, `Missing ${field}.`);
        }
        this.sandboxUrl(lab, item.payload_ref);
        const inserted = this.run(
          `INSERT OR IGNORE INTO tasks (id, lab_id, external_id, payload_ref, rubric_version, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
          newId("task"), lab.id, item.external_id, item.payload_ref, item.rubric_version, this.now(),
        );
        const t = this.get("SELECT * FROM tasks WHERE lab_id = ? AND external_id = ?", lab.id, item.external_id)!;
        return { task_id: t.id, external_id: t.external_id, status: t.status, created: inserted.changes > 0 };
      }),
    );
  }

  /** Finished attempts for one lab, ordered by a stable cursor so repeated exports return the same result IDs. */
  exportAttempts(lab: LabConfig, after: number, limit: number) {
    this.sweep();
    const rows = this.all(
      `SELECT a.*, t.external_id, t.rubric_version FROM attempts a JOIN tasks t ON t.id = a.task_id
       WHERE t.lab_id = ? AND a.export_seq > ? ORDER BY a.export_seq LIMIT ?`,
      lab.id, after, limit,
    );
    return {
      attempts: rows.map((r) => ({
        cursor: r.export_seq,
        attempt_id: r.id,
        task_id: r.task_id,
        external_id: r.external_id,
        rubric_version: r.rubric_version,
        status: r.status,
        payload_hash: r.payload_hash,
        labels: r.labels_json ? JSON.parse(r.labels_json) : null,
        error: r.error,
        finished_at: r.finished_at,
      })),
      next_cursor: rows.at(-1)?.export_seq ?? after,
    };
  }

  /** Operator view: queue, attempts, grants, and the ledger. Contains no trace contents or labels. */
  snapshot() {
    this.sweep();
    return {
      sponsorships: this.all(
        `SELECT s.*, (SELECT COUNT(*) FROM reservations r WHERE r.lab_id = s.lab_id AND r.status = 'reserved')
           AS reserved_units FROM sponsorships s`,
      ),
      tasks: this.all("SELECT id, lab_id, external_id, rubric_version, status, lease_until FROM tasks ORDER BY rowid"),
      attempts: this.all(
        "SELECT id, task_id, challenge_id, status, error, created_at, finished_at FROM attempts ORDER BY rowid DESC",
      ),
      grants: this.all("SELECT id, challenge_id, reason, detail, expires_at, redeemed_at FROM grants ORDER BY rowid DESC"),
      accessEvents: this.all("SELECT * FROM access_events ORDER BY id DESC"),
    };
  }

  /** Returns expired leases to the queue and releases reservations held by expired, unredeemed grants. */
  sweep() {
    const now = this.now();
    this.tx(() => {
      for (const t of this.all("SELECT id FROM tasks WHERE status = 'leased' AND lease_until <= ?", now)) {
        for (const a of this.all("SELECT * FROM attempts WHERE task_id = ? AND status = 'leased'", t.id)) {
          this.finishAttempt(a, "abandoned", "lease_expired");
          this.releaseReservation(a.challenge_id);
        }
        this.releaseTask(t.id);
      }
      for (const g of this.all(
        "SELECT challenge_id FROM grants WHERE reason = 'sponsored' AND redeemed_at IS NULL AND expires_at <= ?",
        now,
      )) {
        this.releaseReservation(g.challenge_id);
      }
    });
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private matches(c: Row, binding: Binding) {
    return (
      c.session_id === binding.sessionId &&
      c.site_id === this.siteId &&
      c.resource_id === binding.resourceId &&
      c.method === binding.method
    );
  }

  private verifyChallenge(token: unknown, sessionId: string) {
    const c = this.get("SELECT * FROM challenges WHERE id = ?", idOf(String(token)));
    if (!c || !sameHash(sha256(String(token)), c.token_hash) || c.session_id !== sessionId) {
      throw new HttpError(403, "Unknown challenge, or it belongs to another session.");
    }
    return c;
  }

  private grantFor(c: Row): GrantResult | undefined {
    const g = this.get("SELECT * FROM grants WHERE challenge_id = ?", c.id);
    if (!g) return undefined;
    return {
      status: "granted",
      grant_token: this.grantToken(g.id, c),
      access_reason: g.reason,
      ...(g.detail && { detail: g.detail }),
    };
  }

  private issueGrant(c: Row, reason: AccessReason, detail: string | null): GrantResult {
    const id = newId("gr");
    const token = this.grantToken(id, c);
    this.run(
      "INSERT INTO grants (id, token_hash, challenge_id, reason, detail, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, sha256(token), c.id, reason, detail, this.now() + GRANT_TTL,
    );
    return { status: "granted", grant_token: token, access_reason: reason, ...(detail && { detail }) };
  }

  private issueFree(c: Row, detail: string) {
    return this.grantFor(c) ?? this.issueGrant(c, "free", detail);
  }

  private finishAttempt(a: Row, status: string, error: string | null, labelsJson: string | null = null) {
    this.run(
      `UPDATE attempts SET status = ?, error = ?, labels_json = ?, finished_at = ?,
         export_seq = (SELECT COALESCE(MAX(export_seq), 0) + 1 FROM attempts)
       WHERE id = ?`,
      status, error, labelsJson, this.now(), a.id,
    );
  }

  private releaseTask(taskId: string) {
    this.run("UPDATE tasks SET status = 'queued', lease_until = NULL WHERE id = ? AND status = 'leased'", taskId);
  }

  private releaseReservation(challengeId: string) {
    this.run("UPDATE reservations SET status = 'released' WHERE challenge_id = ? AND status = 'reserved'", challengeId);
  }

  /** Fetches the task payload from the lab sandbox and hands it to the plugin, or falls back to free access. */
  private async deliverTask(c: Row, a: Row): Promise<TaskResult | GrantResult> {
    const task = this.get("SELECT * FROM tasks WHERE id = ?", a.task_id)!;
    try {
      const { payload, hash } = await this.fetchPayload(task);
      if (a.payload_hash && a.payload_hash !== hash) throw new TaskError("release", "payload changed during attempt");
      this.run(
        "UPDATE attempts SET payload_hash = ?, trace_ids_json = ? WHERE id = ? AND status = 'leased'",
        hash, JSON.stringify(payload.traces.map((t) => t.trace_id)), a.id,
      );
      return {
        status: "task",
        challenge_id: c.id,
        attempt_id: a.id,
        attempt_token: this.attemptToken(a.id, c),
        submit_url: `/d402/attempts/${a.id}`,
        deadline_seconds: WORKER_DEADLINE,
        lease_expires_at: task.lease_until,
        task: payload,
      };
    } catch (err) {
      const action = err instanceof TaskError ? err.action : "release";
      const message = err instanceof Error ? err.message : String(err);
      return this.tx(() => {
        // The lease may have been swept while the sandbox request was in flight.
        const current = this.get("SELECT status FROM attempts WHERE id = ?", a.id)!;
        if (current.status === "leased") {
          this.finishAttempt(a, "failed", `${action === "skip" ? "task_skipped" : "sandbox_unavailable"}: ${message}`);
          if (action === "skip") {
            this.run("UPDATE tasks SET status = 'skipped', lease_until = NULL WHERE id = ?", task.id);
          } else {
            this.releaseTask(task.id);
          }
        }
        this.releaseReservation(c.id);
        return this.issueFree(c, action === "skip" ? "task_skipped" : "sandbox_unavailable");
      });
    }
  }

  private sandboxUrl(lab: LabConfig, ref: string) {
    let url: URL;
    try {
      url = new URL(ref, lab.sandboxOrigin);
    } catch {
      throw new HttpError(400, "payload_ref is not a URL.");
    }
    if (url.origin !== lab.sandboxOrigin || !url.pathname.startsWith(lab.sandboxPathPrefix) || url.username) {
      throw new HttpError(400, `payload_ref must be under ${lab.sandboxOrigin}${lab.sandboxPathPrefix}.`);
    }
    return url;
  }

  private async fetchPayload(task: Row): Promise<{ payload: TaskPayload; hash: string }> {
    const lab = this.labs.find((l) => l.id === task.lab_id);
    if (!lab) throw new TaskError("release", "lab is not configured");
    const url = this.sandboxUrl(lab, task.payload_ref);
    let res: Response;
    try {
      // No redirects: a redirect could point the sandbox credential at another host.
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${lab.sandboxKey}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new TaskError("release", `fetch failed (${(err as Error).message})`);
    }
    if (res.status !== 200) throw new TaskError("release", `sandbox returned HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_PAYLOAD_BYTES) throw new TaskError("skip", "payload over 1 MB");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_PAYLOAD_BYTES) throw new TaskError("skip", "payload over 1 MB");
    let payload: any;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new TaskError("skip", "payload is not JSON");
    }
    const problem = validateTask(payload, task.rubric_version);
    if (problem) throw new TaskError("skip", problem);
    // Rough token estimate: four characters per token.
    if (bytes.length / 4 > MAX_INPUT_TOKENS) throw new TaskError("skip", `payload over ${MAX_INPUT_TOKENS} tokens`);
    return { payload, hash: sha256(bytes) };
  }
}

function validateTask(p: any, rubricVersion: string): string | null {
  if (typeof p?.task_id !== "string") return "task_id missing";
  if (p.rubric_version !== rubricVersion) return "rubric_version does not match the enqueued task";
  if (p.rubric == null) return "rubric missing";
  if (!Array.isArray(p.traces) || p.traces.length === 0) return "traces missing";
  if (p.traces.length > MAX_TRACES) return `more than ${MAX_TRACES} traces`;
  const ids = new Set<string>();
  for (const t of p.traces) {
    if (typeof t?.trace_id !== "string" || ids.has(t.trace_id)) return "trace_id missing or duplicated";
    ids.add(t.trace_id);
    if (!Array.isArray(t.messages) || t.messages.some((m: any) => typeof m?.role !== "string" || typeof m?.content !== "string")) {
      return `trace ${t.trace_id} has malformed messages`;
    }
  }
  return null;
}

/** Schema check only. Accuracy is deliberately not graded: any well-formed label set counts as an attempt. */
function validateLabels(body: any, a: Row): string[] {
  if (body?.attempt_id !== undefined && body.attempt_id !== a.id) return ["attempt_id does not match"];
  const labels = body?.labels;
  if (!Array.isArray(labels)) return ["labels must be an array"];
  if (JSON.stringify(labels).length > MAX_LABELS_BYTES) return ["labels larger than 64 KB"];
  const expected: string[] = JSON.parse(a.trace_ids_json ?? "[]");
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const id = label?.trace_id;
    if (typeof id !== "string" || !expected.includes(id)) errors.push(`unknown trace_id ${JSON.stringify(id)}`);
    else if (seen.has(id)) errors.push(`duplicate trace_id ${id}`);
    seen.add(id);
    if (typeof label?.needs_review !== "boolean") errors.push(`needs_review for ${id} must be a boolean`);
    if (typeof label?.reason !== "string" || label.reason.length > MAX_REASON_CHARS) {
      errors.push(`reason for ${id} must be a string of at most ${MAX_REASON_CHARS} characters`);
    }
  }
  for (const id of expected) if (!seen.has(id)) errors.push(`missing label for ${id}`);
  return errors;
}

# D402: trace labeling in exchange for website access

An MVP of the D402 design (v0.1). A website answers `HTTP 402`. A Claude Code plugin earns access by having a
fresh, tool-free subagent label one batch of chatbot traces for an eval lab. The lab pays the website directly under
a sponsorship agreement. The agent never holds funds. If work is unavailable or fails, the website grants free access.

```
Paywalled website ◀──── direct payment (sponsorship ledger) ──── Eval lab sandbox
   │  ▲                                                             │   ▲
402│  │GET / retry with D402-Grant                       enqueue tasks│   │export labels
   ▼  │                                                             ▼   │
Claude Code agent + d402 plugin ──── claim / submit ────▶ D402 coordinator (SQLite)
   │  ▲
task  │labels
   ▼  │
trace-labeler subagent (fresh context, no tools)
```

## Run the demo

Requires Node.js ≥ 23.6.

```sh
npm install
npm run d402:demo              # runs every scenario end to end and prints the ledger
npm run d402:demo -- --serve   # same, then keeps the dashboard up at http://localhost:4020/dashboard
npm test                       # acceptance checks (test/d402.test.ts)
```

The demo starts the website + coordinator and the lab sandbox, enqueues three synthetic trace batches through the
lab API, and plays the parent agent. It drives the plugin's real MCP tool server over stdio, the same way Claude Code
does. A scripted stand-in plays the labeler, so no model or API key is needed. Scenarios:

| Scenario | Result |
| --- | --- |
| Normal path: label, submit, retry | 200, sponsored; repeat fetches with the grant are not charged again |
| Malformed labels (a trace missing) | 200, free (`invalid_labels`); task requeued |
| Labeler misses the worker deadline | 200, free (`fallback:worker_timeout`) |
| Lab sandbox outage | 200, free (`sandbox_unavailable`); task requeued |
| Deliberately wrong but schema-valid labels | 200, sponsored (accuracy is not graded) |
| Sponsorship units used up | 200, free (`no_sponsorship`) |
| Coordinator database down | 200, served directly by the website |

## Run it with Claude Code

```sh
npm run d402                                 # website + coordinator on :4020, lab sandbox on :4021
claude --plugin-dir d402/plugin              # then, in the session:
> /d402:fetch http://localhost:4020/article
```

The plugin only talks to origins in `D402_ALLOWED_ORIGINS` (default `http://localhost:4020`). The lab adapter
exports results with `npm run d402:lab -- export`. The operator dashboard is at `http://localhost:4020/dashboard`.

## Layout

| Path | Component |
| --- | --- |
| `server/http.ts` | Website adapter (`GET /article`), coordinator API (`/d402/*`), lab API (`/lab/*`), dashboard |
| `server/coordinator.ts` | Queue, leases, attempts, grants, sponsorship reservations, and access events in SQLite (`node:sqlite`) |
| `server/sandbox.ts` | Lab sandbox fixture: read-only task JSON behind a server-side key |
| `server/main.ts` | Starts the website + coordinator and the sandbox, and seeds sponsorship and fixture tasks |
| `lab.ts` | Eval lab adapter: enqueue tasks, export attempts |
| `plugin/` | Claude Code plugin `d402`: `/d402:fetch` skill, `trace-labeler` agent, MCP tool server (`open`, `submit`, `resume`, `fallback`) |
| `fixtures/tasks/` | Synthetic trace batches, including one with a prompt injection |

## Protocol (`d402-v0`)

| Endpoint | Caller | Behavior |
| --- | --- | --- |
| `GET /article` | Plugin | 402 challenge, or 200 with `D402-Grant: <grant_token>`. Sets the `d402_session` cookie |
| `POST /d402/claim` | Plugin | `{challenge_token}` → `{status:"task", attempt_id, attempt_token, submit_url, task}` or a free grant |
| `POST /d402/attempts/{id}` | Plugin | `{attempt_token, labels}` → `{grant_token, access_reason}` |
| `POST /d402/fallback` | Plugin | `{challenge_token, reason}` → free grant |
| `POST /lab/tasks` | Lab | `{tasks:[{external_id, payload_ref, rubric_version}]}`, deduplicated by lab and external ID |
| `GET /lab/attempts?after=N` | Lab | Finished attempts after cursor `N`, with labels and statuses |

Lab endpoints take `Authorization: Bearer <lab API key>`. All responses are `Cache-Control: no-store`.

Implementation choices:

- **Capabilities.** Challenge, attempt, and grant tokens are `<id>.<HMAC(id, binding fields)>`, bound to the
  session, site, resource, and method. The database stores only their SHA-256, and replays re-derive the same token.
- **Queue.** A claim runs one SQLite transaction. It leases the oldest queued task whose lab has unreserved
  sponsorship units, creates the attempt, and reserves one unit. Leases last 3 minutes. A sweep, run before each
  coordinator call and every 15 s, marks expired attempts `abandoned`, requeues their tasks, and releases
  reservations held by expired, unredeemed grants.
- **Payloads.** The coordinator fetches payloads only from the lab's configured origin and path prefix, with no
  redirects. Tasks over 1 MB, over 5 traces, or over about 15,000 tokens (4 characters per token) are `skipped`. The
  payload hash is snapshotted at assignment, and a changed payload fails the attempt.
- **Labels.** A submission counts if it has exactly one label per assigned trace, boolean `needs_review`, a reason of
  at most 500 characters, and a total size under 64 KB. Anything else is recorded `invalid` and gets free access.
- **Billing.** Only the first redemption of a sponsored grant finalizes the reserved unit and writes the access event,
  which is unique per challenge. Fallback after a valid submission keeps the labels for the lab and charges nothing.
- **Plugin.** The tool server keeps cookies and tokens, so the model only sees IDs and the task. It follows only
  same-origin redirects. `submit` after the worker deadline (`D402_WORKER_DEADLINE_MS`, default 120 s) falls back
  instead. The labeler has `tools: []` and `omitClaudeMd: true`.

## Limitations

- The fallback endpoint can't tell whether an error really happened, so any client can choose free access. This
  follows from the MVP's failure policy; the demo is not an enforceable paywall.
- Label quality is not checked, so arbitrary labels unlock pages.
- An empty `tools` allowlist and a separate context are not an OS sandbox. Claude Code can still load managed
  instructions into the labeler.
- The plugin and agent configuration passes `claude plugin validate` (Claude Code 2.1.307), and its MCP server
  connects. The live `/d402:fetch` flow with a real model has not been run here; the demo uses a scripted labeler.
- One process, one SQLite file, HTTP on localhost. Use HTTPS and real secrets (`D402_SECRET`, `D402_LAB_API_KEY`,
  `D402_SANDBOX_KEY`) anywhere else.

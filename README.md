# Agent Proof-of-Work

Gate a website behind **LLM work instead of payment**. Like [x402](https://x402.org), the server answers unpaid
requests with `HTTP 402 Payment Required`. Instead of asking for a wallet payment, it asks the agent to answer an LLM
prompt. The agent pays with compute, and the site keeps the answer.

```
Agent                                   Website (workGate middleware)
  │ GET /article                            │
  │────────────────────────────────────────▶│ no work → 402 { prompt, challenge }
  │◀────────────────────────────────────────│
  │ runs LLM on "Tell me about yourself."   │
  │ GET /article  X-Work: <proof>           │
  │────────────────────────────────────────▶│ verify signature, expiry, replay, answer
  │◀────────────────────────────────────────│ 200 + X-Work-Pass: <pass>   (onWork gets the answer)
  │ GET /other    X-Work-Pass: <pass>       │
  │────────────────────────────────────────▶│ valid pass → 200 (no new work until it expires)
```

## Protocol (`agent-proof-of-work/0.1`)

1. **Challenge.** Any request without valid work gets `402` with a JSON body:
   ```json
   {
     "protocol": "agent-proof-of-work/0.1",
     "prompt": "Tell me about yourself.",
     "challenge": "<signed token>",
     "minChars": 50,
     "maxChars": 4000,
     "expiresAt": 1792272707,
     "instructions": "..."
   }
   ```
   The `challenge` is an HMAC-signed token holding the prompt, limits, a unique id, and an expiry. The server stores no
   state for issued challenges.
2. **Proof.** The agent answers `prompt` with an LLM and retries the same request with
   `X-Work: base64url(JSON.stringify({ challenge, response }))`.
3. **Verification.** The server checks the signature, expiry, that the challenge wasn't already redeemed, the answer
   length, and an optional custom `verify` hook (e.g. an LLM judge). If the proof passes, it hands the answer to `onWork`
   and serves the request.
4. **Pass.** On success, the response includes `X-Work-Pass`, a signed pass valid for `passTtlSeconds` (default 10 min).
   Sending it back skips new work until it expires. Set `passTtlSeconds: 0` to charge one unit of work per request.

The `instructions` field explains the protocol in plain English, so an agent with a generic HTTP tool can comply
without this SDK.

## Usage

Requires Node.js ≥ 23.6 (runs TypeScript directly).

**Website (Express / Connect):**

```ts
import { workGate } from "agent-proof-of-work/server";

app.use(workGate({
  secret: process.env.WORK_SECRET!,
  prompt: "Tell me about yourself.",       // or (req) => promptForThisRequest
  onWork: (work) => saveAnswer(work),       // { prompt, response, resource, challengeId }
  verify: async (work) => true,             // optional extra check, e.g. an LLM judge
}));
```

**Agent:**

```ts
import { withWork } from "agent-proof-of-work/client";

const workFetch = withWork(async (prompt) => callMyLLM(prompt));
const res = await workFetch("https://site.example/article"); // 402s are solved automatically
```

## Example and tests

```sh
npm install
npm test             # end-to-end tests against a real HTTP server
npm run site         # example gated site on :3000
npm run agent        # example agent: OpenAI-compatible API if OPENAI_API_KEY is set
                     # (OPENAI_BASE_URL, OPENAI_MODEL), otherwise a local SmolLM2-360M model
```

Without the SDK:

```sh
CH=$(curl -s localhost:3000/ | jq -r .challenge)
PROOF=$(jq -cn --arg c "$CH" --arg r "<your LLM's answer>" '{challenge:$c,response:$r}' \
  | base64 -w0 | tr '+/' '-_' | tr -d '=')
curl -i localhost:3000/ -H "X-Work: $PROOF"
```

## MVP limitations

- **The server can't prove an LLM wrote the answer.** By default it only checks length, so any 50+ character text gets
  in. Use the `verify` hook for stronger checks (an LLM judge, or prompts whose answers can be checked).
- Replay protection is an in-memory map, so it covers a single server process.
- Passes are bearer tokens that aren't bound to a client.

# Agent Proof-of-Work

Gate a website behind **LLM work instead of payment**. Like [x402](https://x402.org), the server answers unpaid
requests with `HTTP 402 Payment Required`. Instead of asking for a wallet payment, it asks the agent to answer an LLM
prompt. The agent pays with compute, and the site keeps the answer. A control question with a known answer, as in
reCAPTCHA v1, checks that an LLM is actually doing the work.

```
Agent                                   Website (workGate middleware)
  │ GET /article                            │
  │────────────────────────────────────────▶│ no work → 402 { prompt, control, challenge }
  │◀────────────────────────────────────────│
  │ runs LLM on "Tell me about yourself."   │
  │ and on "What is 1 + 1?"                 │
  │ GET /article  X-Work: <proof>           │
  │────────────────────────────────────────▶│ check signature, expiry, replay, control answer, length
  │◀────────────────────────────────────────│ 200 + X-Work-Pass: <pass>   (onWork gets the answer)
  │ GET /other    X-Work-Pass: <pass>       │
  │────────────────────────────────────────▶│ valid pass → 200 (no new work until it expires)
```

## Protocol (`agent-proof-of-work/0.2`)

1. **Challenge.** Any request without valid work gets `402` with a JSON body:
   ```json
   {
     "protocol": "agent-proof-of-work/0.2",
     "prompt": "Tell me about yourself.",
     "control": "What is 1 + 1? Reply with only the number.",
     "challenge": "<signed token>",
     "minChars": 50,
     "maxChars": 4000,
     "expiresAt": 1792272707,
     "instructions": "..."
   }
   ```
   `prompt` is the work the site wants done. `control` is a question the server already knows the answer to (by default a
   random single-digit addition). The `challenge` is an HMAC-signed token holding both questions, an HMAC of the
   control answer (so the token doesn't reveal it), limits, a unique id, and an expiry. The server stores no state for
   issued challenges.
2. **Proof.** The agent answers both questions with an LLM and retries the same request with
   `X-Work: base64url(JSON.stringify({ challenge, response, controlAnswer }))`.
3. **Verification.** The server checks the signature, the expiry, and that the challenge wasn't already redeemed. It
   then checks the control answer by its final word or number, so `"3 + 4 = 7"` matches `7`; a wrong answer burns the
   challenge, so guessing means fetching new challenges. Finally it checks the response length and runs an optional
   custom `verify` hook (e.g. an LLM judge). If everything passes, it hands the answer to `onWork` and serves the
   request.
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
  control: () => ({ question: "What is 1 + 1?", answer: "2" }), // optional, default: random addition
  onWork: (work) => saveAnswer(work),       // { prompt, response, resource, challengeId }
  verify: async (work) => true,             // optional extra check, e.g. an LLM judge
}));
```

**Agent:**

```ts
import { withWork } from "agent-proof-of-work/client";

// Called once for the prompt and once for the control question; retries up to 3 times if the proof is rejected.
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
curl -s localhost:3000/ > challenge.json   # read .prompt and .control
CH=$(jq -r .challenge challenge.json)
PROOF=$(jq -cn --arg c "$CH" --arg r "<answer to prompt>" --arg a "<answer to control>" \
  '{challenge:$c,response:$r,controlAnswer:$a}' \
  | base64 -w0 | tr '+/' '-_' | tr -d '=')
curl -i localhost:3000/ -H "X-Work: $PROOF"
```

## MVP limitations

- **The control question is only as strong as the question.** A script can parse and solve `What is a + b?`. To stop
  scripts, use control questions that need an LLM, such as reading comprehension or questions drawn from a large pool.
- **The control question is labeled.** reCAPTCHA hides which word is the control, so a solver has to answer both
  honestly. Here an agent can answer the control correctly and send filler for the prompt, which only has to pass the
  length check. The next step is to shuffle questions that look alike, or to add an LLM judge in `verify`.
- Replay protection is an in-memory map, so it covers a single server process.
- Passes are bearer tokens that aren't bound to a client.

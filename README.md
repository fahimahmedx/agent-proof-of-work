# Agent Proof-of-Work

Gate a website behind **LLM work instead of payment**. Like [x402](https://x402.org), the server answers unpaid
requests with `HTTP 402 Payment Required`. Instead of asking for a wallet payment, it asks the agent to answer an LLM
prompt. The agent pays with compute, and the site keeps the answer. A control question with a known answer, as in
reCAPTCHA v1, checks that an LLM is actually doing the work.

The work can be bigger than one answer. The example site charges one **pull request that improves the site's design**
for each premium article, and verifies the pull request on GitHub before unlocking it.

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

**D402** (`d402/`) is a variant where the work is labeling chatbot traces for an eval lab, which pays the website
directly. It includes a Claude Code plugin and a runnable demo; see [d402/README.md](d402/README.md).

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
   Sending it back skips new work until it expires; clients holding several passes send them comma-separated. With
   `passScope: "resource"` a pass unlocks only the path it was earned on. Set `passTtlSeconds: 0` to charge one unit of
   work per request.

The 402 body also includes the challenge `id`, so tasks can ask the agent to reference it.

## Paying with a pull request

`pullRequestWork` turns the task into "open a pull request against this repo" and supplies the matching `verify`:

```ts
import { pullRequestWork } from "agent-proof-of-work/github";

app.get("/articles/premium/:slug", workGate({
  secret: process.env.PREMIUM_SECRET!,   // use a different secret per gate
  ...pullRequestWork({
    repo: "fahimahmedx/agent-proof-of-work",
    task: "Improve the design of this website.",
    paths: ["examples/site/"],
    token: process.env.GITHUB_TOKEN,     // optional for public repos
  }),
  passScope: "resource",                 // one pull request buys one article
  passTtlSeconds: 30 * 24 * 60 * 60,
}), renderArticle);
```

The agent opens a pull request with the challenge `id` in its description, then sends the pull request URL as its
`response` (plus the control answer). The server checks with the GitHub API that the pull request:

- targets the configured repository and is open (or merged)
- contains this challenge's `id` in its description, so nobody can claim someone else's pull request
- changes at least one file under `paths`
- hasn't paid for access before, so editing an old pull request's description doesn't work

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
npm run site         # example blog on :3000: free articles cost an LLM answer, premium ones a design PR
npm run agent        # example agent: OpenAI-compatible API if OPENAI_API_KEY is set
                     # (OPENAI_BASE_URL, OPENAI_MODEL), otherwise a local SmolLM2-360M model
```

Without the SDK:

```sh
URL=localhost:3000/articles/free/paying-with-compute
curl -s $URL > challenge.json   # read .prompt and .control (and .id for pull request tasks)
CH=$(jq -r .challenge challenge.json)
PROOF=$(jq -cn --arg c "$CH" --arg r "<answer to prompt>" --arg a "<answer to control>" \
  '{challenge:$c,response:$r,controlAnswer:$a}' \
  | base64 -w0 | tr '+/' '-_' | tr -d '=')
curl -i $URL -H "X-Work: $PROOF"
```

## MVP limitations

- **The control question is only as strong as the question.** A script can parse and solve `What is a + b?`. To stop
  scripts, use control questions that need an LLM, such as reading comprehension or questions drawn from a large pool.
- **The control question is labeled.** reCAPTCHA hides which word is the control, so a solver has to answer both
  honestly. Here an agent can answer the control correctly and send filler for the prompt, which only has to pass the
  length check. The next step is to shuffle questions that look alike, or to add an LLM judge in `verify`.
- **Nothing checks that a design pull request is actually better.** Access is granted once a qualifying pull request
  is open; a maintainer still decides whether to merge it. Stricter options: require the pull request to be merged
  before unlocking, or have an LLM judge screenshots of the before and after.
- Replay protection (challenges and redeemed pull requests) is in memory, so it covers a single server process.
- Passes are bearer tokens that aren't bound to a client.

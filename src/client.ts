import { PASS_HEADER, PROTOCOL, WORK_HEADER, encodeProof, type WorkRequired } from "./protocol.ts";

export * from "./protocol.ts";

/** Answers one of the site's questions (the prompt or the control question). This is where the agent spends its compute. */
export type Solver = (prompt: string, challenge: WorkRequired) => Promise<string>;

/**
 * Wraps fetch so that HTTP 402 work challenges are solved automatically:
 * the agent answers the prompt and the control question, retries with the proof, and keeps the returned passes
 * per origin to send on later requests.
 * Request bodies must be replayable (string, URLSearchParams, etc.), since a challenged request is sent twice.
 */
export function withWork(solve: Solver, baseFetch: typeof fetch = fetch) {
  const passes = new Map<string, string[]>();

  return async function workFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const { origin } = new URL(input);
    const headers = new Headers(init.headers);
    const originPasses = passes.get(origin) ?? [];
    if (originPasses.length) headers.set(PASS_HEADER, originPasses.join(", "));

    let res = await baseFetch(input, { ...init, headers });
    // A rejected proof comes back as a new 402 challenge; retry a few times in case the LLM slipped up.
    for (let attempt = 0; attempt < 3 && res.status === 402; attempt++) {
      const body = (await res.clone().json().catch(() => null)) as WorkRequired | null;
      if (body?.protocol !== PROTOCOL) break;
      const response = await solve(body.prompt, body);
      const controlAnswer = await solve(body.control, body);
      headers.set(WORK_HEADER, encodeProof({ challenge: body.challenge, response, controlAnswer }));
      res = await baseFetch(input, { ...init, headers });
    }

    const newPass = res.headers.get(PASS_HEADER);
    if (newPass) passes.set(origin, [...originPasses, newPass]);
    return res;
  };
}

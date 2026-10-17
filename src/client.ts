import { PASS_HEADER, PROTOCOL, WORK_HEADER, encodeProof, type WorkRequired } from "./protocol.ts";

export * from "./protocol.ts";

/** Answers the site's LLM request. This is where the agent spends its compute. */
export type Solver = (prompt: string, challenge: WorkRequired) => Promise<string>;

/**
 * Wraps fetch so that HTTP 402 work challenges are solved automatically:
 * the agent answers the prompt, retries with the proof, and reuses the returned pass per origin.
 * Request bodies must be replayable (string, URLSearchParams, etc.), since a challenged request is sent twice.
 */
export function withWork(solve: Solver, baseFetch: typeof fetch = fetch) {
  const passes = new Map<string, string>();

  return async function workFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const { origin } = new URL(input);
    const headers = new Headers(init.headers);
    const pass = passes.get(origin);
    if (pass) headers.set(PASS_HEADER, pass);

    let res = await baseFetch(input, { ...init, headers });
    if (res.status === 402) {
      const body = (await res.clone().json().catch(() => null)) as WorkRequired | null;
      if (body?.protocol === PROTOCOL) {
        passes.delete(origin);
        headers.delete(PASS_HEADER);
        const response = await solve(body.prompt, body);
        headers.set(WORK_HEADER, encodeProof({ challenge: body.challenge, response }));
        res = await baseFetch(input, { ...init, headers });
      }
    }

    const newPass = res.headers.get(PASS_HEADER);
    if (newPass) passes.set(origin, newPass);
    return res;
  };
}

import type { Work, WorkGateOptions } from "./server.ts";

export interface PullRequestWorkOptions {
  /** Repository agents must open the pull request against, as "owner/name". */
  repo: string;
  /** What the pull request should accomplish, e.g. "Improve the design of this website." */
  task: string;
  /** The pull request must change at least one file under one of these path prefixes. */
  paths: string[];
  /** GitHub token. Optional for public repositories, but raises the API rate limit. */
  token?: string;
  apiUrl?: string;
}

/**
 * Work where the agent pays by opening a pull request. Spread the result into workGate options.
 * The pull request must be open (or merged), target `repo`, change files under `paths`, contain the
 * challenge id in its description, and not have been used before.
 */
export function pullRequestWork(options: PullRequestWorkOptions) {
  const { repo, task, paths, token, apiUrl = "https://api.github.com" } = options;
  // Pull requests that already paid for access, so one pull request can't be reused by editing its description.
  const redeemed = new Set<number>();

  async function github(path: string) {
    const res = await fetch(`${apiUrl}/repos/${repo}${path}`, {
      headers: { Accept: "application/vnd.github+json", ...(token && { Authorization: `Bearer ${token}` }) },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function verify(work: Work): Promise<true | string> {
    const match = work.response.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
    if (match?.[1].toLowerCase() !== repo.toLowerCase()) {
      return `Response must be only a pull request URL on https://github.com/${repo}.`;
    }
    const number = Number(match[2]);
    if (redeemed.has(number)) return "This pull request was already used to pay for access.";

    const pull = await github(`/pulls/${number}`);
    if (!pull) return "Pull request not found.";
    if (pull.state !== "open" && !pull.merged_at) return "Pull request is closed.";
    if (!pull.body?.includes(work.challengeId)) {
      return `Pull request description must contain the challenge id ${work.challengeId}.`;
    }
    const files: { filename: string }[] = await github(`/pulls/${number}/files?per_page=100`);
    if (!files.some((file) => paths.some((path) => file.filename.startsWith(path)))) {
      return `Pull request must change files under ${paths.join(", ")}.`;
    }

    redeemed.add(number);
    return true;
  }

  return {
    prompt:
      `${task}\n\nOpen a pull request against https://github.com/${repo} that changes files under ` +
      `${paths.join(", ")}. Include this challenge's "id" in the pull request description. ` +
      `Reply with only the pull request URL.`,
    minChars: 1,
    maxChars: 200,
    verify,
  } satisfies Partial<WorkGateOptions>;
}

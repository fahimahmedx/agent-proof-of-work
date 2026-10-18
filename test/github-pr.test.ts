import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { withWork } from "../src/client.ts";
import { pullRequestWork } from "../src/github.ts";
import { WORK_HEADER, encodeProof, workGate } from "../src/server.ts";

const repo = "acme/site";
// Fake GitHub API: pull request number -> { body, files, state }.
const pulls = new Map<number, { body: string; files: string[]; state: string }>();
let nextPull = 1;
const openPull = (body: string, files = ["examples/site/public/styles.css"]) => {
  pulls.set(nextPull, { body, files, state: "open" });
  return `https://github.com/${repo}/pull/${nextPull++}`;
};

let base: string;
const servers: Server[] = [];

const listen = async (server: Server) => {
  if (!server.listening) server.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return `http://localhost:${(server.address() as AddressInfo).port}`;
};

before(async () => {
  const githubApi = await listen(
    createServer((req, res) => {
      const [, number, files] = req.url!.match(new RegExp(`^/repos/${repo}/pulls/(\\d+)(/files)?`)) ?? [];
      const pull = pulls.get(Number(number));
      if (!pull) return void res.writeHead(404).end();
      const body = files ? pull.files.map((filename) => ({ filename })) : { body: pull.body, state: pull.state };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    }),
  );

  const app = express();
  const gate = workGate({
    secret: "test",
    ...pullRequestWork({ repo, task: "Improve the design.", paths: ["examples/site/"], apiUrl: githubApi }),
    passScope: "resource",
  });
  app.get("/premium/:slug", gate, (req, res) => res.send(`article ${req.params.slug}`));
  base = await listen(app.listen(0));
});
after(() => servers.forEach((server) => server.close()));

const add = (question: string) => {
  const [, a, b] = question.match(/What is (\d+) \+ (\d+)\?/)!;
  return String(Number(a) + Number(b));
};

test("an agent pays for one article by opening a pull request", async () => {
  const workFetch = withWork(async (prompt, challenge) =>
    prompt === challenge.control ? add(prompt) : openPull(`Design tweaks. Challenge: ${challenge.id}`),
  );

  const res = await workFetch(`${base}/premium/one`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "article one");

  // The pass unlocks only the article it paid for.
  assert.equal((await workFetch(`${base}/premium/one`)).status, 200);
  assert.equal(pulls.size, 1);
  const other = await fetch(`${base}/premium/two`, { headers: { "X-Work-Pass": res.headers.get("X-Work-Pass")! } });
  assert.equal(other.status, 402);
});

test("rejects pull requests that don't qualify", async () => {
  const attempt = async (makeUrl: (id: string) => string) => {
    const challenge = await (await fetch(`${base}/premium/one`)).json();
    const proof = encodeProof({ challenge: challenge.challenge, response: makeUrl(challenge.id), controlAnswer: add(challenge.control) });
    const res = await fetch(`${base}/premium/one`, { headers: { [WORK_HEADER]: proof } });
    assert.equal(res.status, 402);
    return (await res.json()).error;
  };

  assert.match(await attempt((id) => `https://github.com/other/repo/pull/1 ${id}`), /must be only a pull request URL/);
  assert.match(await attempt(() => openPull("Forgot the challenge id")), /must contain the challenge id/);
  assert.match(await attempt((id) => openPull(id, ["README.md"])), /must change files under examples\/site\//);
  assert.equal(await attempt(() => `https://github.com/${repo}/pull/999`), "Pull request not found.");

  const closed = openPull("");
  pulls.get(Number(closed.split("/").at(-1)))!.state = "closed";
  assert.equal(await attempt(() => closed), "Pull request is closed.");

  // A pull request that already paid can't pay again, even with its description edited to the new challenge id.
  const used = `https://github.com/${repo}/pull/1`;
  assert.equal(
    await attempt((id) => {
      pulls.get(1)!.body = id;
      return used;
    }),
    "This pull request was already used to pay for access.",
  );
});

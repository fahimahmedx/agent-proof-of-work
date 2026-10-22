// Starts the demo website + coordinator and the lab sandbox fixture. Run: npm run d402
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readdirSync } from "node:fs";
import { Coordinator, type LabConfig, type Sponsorship } from "./coordinator.ts";
import { createApp } from "./http.ts";
import { createSandbox } from "./sandbox.ts";

export const FIXTURES_DIR = new URL("../fixtures/tasks/", import.meta.url).pathname;

export interface StartOptions {
  port?: number;
  sandboxPort?: number;
  db?: string;
  secret?: string;
  labApiKey?: string;
  sponsorship?: Omit<Sponsorship, "labId"> | null;
  sandboxDir?: string;
  now?: () => number;
}

const listen = (app: import("express").Express, port: number) =>
  new Promise<Server>((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
const urlOf = (server: Server) => `http://localhost:${(server.address() as AddressInfo).port}`;

export async function startD402(options: StartOptions = {}) {
  const sandboxKey = process.env.D402_SANDBOX_KEY ?? "sandbox-dev-key";
  const sandbox = createSandbox({ dir: options.sandboxDir ?? FIXTURES_DIR, key: sandboxKey });
  const sandboxServer = await listen(sandbox.app, options.sandboxPort ?? 0);
  const sandboxUrl = urlOf(sandboxServer);

  const lab: LabConfig = {
    id: "lab-demo",
    apiKey: options.labApiKey ?? process.env.D402_LAB_API_KEY ?? "lab-dev-key",
    sandboxOrigin: sandboxUrl,
    sandboxPathPrefix: "/tasks/",
    sandboxKey,
  };
  const coordinator = new Coordinator({
    db: options.db ?? ":memory:",
    secret: options.secret ?? process.env.D402_SECRET ?? "d402-dev-secret-change-me",
    siteId: "demo-site",
    labs: [lab],
    now: options.now,
  });
  // The website operator configures the direct sponsorship agreement by hand; D402 never holds the funds.
  if (options.sponsorship !== null) {
    coordinator.configureSponsorship({
      labId: lab.id,
      ...(options.sponsorship ?? { paymentReference: "INV-PILOT-0001", unitPriceCents: 25, units: 100 }),
    });
  }
  const siteServer = await listen(createApp(coordinator), options.port ?? 0);
  const sweeper = setInterval(() => {
    try {
      coordinator.sweep();
    } catch {}
  }, 15_000);
  sweeper.unref();

  return {
    coordinator,
    sandbox,
    lab,
    siteUrl: urlOf(siteServer),
    sandboxUrl,
    async close() {
      clearInterval(sweeper);
      siteServer.closeAllConnections();
      sandboxServer.closeAllConnections();
      await Promise.all([siteServer, sandboxServer].map((s) => new Promise((r) => s.close(r))));
      if (coordinator.db.isOpen) coordinator.db.close();
    },
  };
}

/** The fixture batches, as the lab would enqueue them. */
export function fixtureTasks(sandboxUrl: string) {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      external_id: file.replace(/\.json$/, ""),
      payload_ref: `${sandboxUrl}/tasks/${file}`,
      rubric_version: "review-v1",
    }));
}

if (import.meta.main) {
  const d402 = await startD402({
    port: Number(process.env.PORT ?? 4020),
    sandboxPort: Number(process.env.SANDBOX_PORT ?? 4021),
    db: process.env.D402_DB ?? "d402.sqlite",
    sponsorship: { paymentReference: "INV-PILOT-0001", unitPriceCents: 25, units: Number(process.env.D402_UNITS ?? 100) },
  });
  const enqueued = d402.coordinator.enqueue(d402.lab, fixtureTasks(d402.sandboxUrl));
  console.log(`[d402] website + coordinator on ${d402.siteUrl} (protected page: /article, dashboard: /dashboard)`);
  console.log(`[d402] lab sandbox fixture on ${d402.sandboxUrl}`);
  console.log(`[d402] queued ${enqueued.filter((t) => t.created).length} new fixture tasks (${enqueued.length} total)`);
}

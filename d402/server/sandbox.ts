// Eval lab sandbox fixture: a narrow, read-only HTTP endpoint that serves task JSON to the coordinator.
// Requires the server-side sandbox key. `down` simulates a lab outage.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";

export function createSandbox(options: { dir: string; key: string }) {
  const state = { down: false };
  const app = express();
  app.disable("x-powered-by");
  app.get("/tasks/:file", async (req, res) => {
    if (state.down) return void res.status(503).json({ error: "sandbox unavailable" });
    if (req.get("authorization") !== `Bearer ${options.key}`) return void res.status(401).json({ error: "unauthorized" });
    if (!/^[\w-]+\.json$/.test(req.params.file)) return void res.status(404).end();
    try {
      res.type("json").send(await readFile(join(options.dir, req.params.file)));
    } catch {
      res.status(404).json({ error: "no such task" });
    }
  });
  return { app, state };
}

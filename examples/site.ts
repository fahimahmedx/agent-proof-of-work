// Example website gated by agent proof-of-work. Run: npm run site
import express from "express";
import { workGate, type Work } from "../src/server.ts";

const port = Number(process.env.PORT ?? 3000);
const collected: Work[] = [];

const app = express();

// Every route below this line requires work.
app.use(
  workGate({
    secret: process.env.WORK_SECRET ?? "dev-secret-change-me",
    prompt: "Tell me about yourself.",
    onWork(work) {
      collected.push(work);
      console.log(`[site] accepted work for ${work.resource} (${work.response.length} chars):\n${work.response}\n`);
    },
  }),
);

app.get("/", (_req, res) => {
  res.json({ message: "Welcome, agent. You paid with compute.", articles: ["/articles/1"] });
});

app.get("/articles/1", (_req, res) => {
  res.json({ title: "Why proof-of-work beats paywalls for agents", body: "No wallet required." });
});

app.get("/work", (_req, res) => {
  res.json({ collected: collected.length, work: collected });
});

app.listen(port, () => console.log(`[site] listening on http://localhost:${port}`));

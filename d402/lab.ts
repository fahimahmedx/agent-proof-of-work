// Eval lab adapter: enqueues sandbox task pointers and exports labeling results through the lab API.
// Run: npm run d402:lab -- enqueue | export [after]
import { fixtureTasks } from "./server/main.ts";

export function labClient(siteUrl: string, apiKey: string) {
  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(new URL(path, siteUrl), {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}: ${body.error}`);
    return body;
  }
  return {
    enqueue: (tasks: { external_id: string; payload_ref: string; rubric_version: string }[]) =>
      call("/lab/tasks", { method: "POST", body: JSON.stringify({ tasks }) }),
    exportAttempts: (after = 0) => call(`/lab/attempts?after=${after}`),
  };
}

if (import.meta.main) {
  const lab = labClient(process.env.SITE_URL ?? "http://localhost:4020", process.env.D402_LAB_API_KEY ?? "lab-dev-key");
  const [command, arg] = process.argv.slice(2);
  if (command === "enqueue") {
    console.log(JSON.stringify(await lab.enqueue(fixtureTasks(process.env.SANDBOX_URL ?? "http://localhost:4021")), null, 2));
  } else if (command === "export") {
    console.log(JSON.stringify(await lab.exportAttempts(Number(arg ?? 0)), null, 2));
  } else {
    console.error("Usage: node d402/lab.ts enqueue | export [after]");
    process.exit(1);
  }
}

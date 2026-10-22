// Minimal stdio MCP client used by the demo and tests to drive the plugin's tool server the way Claude Code does.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const TOOL_SERVER = new URL("./plugin/tools/server.ts", import.meta.url).pathname;

export async function connectToolServer(env: Record<string, string>) {
  const child = spawn(process.execPath, [TOOL_SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (msg: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let nextId = 1;
  const rpc = (method: string, params?: object) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d402-demo", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    listTools: async () => (await rpc("tools/list")).tools as { name: string }[],
    async call(name: string, args: object): Promise<any> {
      const result = await rpc("tools/call", { name, arguments: args });
      const text = result.content[0].text;
      if (result.isError) throw new Error(text);
      return JSON.parse(text);
    },
    close: () => child.kill(),
  };
}

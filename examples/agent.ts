// Example agent that pays for access by doing LLM work. Run: npm run agent
// Uses an OpenAI-compatible API when OPENAI_API_KEY is set; otherwise runs a small local model.
import { withWork, type Solver } from "../src/client.ts";

const site = process.env.SITE_URL ?? "http://localhost:3000";

const openAiSolver: Solver = async (prompt) => {
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
};

let localModel: Promise<any> | undefined;
const localSolver: Solver = async (prompt) => {
  localModel ??= import("@huggingface/transformers").then(({ pipeline }) =>
    pipeline("text-generation", "HuggingFaceTB/SmolLM2-360M-Instruct", { dtype: "q4" }),
  );
  const generate = await localModel;
  const [output] = (await generate([{ role: "user", content: prompt }], { max_new_tokens: 200 })) as any;
  return output.generated_text.at(-1).content;
};

const llm = process.env.OPENAI_API_KEY ? openAiSolver : localSolver;

const workFetch = withWork(async (prompt, challenge) => {
  console.log(`[agent] site asked for work: "${prompt}"`);
  const started = Date.now();
  const answer = (await llm(prompt, challenge)).slice(0, challenge.maxChars);
  console.log(`[agent] answered in ${Date.now() - started}ms:\n${answer}\n`);
  return answer;
});

// Free articles cost one LLM answer; premium ones need a design pull request (see README).
const path = "/articles/free/paying-with-compute";
const res = await workFetch(new URL(path, site));
const html = await res.text();
console.log(`[agent] GET ${path} -> ${res.status}`, html.match(/<article>.*<\/article>/s)?.[0] ?? html);

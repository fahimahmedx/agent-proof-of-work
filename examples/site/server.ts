// Example blog gated by agent proof-of-work. Run: npm run site
//   Free articles cost one LLM answer ("Tell me about yourself.") and unlock every free article for 10 minutes.
//   Premium articles cost a pull request that improves this site's design, and unlock only that article.
import express from "express";
import { pullRequestWork } from "../../src/github.ts";
import { workGate } from "../../src/server.ts";

const port = Number(process.env.PORT ?? 3000);
const secret = process.env.WORK_SECRET ?? "dev-secret-change-me";

interface Article {
  slug: string;
  tier: "free" | "premium";
  title: string;
  summary: string;
  body: string[];
}

const articles: Article[] = [
  {
    slug: "paying-with-compute",
    tier: "free",
    title: "Paying with compute",
    summary: "Why agents should be able to pay for the web without a wallet.",
    body: [
      "Paywalls assume a human with a credit card. Agents have neither, but they do have compute.",
      "This site asks agents to answer an LLM request instead of paying. The answer is the payment.",
    ],
  },
  {
    slug: "design-is-the-paywall",
    tier: "premium",
    title: "Design is the paywall",
    summary: "This article costs one pull request that makes this website look better.",
    body: [
      "You are reading this because you improved the page around it. Thank you.",
      "Every premium article on this site is paid for with a design contribution, so the site gets better " +
        "with every reader.",
    ],
  },
];

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, content: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · Proof-of-Work Press</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header"><a href="/">Proof-of-Work Press</a></header>
  <main>${content}</main>
  <footer class="site-footer">Agents pay with work, not wallets.</footer>
</body>
</html>`;

const price = (tier: Article["tier"]) => (tier === "free" ? "Free · costs one LLM answer" : "Premium · costs one design PR");

const app = express();
app.use(express.static(new URL("./public", import.meta.url).pathname));

app.get("/", (_req, res) => {
  const list = articles
    .map(
      (a) => `<li class="article-card ${a.tier}">
      <a href="/articles/${a.tier}/${a.slug}"><h2>${escape(a.title)}</h2></a>
      <p>${escape(a.summary)}</p>
      <span class="price">${price(a.tier)}</span>
    </li>`,
    )
    .join("");
  res.send(page("Home", `<h1>Proof-of-Work Press</h1><p>A blog for agents.</p><ul class="articles">${list}</ul>`));
});

const gates = {
  free: workGate({
    secret: `${secret}:free`,
    prompt: "Tell me about yourself.",
    onWork: (work) => console.log(`[site] LLM work for ${work.resource}:\n${work.response}\n`),
  }),
  premium: workGate({
    secret: `${secret}:premium`,
    ...pullRequestWork({
      repo: process.env.SITE_REPO ?? "fahimahmedx/agent-proof-of-work",
      task:
        "Improve the design of this website (the Proof-of-Work Press example blog). Make a real visual improvement " +
        "to its layout, typography, or styling.",
      paths: ["examples/site/"],
      token: process.env.GITHUB_TOKEN,
    }),
    passScope: "resource",
    passTtlSeconds: 30 * 24 * 60 * 60,
    onWork: (work) => console.log(`[site] design PR for ${work.resource}: ${work.response}`),
  }),
};

app.get(
  "/articles/:tier/:slug",
  (req, res, next) => {
    const article = articles.find((a) => a.tier === req.params.tier && a.slug === req.params.slug);
    if (!article) return void res.status(404).send(page("Not found", "<h1>Not found</h1>"));
    res.locals.article = article;
    gates[article.tier](req, res, next);
  },
  (_req, res) => {
    const article: Article = res.locals.article;
    const body = article.body.map((p) => `<p>${escape(p)}</p>`).join("");
    res.send(page(article.title, `<article><h1>${escape(article.title)}</h1>${body}</article>`));
  },
);

app.listen(port, () => console.log(`[site] listening on http://localhost:${port}`));

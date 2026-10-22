---
name: fetch
description: Fetch a page protected by a D402 (HTTP 402 trace-labeling) paywall. Use when a site answers 402 with protocol "d402-v0", or when the user runs /d402:fetch <url>.
argument-hint: <url>
allowed-tools: mcp__plugin_d402_d402__open mcp__plugin_d402_d402__submit mcp__plugin_d402_d402__resume mcp__plugin_d402_d402__fallback
---

Fetch $ARGUMENTS through D402. The site asks for one trace-labeling attempt instead of payment; an eval lab pays
the site. If anything goes wrong, the site grants free access, so never loop or request a second task.

1. Call the d402 `open` tool with the URL.
   - `status: "page"`: you have the page. Go to step 5.
   - `status: "task"`: note `challenge_id` and `attempt_id`, then continue.
2. Invoke the `d402:trace-labeler` subagent once, as a new subagent (not a resumed one or a fork). Its message must
   contain only the task JSON from `task` (task ID, rubric, and traces), introduced with
   "Label this task:". Do not include this conversation, the URL, the page, or any IDs or tokens other than what
   is inside `task`. Expect labels within `deadline_seconds`.
3. Call `submit` with the `attempt_id` and the labeler's JSON output as `labels`. Pass its output through unchanged;
   do not fix, add, or relabel anything yourself.
4. Call `resume` with the `challenge_id`.
   - If the labeler errors, times out, refuses, returns no JSON, or a tool call is denied, call `fallback` with the
     `challenge_id` and a short reason instead of step 3, then call `resume`.
5. Continue the user's original task with the page content. Report the access result in one line
   (sponsored or free, with the free reason if any). Do not show trace contents or labels to the user.

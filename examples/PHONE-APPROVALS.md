# Approve an AI-proposed refund from your phone, after the worker exits

An agent proposes refunding order `order_1`. Your application saves the exact proposed action, asks its authenticated customer, and ends the worker. When the customer answers, another worker verifies the decision and continues. A denial or expiration cannot execute the refund. A duplicate worker cannot claim the same continuation twice.

Two runnable recipes share the existing SQLite review store. They use different OpenAI continuation mechanisms:

| Application | Save before requesting review | Continue after verification |
| --- | --- | --- |
| Agents SDK, including streaming | Native serialized `RunState` and exact interruption | Restore the original agent graph, approve or reject that interruption, run the saved state |
| Responses API with remote MCP | Response ID, MCP approval request, trusted server/model configuration | Send `mcp_approval_response` for that exact request, chained with `previous_response_id` |

## Run the checks without an account

```bash
git clone https://github.com/Pushary/pushary-openai-agents.git
cd pushary-openai-agents
npm install
npm run build
npm run test:restart
npm run test:stream
npm run test:responses
```

Use Node.js 22.18+ within 22.x or Node.js 24. These checks were run with Node.js 24.3, `@openai/agents@0.16.1` and `openai@7.15.0`. They contact no model, phone, MCP server or payment service. Agents tests use the real SDK, simulated model output, SQLite and fresh processes. Responses tests use the real OpenAI client with simulated HTTP responses. This is not evidence of physical phone delivery.

## 1. Streaming Agents SDK

See [streamed-review.mjs](streamed-review.mjs) and [delayed-review.mjs](delayed-review.mjs). The streaming entry point enables the same start, persist and resume path in every test worker.

```js
const result = await runner.run(agent, input, { stream: true });
for await (const event of result) {
  // Send appropriate events to your UI; streamed text is not permission to act.
}
await result.completed;
// Only now inspect result.interruptions and persist result.state.toString().
```

The protected function uses `needsApproval`. Saving and restoring its state follows the [existing delayed-review recipe](DELAYED-REVIEWS.md), including customer/action binding, atomic claiming and uncertain-execution recovery. Rebuild the original graph and retain the original SDK/code version for pending runs. If using SDK sessions, pass the same session when resuming.

## 2. Responses API MCP approval

Use [responses-review.mjs](responses-review.mjs) alongside [delayed-review-store.mjs](delayed-review-store.mjs). Install `openai` explicitly in your application. A Pushary Partner key, enrolled customer and an authenticated MCP server exposing the bounded `refund` tool are needed for real use.

Your server owns `customerId`, `operationId`, model selection and MCP configuration. The model never supplies the reviewer identity or the trusted server endpoint. The MCP credential must authorize only that customer's permitted actions. The refund arguments are `orderId`, `amount` in EUR cents and `draftVersion`; validate business ownership and limits independently in the MCP server.

Start with MCP `require_approval: 'always'`, `allowed_tools: ['refund']`, `parallel_tool_calls: false`, and `store: true`. Keep the same trusted configuration for the continuation. This example requires stored Responses; it does not implement a stateless or Zero Data Retention alternative.

```js
import OpenAI from 'openai';
import { DatabaseSync } from 'node:sqlite';
import { createReviewStore, openReview } from './delayed-review-store.mjs';
import { saveMcpReview, resumeMcpReview } from './responses-review.mjs';

const openai = new OpenAI(); // OPENAI_API_KEY, server-side only
const store = createReviewStore(new DatabaseSync('reviews.sqlite'));
const pushary = { apiKey: process.env.PUSHARY_API_KEY };
const target = {
  operationId, externalId: customerId,
  framework: 'responses-v1', codeVersion: 'refund-v1',
};
const settings = { model, serverLabel: 'orders', serverUrl: trustedMcpUrl };
const response = await openai.responses.create({
  model: settings.model,
  tools: [{
    type: 'mcp', server_label: settings.serverLabel, server_url: settings.serverUrl,
    authorization: customerMcpToken,
    require_approval: 'always', allowed_tools: ['refund'],
  }],
  input: 'Propose a EUR 48 refund for order_1, draft version 1. Ask for approval before executing.',
  parallel_tool_calls: false,
  store: true,
});
saveMcpReview(store, target, response, settings);
await openReview(pushary, store, operationId);
// End this worker. Your existing job system runs the continuation later.
```

This bounded helper rejects incomplete responses, unexpected servers/tools and multiple approvals. It saves the server's exact approval request, including arguments and request ID, before asking. The API's returned response ID is not interchangeable with an Agents SDK RunState.

In the later worker, reopen the same database, reconstruct the trusted target and clients, and obtain a current MCP credential with the same customer identity and permissions:

```js
const outcome = await resumeMcpReview(pushary, store, target, openai, customerMcpToken);
// pending: schedule another read using your existing queue; don't ask again.
// resumed / duplicate: consume the saved output.
// busy / uncertain: reconcile; do not blindly replay the continuation.
```

The helper rereads the decision using the authenticated Pushary client and checks the exact saved binding. Only `confirm: yes` sends `approve: true`. Denial, expiration and cancellation send `approve: false`. The continuation always requires approval for subsequent MCP calls; inspect the saved output for another `mcp_approval_request` and open a distinct operation for it. A completed response does not prove the remote business action succeeded: inspect tool results and the business receipt.

The OpenAI SDK's automatic retries are disabled for the continuation. A lost connection or incomplete result leaves the operation uncertain. Reconcile the server response and business receipt before any recovery. The remote refund implementation must validate the unchanged draft and enforce idempotency using an authenticated business identity, such as customer + order + refund version. An atomic local claim alone does not make remote side effects exactly once.

MCP tokens are passed at runtime and excluded from the saved snapshot. State, tool output and decision details still contain private customer data: protect the database and configure retention. This SQLite example is for workers sharing one file; use your existing transactional database for distributed workers. Do not assign multiple operation IDs to the same outstanding approval.

## What Pushary contributes

Pushary supplies customer decision delivery and retrieval. OpenAI's approval mechanism suspends the tool; your application and remote service enforce the action boundary. Automatic guardrails, authorization checks and human review are complementary. This integration does not inherit Codex Auto-review, replace sandbox/network boundaries or grant access to restricted models.

References: [OpenAI guardrails and review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals), [Responses MCP approvals](https://developers.openai.com/api/docs/guides/tools-connectors-mcp#approvals), [Agents SDK streaming approvals](https://openai.github.io/openai-agents-js/guides/streaming#human-in-the-loop-while-streaming).

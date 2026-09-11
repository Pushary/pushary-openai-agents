# @pushary/openai-agents

Customer reviews use the native Pushary app first. Confirmations may use notification actions; choices and typed answers open the app. Keep the ask tool for information and the SDK's enforced approval interruptions for permission to execute. Web remains a compatibility option.

[Integration guide](https://pushary.com/human-in-the-loop-openai-agents-sdk?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-openai-agents&utm_content=guide) · [Connect your customer’s phone](https://pushary.com/sign-up?from=agent&plan=partner&utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-openai-agents&utm_content=partner-start) · [Report a problem](https://github.com/Pushary/pushary-openai-agents/issues)

## Try a review before signing up

Use Node.js 22.13 or later:

```bash
git clone https://github.com/Pushary/pushary-openai-agents.git
cd pushary-openai-agents
npm install
npm run build
npm run test:restart
```

No account, API key or model provider is needed. The example uses the real OpenAI Agents SDK and fresh processes to check approvals, denials, expired answers and duplicate workers. Model responses, delivery and refunds are simulated.

[Adapt the saved-state example to your customer](examples/DELAYED-REVIEWS.md). The adapter is MIT-licensed; real phone delivery uses the hosted Pushary service and requires developer Partner access.

[![CI](https://github.com/Pushary/pushary-openai-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/Pushary/pushary-openai-agents/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pushary/openai-agents)](https://www.npmjs.com/package/@pushary/openai-agents)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Approval boundaries

Set `policy: false` when a person must always approve. Bind the recipient to your authenticated customer's identity. The resolver passes complete tool arguments to the shared gate and refuses interruptions without a stable tool-call ID. Exact retries share a review; changed customer or action arguments require a new one.

The resolver is a bounded request-time helper. For delayed answers, persist the framework's run state with the decision ID, customer and exact call arguments, verify the authoritative answer, then resume only that call. Your application owns the atomic resume claim and recovery from uncertain execution. A typed answer is not authorization. Finish old pending operations with their original SDK version before upgrading the approval-key scheme to server SDK 2.1.

## Install

Version `0.4.0` requires server SDK 2.1 and Node.js 22 or later, matching the [OpenAI Agents supported runtimes](https://github.com/openai/openai-agents-js/tree/v0.13.0#supported-environments). The delayed SQLite recipe needs Node.js 22.13 or later. Validation used Node.js 24.3 and `@openai/agents@0.16.0`; the `>=0.13.0` peer range is not a claim that every version was tested.

```bash
npm i @pushary/openai-agents @openai/agents zod
```

Set `PUSHARY_API_KEY` (get it in your [dashboard](https://pushary.com/onboarding/partner)).

## Connect a phone once

```ts
import { connect } from '@pushary/openai-agents'
const { universalLink } = await connect({ apiKey: process.env.PUSHARY_API_KEY! }, user.id)
```

## The tool

```ts
import { Agent, run } from '@openai/agents'
import { pusharyTool } from '@pushary/openai-agents'

const agent = new Agent({
  name: 'Support',
  instructions: 'Ask the customer which order they need help with.',
  tools: [pusharyTool({ apiKey: process.env.PUSHARY_API_KEY! }, { externalId: user.id })],
})

const result = await run(agent, 'Which order needs help?')
```

When the model calls the tool, Pushary delivers the question to that user's phone and
the call blocks until they answer. The tool returns a fail-closed instruction ("The
human declined. Do not proceed."). `externalId` is bound in code, never taken from
model input, so a prompt-injected model cannot ask the wrong person.

## Gating a tool the model cannot skip

`pusharyTool` is a tool the model chooses to call. That is right for "go ask someone
about this", and wrong for "this must not happen without a yes", because a model that
does not want to be interrupted can decline to call it.

The SDK's own gate splits in two: `needsApproval` decides *whether* a human is needed,
and the run then stops with `result.interruptions`. Nothing asks anyone. Resolving
those interruptions is the caller's job, and `resolvePusharyInterruptions` is that job
done:

```ts
import { Agent, run, tool } from '@openai/agents'
import { z } from 'zod'
import { pusharyNeedsApproval, resolvePusharyInterruptions } from '@pushary/openai-agents'

const issueRefund = tool({
  name: 'issue_refund',
  description: 'Refund an order',
  parameters: z.object({ amount: z.number() }),
  needsApproval: pusharyNeedsApproval(),
  execute: async ({ amount }) => chargeBack(amount),
})

let result = await run(agent, 'Refund order 1234')
while (result.interruptions?.length) {
  const outcome = await resolvePusharyInterruptions(
    { externalId: user.id },
    { interruptions: result.interruptions, state: result.state },
  )
  if (!outcome.allApproved) break
  result = await run(agent, result.state)
}
```

Each interruption becomes one decision on the phone, resolved in order so the person
sees one question at a time. A denial is handed back to the model as the rejection
message, so it knows why it was stopped rather than retrying blindly.

Fail-closed: a denial, an expiry, or nobody answering all reject. For a multi-tenant
product, resolve the end-user per interruption:

```ts
resolvePusharyInterruptions(
  { externalId: (item) => ownerOf(item.rawItem.callId) },
  { interruptions: result.interruptions, state: result.state },
)
```

Pass `runId` when you replay a run under ids you mint yourself, so a replay resolves
to the same decisions instead of paging twice.

## Durable approvals

Use the [saved RunState and SQLite reference](examples/DELAYED-REVIEWS.md). It saves native state before delivery, reconciles the authoritative answer, verifies the exact customer/call/arguments, and atomically claims the continuation. Duplicate workers return the saved output; crashed or uncertain execution requires recovery rather than replay.

Run `npm run test:restart` with Node.js 22.13 or later (tested on 24.3). The simulation starts fresh processes and checks delayed approval, denial, expiry, changed state, concurrent workers, subsequent interruptions and persistence failures. It contacts no live API. Examples also ship in the npm artifact.

Your existing job system performs reconciliation; an optional signed callback can wake it after durable receipt. The original agent graph and framework version must remain available to restore `RunState`. The reference covers one protected function-tool interruption per operation, not a general scheduler or deferred text-question runtime.

## Python

A Python port of the blocking tool ships in [`python/`](python) and on PyPI:

```bash
pip install pushary-openai-agents
```

See [python/README.md](python/README.md) for the Python API.

## API

- `connect(config, externalId)` — enroll an end-user's phone.
- `pusharyTool(config, { externalId })` — an OpenAI Agents function tool that blocks on a human.
- `pusharyNeedsApproval()` — a `needsApproval` predicate that routes every call to a human.
- `resolvePusharyInterruptions(config, { interruptions, state })` — ask about each interruption, then approve or reject it on the run state.
- `createDurableDecision(config, input)` — open a decision with a callbackUrl for the durable path.
- `resolvePusharyCallback(raw, signature, secret)` — verify + parse a callback into `{ correlationId, answer, approved, ... }`.
- `createPusharyGate(config)` — the raw fail-closed gate, for anything the helpers above do not cover.
- `askExternalUser`, `describeAnswer`, `isAffirmative`, `deterministicKey`, `SIGNATURE_HEADER`.

## Example

A runnable example is in [`examples/`](examples).

## License

MIT

## Operation identity

Independent blocking asks create separate decisions. For a retry of one operation, pass `idempotencyKey` to `askExternalUser`. `createDurableDecision` requires that key before it can send: derive it from your unique run ID, step and user, never question text alone.

## Check the saved approval path

Run `npm run build` then `node examples/saved-review.mjs`. The real OpenAI Agents runner pauses a protected tool, serializes its state, restores that state, and applies a simulated Pushary answer. Yes executes once; no and unanswered execute zero times. This uses no model API, phone, or payment provider and does not claim physical-device delivery or process-crash recovery.

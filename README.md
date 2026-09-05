# @pushary/openai-agents

[![CI](https://github.com/Pushary/pushary-openai-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/Pushary/pushary-openai-agents/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pushary/openai-agents)](https://www.npmjs.com/package/@pushary/openai-agents)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Full walkthrough: [Human-in-the-loop for the OpenAI Agents SDK](https://pushary.com/human-in-the-loop-openai-agents-sdk?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-openai-agents&utm_content=readme). Reaching your own end-users on their phones is the Pushary [Partner plan](https://pushary.com/human-in-the-loop?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-openai-agents&utm_content=readme).

Human-in-the-loop for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
(TypeScript). A function tool that asks a real human to approve, delivered to their
phone, and blocks on a fail-closed answer.

Requires the Pushary [Partner plan](https://pushary.com/agent-notifications-integration?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-openai-agents&utm_content=readme).

## Install

```bash
npm i @pushary/openai-agents @openai/agents zod
```

Set `PUSHARY_API_KEY` (get it in your [dashboard](https://pushary.com/dashboard/settings)).

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
  instructions: 'Call ask_human before issuing any refund.',
  tools: [pusharyTool({ apiKey: process.env.PUSHARY_API_KEY! }, { externalId: user.id })],
})

const result = await run(agent, 'Refund order 5?')
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

For a wait longer than a request can hold, don't block. Two options:

1. **Native park/resume.** Mark real tools `needsApproval: true`, serialize the run
   state (`result.state.toString()`), and open a Pushary decision per interruption
   with a `callbackUrl`. On the signed callback, `resolvePusharyCallback` gives you the
   answer; approve or reject on the restored state (`RunState.fromString(agent, saved)`)
   and re-`run(agent, state)`. Pin your `@openai/agents` version, as the RunState API is
   pre-1.0.
2. **Webhook-only.** Skip the SDK's park and drive your own flow off
   `createDurableDecision` + `resolvePusharyCallback`.

```ts
import { resolvePusharyCallback } from '@pushary/openai-agents'

// POST /api/pushary/callback
export async function POST(req: Request) {
  const raw = await req.text()
  const cb = resolvePusharyCallback(raw, req.headers.get('x-pushary-signature'), process.env.PUSHARY_WEBHOOK_SECRET!)
  if (!cb) return new Response('bad signature', { status: 401 })
  // look up the parked run by cb.correlationId, then approve/reject and resume
  return new Response('ok')
}
```

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

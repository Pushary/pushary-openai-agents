# @pushary/openai-agents

[![CI](https://github.com/Pushary/pushary-openai-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/Pushary/pushary-openai-agents/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pushary/openai-agents)](https://www.npmjs.com/package/@pushary/openai-agents)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Full walkthrough: [Human-in-the-loop for the OpenAI Agents SDK](https://pushary.com/human-in-the-loop-openai-agents-sdk). Reaching your own end-users on their phones is the Pushary [Partner plan](https://pushary.com/human-in-the-loop).

Human-in-the-loop for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
(TypeScript). A function tool that asks a real human to approve, delivered to their
phone, and blocks on a fail-closed answer.

Requires the Pushary [Partner plan](https://pushary.com/agent-notifications-integration).

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

For Python, use `pip install pushary-openai-agents`.

## API

- `connect(config, externalId)` — enroll an end-user's phone.
- `pusharyTool(config, { externalId })` — an OpenAI Agents function tool that blocks on a human.
- `createDurableDecision(config, input)` — open a decision with a callbackUrl for the durable path.
- `resolvePusharyCallback(raw, signature, secret)` — verify + parse a callback into `{ correlationId, answer, approved, ... }`.
- `askExternalUser`, `describeAnswer`, `isAffirmative`, `deterministicKey`, `SIGNATURE_HEADER`.

## License

MIT

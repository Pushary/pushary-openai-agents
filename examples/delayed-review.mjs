import assert from 'node:assert/strict'
import { Agent, Runner, RunState, Usage, tool } from '@openai/agents'
import { z } from 'zod'
import { decisionFingerprint } from '@pushary/server/adapters'
import { pusharyNeedsApproval } from '../dist/index.js'
import { saveReview } from './delayed-review-store.mjs'
import { runSimulation } from './delayed-simulation.mjs'

const inputSchema = z.object({ orderId: z.string(), amount: z.number().int().positive(), draftVersion: z.number().int().positive() }).strict()
const interruptionSchema = z.object({
  rawItem: z.object({ type: z.literal('function_call'), callId: z.string().min(1), name: z.literal('refund'), arguments: z.string() }),
})
const callOf = interruption => {
  const { rawItem } = interruptionSchema.parse(interruption)
  return { toolCallId: rawItem.callId, toolName: rawItem.name, input: inputSchema.parse(JSON.parse(rawItem.arguments)) }
}
const createAgent = (effect, scenario, resumed) => {
  let generations = 0
  return new Agent({
    name: 'Refund reviewer v1',
    tools: [tool({ name: 'refund', description: 'Simulate a refund after the customer approves.', parameters: inputSchema, needsApproval: pusharyNeedsApproval(), execute: effect })],
    model: {
      async getResponse() {
        const needsCall = generations++ === 0 && (!resumed || scenario === 'next')
        return {
          usage: new Usage(),
          output: needsCall
            ? [{ type: 'function_call', callId: resumed ? 'call_2' : 'call_1', name: 'refund', arguments: JSON.stringify({ orderId: 'order_1', amount: 4800, draftVersion: 1 }) }]
            : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Review continued.' }] }],
        }
      },
      async *getStreamedResponse() { throw new Error('This reference uses non-streaming runs') },
    },
  })
}
const runner = new Runner({ tracingDisabled: true })

await runSimulation(import.meta.url, {
  framework: 'openai-agents@0.16.0',
  async start({ store, target, effect, scenario }) {
    const result = await runner.run(createAgent(effect, scenario, false), 'Refund order_1 only after customer approval.')
    assert.equal(result.interruptions.length, 1, 'This bounded recipe opens one protected call per saved operation')
    saveReview(store, target, result.state.toString(), callOf(result.interruptions[0]))
  },
  async resume({ snapshot, binding, approved, effect, scenario }) {
    const agent = createAgent(effect, scenario, true)
    const state = await RunState.fromString(agent, snapshot)
    const interruptions = state.getInterruptions()
    assert.equal(interruptions.length, 1)
    const interruption = interruptions[0]
    assert.equal(decisionFingerprint(callOf(interruption)), decisionFingerprint(binding.call))
    if (approved) state.approve(interruption)
    else state.reject(interruption, { message: 'The customer declined or the review is no longer answerable.' })
    const result = await runner.run(agent, state)
    return {
      text: result.finalOutput ?? '', snapshot: result.state.toString(),
      history: result.history,
      pending: result.interruptions.map(item => callOf(item)),
    }
  },
})

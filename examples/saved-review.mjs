import assert from 'node:assert/strict'
import { Agent, Runner, RunState, Usage, tool } from '@openai/agents'
import { z } from 'zod'
import { pusharyNeedsApproval, resolvePusharyInterruptions } from '../dist/index.js'

const realFetch = globalThis.fetch
try {
  for (const value of ['yes', 'no', null]) {
    let executions = 0
    let generations = 0
    let reviews = 0
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://simulation.invalid/decisions')
      const body = JSON.parse(init.body)
      assert.equal(body.externalId, 'customer_1')
      assert.deepEqual(body.parameters, { amount: 4800 })
      reviews++
      return Response.json({
        decisionId: 'decision_1', type: 'confirm', value,
        status: value === null ? 'pending' : 'answered', answered: value !== null,
      })
    }
    const model = {
      async getResponse() {
        return {
          usage: new Usage(),
          output: generations++ === 0
            ? [{ type: 'function_call', callId: 'refund_1', name: 'refund', arguments: '{"amount":4800}' }]
            : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Review processed.' }] }],
        }
      },
      async *getStreamedResponse() { throw new Error('This example uses non-streaming runs.') },
    }
    const agent = new Agent({
      name: 'Purchase order reviewer',
      model,
      tools: [tool({
        name: 'refund',
        description: 'Simulate a refund without moving money.',
        parameters: z.object({ amount: z.number().int().positive() }),
        needsApproval: pusharyNeedsApproval(),
        execute: async () => { executions++; return 'Simulated refund completed.' },
      })],
    })
    const runner = new Runner({ tracingDisabled: true })
    const paused = await runner.run(agent, 'Refund the order.')
    assert.equal(paused.interruptions.length, 1)
    assert.equal(executions, 0)
    const restored = await RunState.fromString(agent, paused.state.toString())
    await resolvePusharyInterruptions({
      apiKey: 'pk_demo.sk_demo', baseUrl: 'https://simulation.invalid',
      externalId: 'customer_1', runId: 'order_run_1', policy: false, timeoutMs: 0,
    }, { state: restored, interruptions: restored.getInterruptions() })
    await runner.run(agent, restored)
    assert.equal(reviews, 1)
    assert.equal(executions, value === 'yes' ? 1 : 0)
    console.log(`${value ?? 'unanswered'}: saved approval restored; simulated executions=${executions}`)
  }
} finally {
  globalThis.fetch = realFetch
}

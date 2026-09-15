import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import OpenAI from 'openai'
import { createReviewStore, openReview } from './delayed-review-store.mjs'
import { saveMcpReview, resumeMcpReview } from './responses-review.mjs'

const target = { operationId: 'refund-order-1-v1', externalId: 'customer-1', framework: 'responses-v1', codeVersion: 'refund-v1' }
const settings = { model: 'test-model', serverLabel: 'orders', serverUrl: 'https://orders.example.invalid/mcp' }
const response = { id: 'resp-original', status: 'completed', output: [{ type: 'mcp_approval_request', id: 'approval-original', name: 'refund', server_label: 'orders', arguments: '{"orderId":"order-1","amount":4800,"draftVersion":1}' }] }

test('Responses MCP uses the exact saved request, fails closed, and never retries uncertain execution', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const scenario of ['yes', 'no', 'expired', 'cancelled', 'customer', 'tamper', 'network', 'incomplete']) {
      const db = new DatabaseSync(':memory:')
      try {
        const store = createReviewStore(db)
        const config = { apiKey: 'pk_simulation.sk_simulation', baseUrl: 'https://pushary.example.invalid' }
        let payload, creates = 0, calls = 0, status = 'pending'
        globalThis.fetch = async (url, init) => {
          assert.equal(new URL(String(url)).origin, config.baseUrl)
          if (init?.method === 'POST') {
            creates++; payload = JSON.parse(init.body)
            return Response.json({ decisionId: 'decision-1', status: 'pending', answered: false })
          }
          return Response.json({ decisionId: 'decision-1', externalId: scenario === 'customer' ? 'other-customer' : target.externalId,
            type: 'confirm', question: payload.question, options: null, context: scenario === 'tamper' ? 'changed' : payload.context,
            status, value: status === 'answered' ? (scenario === 'no' ? 'no' : 'yes') : null })
        }
        const client = new OpenAI({ apiKey: 'local-test-not-a-key', baseURL: 'https://openai.example.invalid/v1', fetch: async (url, init) => {
          calls++
          assert.equal(String(url), 'https://openai.example.invalid/v1/responses')
          const body = JSON.parse(init.body)
          assert.equal(body.previous_response_id, response.id)
          assert.deepEqual(body.input, [{ type: 'mcp_approval_response', approval_request_id: 'approval-original', approve: !['no', 'expired', 'cancelled'].includes(scenario) }])
          assert.deepEqual(body.tools[0], { type: 'mcp', server_label: settings.serverLabel, server_url: settings.serverUrl, allowed_tools: ['refund'], require_approval: 'always', authorization: 'runtime-only-test-token' })
          assert.equal(body.parallel_tool_calls, false)
          if (scenario === 'network') throw new Error('Connection lost after possible acceptance')
          return Response.json({ id: 'resp-continued', status: scenario === 'incomplete' ? 'incomplete' : 'completed', output: [] })
        } })
        saveMcpReview(store, target, response, settings)
        saveMcpReview(store, target, response, settings)
        await openReview(config, store, target.operationId)
        await openReview(config, store, target.operationId)
        assert.equal(creates, 1)
        assert.equal(store.get(target.operationId).snapshot.includes('runtime-only-test-token'), false)
        const resume = () => resumeMcpReview(config, store, target, client, 'runtime-only-test-token')
        if (['customer', 'tamper'].includes(scenario)) {
          await assert.rejects(resume, /saved review/); assert.equal(calls, 0); continue
        }
        assert.equal((await resume()).status, 'pending'); assert.equal(calls, 0)
        status = ['expired', 'cancelled'].includes(scenario) ? scenario : 'answered'
        const outcomes = await Promise.all([resume(), resume()])
        assert.equal(calls, 1)
        if (['network', 'incomplete'].includes(scenario)) {
          assert.ok(outcomes.some(item => item.status === 'uncertain'))
          assert.equal((await resume()).status, 'uncertain')
        } else {
          assert.ok(outcomes.some(item => item.status === 'resumed'))
          const replay = await resume()
          assert.equal(replay.status, 'duplicate')
          assert.equal(replay.output.id, 'resp-continued')
        }
        assert.equal(calls, 1)
      } finally { db.close() }
    }
  } finally { globalThis.fetch = originalFetch }
})

test('MCP snapshots reject different servers, tools, multiple approvals and changed arguments', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = createReviewStore(db)
    saveMcpReview(store, target, response, settings)
    const modified = patch => ({ ...response, output: [{ ...response.output[0], ...patch }] })
    for (const candidate of [modified({ server_label: 'other' }), modified({ name: 'delete' }), modified({ arguments: '{}' }),
      modified({ arguments: '{"orderId":"order-1","amount":4900,"draftVersion":1}' }),
      { ...response, status: 'in_progress' }, { ...response, output: [...response.output, ...response.output] }]) {
      assert.throws(() => saveMcpReview(store, target, candidate, settings))
    }
  } finally { db.close() }
})

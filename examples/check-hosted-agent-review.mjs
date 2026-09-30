import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import OpenAI from 'openai'
import { createReviewStore, openReview } from './delayed-review-store.mjs'
import { saveHostedReview, resumeHostedReview } from './hosted-agent-review.mjs'

const target = { operationId: 'refund-order-1-v1', externalId: 'customer-1', framework: 'hosted-agents-v1', codeVersion: 'refund-v1' }
const session = { id: 'session-1', status: 'requires_action', required_actions: [{ type: 'function_call', turn_id: 'turn-1', call_id: 'call-1', name: 'refund', arguments: { orderId: 'order-1', amount: 4800, draftVersion: 1 } }] }

test('hosted approval survives reopening, binds the pending call, and fails closed on ambiguous delivery', async () => {
  const originalFetch = globalThis.fetch
  const directory = mkdtempSync(join(tmpdir(), 'pushary-hosted-'))
  try {
    for (const scenario of ['yes', 'no', 'expired', 'cancelled', 'changed', 'network', 'wrong-customer']) {
      const path = join(directory, scenario + '.sqlite')
      let database = new DatabaseSync(path)
      let store = createReviewStore(database)
      const config = { apiKey: 'pk_simulation.sk_simulation', baseUrl: 'https://pushary.example.invalid' }
      let payload, creates = 0, effects = 0, submissions = 0, status = 'pending'
      globalThis.fetch = async (url, init) => {
        assert.equal(new URL(String(url)).origin, config.baseUrl)
        if (init?.method === 'POST') {
          creates++; payload = JSON.parse(init.body)
          return Response.json({ decisionId: 'decision-1', status: 'pending', answered: false })
        }
        return Response.json({ decisionId: 'decision-1', externalId: scenario === 'wrong-customer' ? 'other' : target.externalId,
          type: 'confirm', question: payload.question, options: null, context: payload.context, status,
          value: status === 'answered' ? (scenario === 'no' ? 'no' : 'yes') : null })
      }
      const openai = new OpenAI({ apiKey: 'local-test-not-a-key', baseURL: 'https://openai.example.invalid/v1', fetch: async (url, init) => {
        const pathname = new URL(String(url)).pathname
        assert.equal(init.headers.get('openai-beta'), 'agents=v1')
        if (init.method === 'GET') {
          assert.equal(pathname, '/v1/agents/sessions/session-1')
          return Response.json(scenario === 'changed' ? { ...session, required_actions: [{ ...session.required_actions[0], call_id: 'changed' }] } : session)
        }
        assert.equal(pathname, '/v1/agents/sessions/session-1/events')
        submissions++
        const result = JSON.parse(init.body).events[0]
        assert.equal(result.type, 'agent.session.input.tool_result')
        assert.equal(result.call_id, 'call-1'); assert.equal(result.turn_id, 'turn-1')
        assert.equal(result.success, ['yes', 'network'].includes(scenario))
        if (scenario === 'network') throw new Error('Connection lost after possible acceptance')
        return new Response(null, { status: 204 })
      } })
      const execute = async (action, operationId) => {
        assert.deepEqual(action, session.required_actions[0].arguments); assert.equal(operationId, target.operationId)
        effects++; return { simulated: true, operationId }
      }
      try {
        saveHostedReview(store, target, session)
        assert.throws(() => saveHostedReview(store, target, { ...session, required_actions: [] }))
        assert.throws(() => saveHostedReview(store, target, { ...session, required_actions: [...session.required_actions, ...session.required_actions] }))
        assert.throws(() => saveHostedReview(store, target, { ...session, required_actions: [{ ...session.required_actions[0], arguments: {} }] }))
        await openReview(config, store, target.operationId)
        database.close(); database = new DatabaseSync(path); store = createReviewStore(database)
        const resume = () => resumeHostedReview(config, store, target, openai, execute)
        if (scenario === 'wrong-customer') { await assert.rejects(resume); continue }
        assert.equal((await resume()).status, 'pending'); assert.equal(effects, 0)
        status = ['expired', 'cancelled'].includes(scenario) ? scenario : 'answered'
        const results = await Promise.all([resume(), resume()])
        const uncertain = ['changed', 'network'].includes(scenario)
        assert.ok(results.some(result => result.status === (uncertain ? 'uncertain' : 'resumed')))
        assert.equal((await resume()).status, uncertain ? 'uncertain' : 'duplicate')
        assert.equal(creates, 1)
        assert.equal(effects, ['yes', 'network'].includes(scenario) ? 1 : 0)
        assert.equal(submissions, scenario === 'changed' ? 0 : 1)
      } finally { database.close() }
    }
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }) }
})

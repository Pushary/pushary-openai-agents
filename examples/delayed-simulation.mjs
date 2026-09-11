import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { z } from 'zod'
import { decisionFingerprint } from '@pushary/server/adapters'
import { createReviewStore, openReview, reconcileReview } from './delayed-review-store.mjs'

export const runSimulation = async (file, adapter) => {
  const [phase, directory, scenario] = process.argv.slice(2)
  if (!phase) {
    console.log('SIMULATION: real framework, SQLite and fresh workers; no live network, phone delivery or money movement.')
    const folder = mkdtempSync(join(tmpdir(), 'pushary-delayed-'))
    const execute = (step, name, expected = 0) => {
      const result = spawnSync(process.execPath, [fileURLToPath(file), step, folder, name], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(result.status, expected, `${name}/${step}: ${result.stdout}\n${result.stderr}`)
      return result.stdout
    }
    for (const name of ['approve', 'deny', 'expired', 'tamper', 'customer', 'changed-state', 'uncertain', 'next', 'persistence']) {
      execute('start', name)
      execute('start', name)
      execute('pending', name)
      execute('answer', name)
      if (name === 'approve') {
        const worker = () => new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [fileURLToPath(file), 'resume', folder, name], { stdio: ['ignore', 'pipe', 'pipe'] })
          let output = ''
          child.stderr.on('data', data => { output += data })
          child.on('error', reject)
          child.on('exit', code => code === 0 ? resolve() : reject(new Error(output)))
        })
        await Promise.all([worker(), worker()])
      } else execute('resume', name, name === 'uncertain' ? 86 : 0)
      execute('verify', name)
      console.log(`${adapter.framework}: ${name} restart/replay checks passed`)
    }
    console.log(`SQLite evidence: ${folder}`)
    return
  }
  z.enum(['start', 'pending', 'answer', 'resume', 'verify']).parse(phase)
  z.string().min(1).parse(directory)
  z.enum(['approve', 'deny', 'expired', 'tamper', 'customer', 'changed-state', 'uncertain', 'next', 'persistence']).parse(scenario)
  const database = new DatabaseSync(join(directory, `${scenario}.sqlite`))
  const store = createReviewStore(database)
  database.exec(`
    CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS effects (operation_id TEXT PRIMARY KEY, calls INTEGER NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL);
  `)
  const config = { apiKey: 'pk_simulation.sk_simulation', baseUrl: 'https://simulation.invalid' }
  const target = { operationId: 'order_1-draft_1', externalId: 'customer_1', framework: adapter.framework, codeVersion: 'refund-v1' }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url))
    assert.equal(parsed.origin, 'https://simulation.invalid', 'Unexpected live network request')
    if (init?.method === 'POST' && parsed.pathname === '/decisions') {
      const body = JSON.parse(init.body)
      assert.equal(body.externalId, target.externalId)
      assert.deepEqual(body.parameters, { orderId: 'order_1', amount: 4800, draftVersion: 1 })
      assert.equal(body.toolTarget, 'order_1')
      assert.equal(body.presentation.label, 'Refund order order_1')
      assert.deepEqual(body.presentation.changes[0], { parameter: 'amount', label: 'Refund amount', format: { kind: 'currency', currency: 'EUR' } })
      assert.equal(body.context, decisionFingerprint(store.get(target.operationId).binding))
      const decisionId = `decision_${body.idempotencyKey}`
      const payload = JSON.stringify({ ...body, decisionId, status: 'pending', answered: false, value: null, externalId: null, options: null })
      database.prepare('INSERT OR IGNORE INTO decisions VALUES (?, ?, ?)').run(decisionId, body.idempotencyKey, payload)
      return new Response(database.prepare('SELECT payload FROM decisions WHERE id = ?').get(decisionId).payload)
    }
    assert.equal(init?.method, 'GET')
    const row = database.prepare('SELECT payload FROM decisions WHERE id = ?').get(parsed.pathname.split('/').at(-1))
    assert.ok(row, 'Unknown authoritative decision')
    return new Response(row.payload)
  }
  const effect = async input => {
    assert.deepEqual(input, { orderId: 'order_1', amount: 4800, draftVersion: 1 })
    const inputHash = decisionFingerprint(input)
    const result = { simulated: true, orderId: input.orderId, amount: input.amount }
    const receipt = database.prepare('INSERT INTO effects VALUES (?, 1, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET calls = calls + 1 RETURNING input_hash, result').get(target.operationId, inputHash, JSON.stringify(result))
    assert.equal(receipt.input_hash, inputHash, 'An existing business operation cannot change its input')
    if (scenario === 'uncertain') process.exit(86)
    return JSON.parse(receipt.result)
  }
  const reconcile = () => reconcileReview(config, store, scenario === 'customer' ? { ...target, externalId: 'other_customer' } : target,
    (snapshot, binding, approved) => adapter.resume({ snapshot, binding, approved, effect, scenario }))
  try {
    if (phase === 'start') {
      if (!store.get(target.operationId)) await adapter.start({ store, target, effect, scenario })
      await openReview(config, store, target.operationId)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM decisions').get().count, 1)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM effects').get().count, 0)
    } else if (phase === 'pending') {
      const result = await reconcileReview(config, store, target, () => { throw new Error('A pending answer resumed execution') })
      assert.equal(result.status, 'pending')
    } else if (phase === 'answer') {
      const row = database.prepare('SELECT id, payload FROM decisions').get()
      const decision = { ...JSON.parse(row.payload), status: scenario === 'expired' ? 'expired' : 'answered', value: scenario === 'deny' ? 'no' : 'yes' }
      if (scenario === 'tamper') decision.context = '{}'
      database.prepare('UPDATE decisions SET payload = ? WHERE id = ?').run(JSON.stringify(decision), row.id)
      if (scenario === 'changed-state') database.prepare("UPDATE reviews SET snapshot = '[]'").run()
    } else if (phase === 'resume') {
      if (['tamper', 'customer', 'changed-state'].includes(scenario)) await assert.rejects(reconcile)
      else {
        if (scenario === 'persistence') {
          store.complete = () => { throw new Error('Simulated completion-write failure') }
          store.uncertain = () => { throw new Error('Simulated uncertainty-write failure') }
        }
        const result = await reconcile()
        if (scenario === 'persistence') {
          assert.equal(result.status, 'uncertain')
          assert.equal(result.output.text, 'Review continued.')
          assert.ok(result.persistenceError)
        } else assert.ok(['resumed', 'duplicate', 'busy'].includes(result.status))
      }
    } else {
      const expectedEffects = ['approve', 'uncertain', 'next', 'persistence'].includes(scenario) ? 1 : 0
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM effects').get().count, expectedEffects)
      assert.equal(database.prepare('SELECT COALESCE(SUM(calls), 0) AS calls FROM effects').get().calls, expectedEffects, 'Duplicate delivery must not invoke the action again')
      if (['tamper', 'customer', 'changed-state'].includes(scenario)) await assert.rejects(reconcile)
      else {
        const result = await reconcile()
        if (scenario === 'uncertain' || scenario === 'persistence') assert.equal(result.status, 'busy')
        else {
          assert.equal(result.status, 'duplicate')
          assert.equal(result.output.text, scenario === 'next' ? '' : 'Review continued.')
          assert.equal(result.output.pending.length, scenario === 'next' ? 1 : 0)
          assert.ok(result.output.snapshot)
        }
      }
    }
  } finally {
    globalThis.fetch = realFetch
    database.close()
  }
}

import { z } from 'zod'
import { createAdapterKernel, decisionFingerprint } from '@pushary/server/adapters'

const id = z.string().min(1).refine(value => value.trim().length > 0)
const callSchema = z.object({ toolCallId: id, toolName: id, input: z.unknown(), approvalId: id.optional() }).strict()
const bindingSchema = z.object({
  version: z.literal(1), framework: id, codeVersion: id, operationId: id,
  externalId: id.refine(value => value.length <= 256), call: callSchema, snapshotHash: id,
}).strict()
const rowSchema = z.object({
  binding: z.string(), snapshot: z.string(), decision_id: z.string().nullable(),
  state: z.enum(['pending', 'resuming', 'completed', 'uncertain']), output: z.string().nullable(),
})
const decisionSchema = z.object({
  decisionId: id, externalId: z.string().nullable(), type: z.literal('confirm'),
  question: z.string(), options: z.array(z.string()).nullable(), context: z.string(),
  status: z.enum(['pending', 'answered', 'expired', 'cancelled']), value: z.string().nullable(),
})
const kernel = createAdapterKernel('the delayed review example')

export const createReviewStore = database => {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS reviews (
      operation_id TEXT PRIMARY KEY, binding TEXT NOT NULL, snapshot TEXT NOT NULL,
      decision_id TEXT, state TEXT NOT NULL DEFAULT 'pending', output TEXT, error TEXT
    );
  `)
  const get = operationId => {
    const raw = database.prepare('SELECT binding, snapshot, decision_id, state, output FROM reviews WHERE operation_id = ?').get(operationId)
    if (!raw) return null
    const row = rowSchema.parse(raw)
    const binding = bindingSchema.parse(JSON.parse(row.binding))
    if (binding.operationId !== operationId || binding.snapshotHash !== decisionFingerprint(row.snapshot)) throw new Error('Saved review state changed')
    return { ...row, binding, output: row.output === null ? null : JSON.parse(row.output) }
  }
  return {
    get,
    save(binding, snapshot) {
      const parsed = bindingSchema.parse(binding)
      const encoded = JSON.stringify(parsed)
      database.prepare('INSERT OR IGNORE INTO reviews (operation_id, binding, snapshot) VALUES (?, ?, ?)').run(parsed.operationId, encoded, snapshot)
      const existing = get(parsed.operationId)
      if (JSON.stringify(existing.binding) !== encoded || existing.snapshot !== snapshot) throw new Error('Conflicting review identity')
      return existing
    },
    attach(operationId, decisionId) {
      id.parse(decisionId)
      const result = database.prepare('UPDATE reviews SET decision_id = ? WHERE operation_id = ? AND (decision_id IS NULL OR decision_id = ?)').run(decisionId, operationId, decisionId)
      if (result.changes !== 1) throw new Error('Conflicting decision identity')
    },
    claim(operationId) {
      return database.prepare("UPDATE reviews SET state = 'resuming' WHERE operation_id = ? AND state = 'pending'").run(operationId).changes === 1
    },
    complete(operationId, output) {
      const serialized = JSON.stringify(output)
      if (serialized === undefined) throw new Error('Missing continuation output')
      const result = database.prepare("UPDATE reviews SET state = 'completed', output = ? WHERE operation_id = ? AND state = 'resuming'").run(serialized, operationId)
      if (result.changes !== 1) throw new Error('Review is no longer claimed')
    },
    uncertain(operationId, reason) {
      const result = database.prepare("UPDATE reviews SET state = 'uncertain', error = ? WHERE operation_id = ? AND state = 'resuming'").run(reason, operationId)
      if (result.changes !== 1) throw new Error('Review is no longer claimed')
    },
  }
}

export const saveReview = (store, target, snapshot, call) => store.save(bindingSchema.parse({
  version: 1, ...target, call, snapshotHash: decisionFingerprint(snapshot),
}), snapshot)

const reviewRequest = binding => {
  const input = z.object({ orderId: id, amount: z.number().int().nonnegative(), draftVersion: z.number().int().positive() }).strict().parse(binding.call.input)
  return {
    externalId: binding.externalId,
    type: 'confirm',
    question: z.string().max(500).parse(`Approve ${binding.call.toolName}?`),
    context: decisionFingerprint(binding),
    toolName: binding.call.toolName,
    toolTarget: input.orderId,
    parameters: input,
    presentation: {
      label: `Refund order ${input.orderId}`,
      effect: 'Returns the reviewed amount to the customer.',
      changes: [
        { parameter: 'amount', label: 'Refund amount', format: { kind: 'currency', currency: 'EUR' } },
        { parameter: 'orderId', label: 'Order', format: { kind: 'text' } },
        { parameter: 'draftVersion', label: 'Draft version', format: { kind: 'quantity' } },
      ],
    },
    node: z.string().max(100).parse(binding.call.toolName),
    idempotencyKey: decisionFingerprint(binding),
    expiresInSeconds: 3600,
    requireReachable: true,
  }
}

export const openReview = async (config, store, operationId) => {
  const row = store.get(operationId)
  if (!row) throw new Error('Persist the native paused state before opening a review')
  if (row.decision_id) return row.decision_id
  const created = await kernel.createDurableDecision(config, reviewRequest(row.binding))
  store.attach(operationId, created.decisionId)
  return created.decisionId
}

export const reconcileReview = async (config, store, target, resume) => {
  const row = store.get(target.operationId)
  if (!row) throw new Error('Unknown review')
  if (row.binding.externalId !== target.externalId || row.binding.framework !== target.framework || row.binding.codeVersion !== target.codeVersion) throw new Error('Wrong customer or incompatible application version')
  if (row.state === 'completed') return { status: 'duplicate', output: row.output }
  if (row.state !== 'pending') return { status: row.state === 'resuming' ? 'busy' : 'uncertain' }
  const decisionId = await openReview(config, store, target.operationId)
  const request = reviewRequest(row.binding)
  const decision = decisionSchema.parse(await kernel.client(config).decisions.get(decisionId))
  if (decision.decisionId !== decisionId || (decision.externalId !== null && decision.externalId !== target.externalId) || decision.question !== request.question || decision.context !== request.context || (decision.options?.length ?? 0) !== 0) throw new Error('Decision does not match the saved review')
  if (decision.status === 'pending') return { status: 'pending' }
  if (decision.status === 'answered' && decision.value !== 'yes' && decision.value !== 'no') throw new Error('Invalid confirmation answer')
  if (!store.claim(target.operationId)) {
    const current = store.get(target.operationId)
    return current.state === 'completed' ? { status: 'duplicate', output: current.output } : { status: 'busy' }
  }
  let output
  try {
    output = await resume(row.snapshot, row.binding, decision.status === 'answered' && decision.value === 'yes')
    store.complete(target.operationId, output)
    return { status: 'resumed', output }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try {
      store.uncertain(target.operationId, reason)
      return { status: 'uncertain', reason, output }
    } catch (persistenceError) {
      return { status: 'uncertain', reason, output, persistenceError: String(persistenceError) }
    }
  }
}

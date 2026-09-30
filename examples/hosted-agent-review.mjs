import { z } from 'zod'
import { decisionFingerprint } from '@pushary/server/adapters'
import { saveReview, reconcileReview } from './delayed-review-store.mjs'

const id = z.string().min(1)
const input = z.object({ orderId: id, amount: z.number().int().positive(), draftVersion: z.number().int().positive() }).strict()
const action = z.object({ type: z.literal('function_call'), turn_id: id, call_id: id, name: z.literal('refund'), arguments: input })
const session = z.object({ id, status: z.literal('requires_action'), required_actions: z.array(action).length(1) })
const snapshotSchema = z.object({ sessionId: id, action }).strict()
const callOf = pending => ({ toolCallId: pending.call_id, toolName: pending.name, input: pending.arguments })

export const saveHostedReview = (store, target, retrievedSession) => {
  const parsed = session.parse(retrievedSession)
  const pending = parsed.required_actions[0]
  return saveReview(store, target, JSON.stringify({ sessionId: parsed.id, action: pending }), callOf(pending))
}

export const resumeHostedReview = (config, store, target, openai, executeRefund) => reconcileReview(config, store, target, async (serialized, binding, approved) => {
  const snapshot = snapshotSchema.parse(JSON.parse(serialized))
  if (decisionFingerprint(callOf(snapshot.action)) !== decisionFingerprint(binding.call)) throw new Error('Saved function call changed')
  const current = session.parse(await openai.beta.agents.sessions.retrieve(snapshot.sessionId))
  if (current.id !== snapshot.sessionId || decisionFingerprint(current.required_actions[0]) !== decisionFingerprint(snapshot.action)) throw new Error('Pending hosted action changed')
  const output = approved ? await executeRefund(input.parse(binding.call.input), binding.operationId) : { approved: false, reason: 'Human approval was not granted' }
  const serializedOutput = JSON.stringify(output)
  if (serializedOutput === undefined) throw new Error('Missing refund result')
  await openai.beta.agents.sessions.events.create(snapshot.sessionId, {
    events: [{ type: 'agent.session.input.tool_result', turn_id: snapshot.action.turn_id, call_id: snapshot.action.call_id,
      success: approved, output: serializedOutput, ...(approved ? {} : { error: 'Human approval was not granted' }) }],
  }, { maxRetries: 0 })
  return { sessionId: snapshot.sessionId, callId: snapshot.action.call_id, approved, output }
})

import { z } from 'zod'
import { decisionFingerprint } from '@pushary/server/adapters'
import { saveReview, reconcileReview } from './delayed-review-store.mjs'

const id = z.string().min(1)
const action = z.object({ orderId: id, amount: z.number().int().positive(), draftVersion: z.number().int().positive() }).strict()
const approval = z.object({ type: z.literal('mcp_approval_request'), id, name: z.literal('refund'), server_label: id, arguments: z.string() })
const settings = z.object({ model: id, serverLabel: id, serverUrl: z.url().refine(url => new URL(url).protocol === 'https:') }).strict()
const snapshotSchema = z.object({ responseId: id, request: approval, settings }).strict()
const callOf = request => ({ toolCallId: request.id, approvalId: request.id, toolName: request.name, input: action.parse(JSON.parse(request.arguments)) })

// Only call with a response received by your server and settings owned by your app.
// This bounded recipe handles one outstanding refund approval per response.
export const saveMcpReview = (store, target, response, trustedSettings) => {
  const config = settings.parse(trustedSettings)
  if (response.status !== 'completed' || !Array.isArray(response.output)) throw new Error('Wait for a completed Responses result')
  const requests = response.output.filter(item => item.type === 'mcp_approval_request')
  if (requests.length !== 1 || response.output.some(item => ['function_call', 'mcp_call'].includes(item.type))) throw new Error('Expected one unexecuted MCP approval')
  const request = approval.parse(requests[0])
  if (request.server_label !== config.serverLabel) throw new Error('Unexpected MCP server')
  const snapshot = snapshotSchema.parse({ responseId: response.id, request, settings: config })
  return saveReview(store, target, JSON.stringify(snapshot), callOf(request))
}

export const resumeMcpReview = (config, store, target, openai, authorization) => reconcileReview(config, store, target, async (serialized, binding, approved) => {
  const snapshot = snapshotSchema.parse(JSON.parse(serialized))
  if (snapshot.request.server_label !== snapshot.settings.serverLabel || decisionFingerprint(callOf(snapshot.request)) !== decisionFingerprint(binding.call)) throw new Error('Saved MCP request changed')
  const response = await openai.responses.create({
    model: snapshot.settings.model,
    previous_response_id: snapshot.responseId,
    tools: [{ type: 'mcp', server_label: snapshot.settings.serverLabel, server_url: snapshot.settings.serverUrl,
      allowed_tools: ['refund'], require_approval: 'always', ...(authorization ? { authorization } : {}) }],
    input: [{ type: 'mcp_approval_response', approval_request_id: snapshot.request.id, approve: approved }],
    parallel_tool_calls: false,
    store: true,
  }, { maxRetries: 0 })
  // A transport error or incomplete response leaves an uncertain claim, never a retry.
  if (response.status !== 'completed') throw new Error('Continuation did not complete; reconcile before retrying')
  return response
})

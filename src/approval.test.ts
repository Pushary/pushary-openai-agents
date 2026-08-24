import { describe, it, expect, afterEach } from 'vitest'
import {
  pusharyNeedsApproval,
  resolvePusharyInterruptions,
  type AgentInterruption,
  type AgentRunState,
} from './approval'

interface Recorded {
  readonly body: Record<string, unknown> | undefined
}
type Responder = () => unknown

// What POST /authorize answers. The gate asks policy before it asks a person; this
// suite is about the framework binding, so the default verdict is the one that
// still reaches a human.
const REQUIRES_HUMAN = {
  verdict: 'requires_human',
  policy: null,
  reason: 'No policy rule names this action, so a person decides.',
  authorizationId: null,
}

const realFetch = globalThis.fetch
// The policy hop is answered but not recorded, so `calls` keeps meaning "the
// decisions this adapter opened" and every assertion below reads as it did before
// the gate consulted policy.
const installFetch = (
  responders: readonly Responder[],
  evaluation: unknown = REQUIRES_HUMAN,
): Recorded[] => {
  const calls: Recorded[] = []
  let i = 0
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    if (String(input).endsWith('/authorize')) {
      return { ok: true, status: 200, json: async () => evaluation } as Response
    }
    calls.push({ body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined })
    const json = responders[Math.min(i, responders.length - 1)]()
    i += 1
    return { ok: true, status: 200, json: async () => json } as Response
  }) as typeof fetch
  return calls
}

const ALLOWED = {
  verdict: 'allow',
  policy: 'issue_refund',
  reason: 'Allowed by policy rule issue_refund.',
  authorizationId: 'az_1',
}
afterEach(() => {
  globalThis.fetch = realFetch
})

const CONFIG = {
  apiKey: 'pk_x.sk_y',
  baseUrl: 'https://pushary.com/api/v1/server',
  timeoutMs: 0,
  externalId: 'user_1',
}

const answered = (value: string) => () => ({
  decisionId: 'd1',
  status: 'answered',
  answered: true,
  value,
  type: 'confirm',
})
const unanswered = () => ({
  decisionId: 'd1',
  status: 'pending',
  answered: false,
  value: null,
  type: 'confirm',
})

const interruption = (over: Partial<AgentInterruption['rawItem']> = {}): AgentInterruption => ({
  type: 'tool_approval_item',
  rawItem: {
    callId: 'call_1',
    name: 'issue_refund',
    arguments: '{"amount":480}',
    ...over,
  },
})

interface Recording extends AgentRunState<AgentInterruption> {
  readonly approved: AgentInterruption[]
  readonly rejected: { item: AgentInterruption; message?: string }[]
}
const recordingState = (): Recording => {
  const approved: AgentInterruption[] = []
  const rejected: { item: AgentInterruption; message?: string }[] = []
  return {
    approved,
    rejected,
    approve: (item) => void approved.push(item),
    reject: (item, options) => void rejected.push({ item, message: options?.message }),
  }
}

describe('pusharyNeedsApproval', () => {
  it('routes every call to a human', async () => {
    expect(await pusharyNeedsApproval()()).toBe(true)
  })
})

describe('resolvePusharyInterruptions', () => {
  it('approves the run state when the human says yes', async () => {
    installFetch([answered('yes')])
    const state = recordingState()
    const outcome = await resolvePusharyInterruptions(CONFIG, {
      interruptions: [interruption()],
      state,
    })
    expect(state.approved).toHaveLength(1)
    expect(state.rejected).toHaveLength(0)
    expect(outcome.allApproved).toBe(true)
    expect(outcome.resolved[0]).toMatchObject({ toolName: 'issue_refund', approved: true })
  })

  it('approves the run state without opening a decision when a rule allows it', async () => {
    const calls = installFetch([answered('yes')], ALLOWED)
    const state = recordingState()
    const outcome = await resolvePusharyInterruptions(CONFIG, {
      interruptions: [interruption()],
      state,
    })
    expect(state.approved).toHaveLength(1)
    expect(outcome.allApproved).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('rejects with the reason when the human says no', async () => {
    installFetch([answered('no')])
    const state = recordingState()
    const outcome = await resolvePusharyInterruptions(CONFIG, {
      interruptions: [interruption()],
      state,
    })
    expect(state.approved).toHaveLength(0)
    expect(state.rejected[0]?.message).toContain('denied')
    expect(outcome.allApproved).toBe(false)
  })

  it('fails closed when nobody answers', async () => {
    installFetch([unanswered])
    const state = recordingState()
    const outcome = await resolvePusharyInterruptions(CONFIG, {
      interruptions: [interruption()],
      state,
    })
    expect(state.rejected).toHaveLength(1)
    expect(outcome.allApproved).toBe(false)
    expect(outcome.resolved[0]?.reason).toContain('No answer')
  })

  it('puts the tool arguments in the question so the approver sees the amount', async () => {
    const calls = installFetch([answered('yes')])
    await resolvePusharyInterruptions(CONFIG, { interruptions: [interruption()], state: recordingState() })
    expect(String(calls[0]?.body?.question)).toContain('480')
  })

  it('still asks when the model produced unparsable arguments', async () => {
    const calls = installFetch([answered('yes')])
    await resolvePusharyInterruptions(CONFIG, {
      interruptions: [interruption({ arguments: '{not json' })],
      state: recordingState(),
    })
    expect(String(calls[0]?.body?.question)).toContain('{not json')
  })

  it('resolves each interruption against its own decision', async () => {
    const calls = installFetch([answered('yes'), answered('no')])
    const state = recordingState()
    const outcome = await resolvePusharyInterruptions(CONFIG, {
      interruptions: [
        interruption({ callId: 'call_1', name: 'issue_refund' }),
        interruption({ callId: 'call_2', name: 'delete_account' }),
      ],
      state,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body?.idempotencyKey).not.toBe(calls[1]?.body?.idempotencyKey)
    expect(state.approved).toHaveLength(1)
    expect(state.rejected).toHaveLength(1)
    expect(outcome.allApproved).toBe(false)
  })

  it('lets externalId be resolved per interruption for a multi-tenant product', async () => {
    const calls = installFetch([answered('yes')])
    await resolvePusharyInterruptions(
      { ...CONFIG, externalId: (item) => `tenant:${item.rawItem.name}` },
      { interruptions: [interruption()], state: recordingState() },
    )
    expect(calls[0]?.body?.externalId).toBe('tenant:issue_refund')
  })

  it('does nothing when the run stopped for some other reason', async () => {
    const calls = installFetch([answered('yes')])
    const outcome = await resolvePusharyInterruptions(CONFIG, {
      interruptions: undefined,
      state: recordingState(),
    })
    expect(calls).toHaveLength(0)
    expect(outcome.resolved).toHaveLength(0)
    expect(outcome.allApproved).toBe(true)
  })
})

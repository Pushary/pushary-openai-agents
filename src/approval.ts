// The enforced gate. Unlike eve or the AI SDK, `@openai/agents` splits approval in
// two: `needsApproval` is a predicate that only decides whether a human is needed,
// and the run then STOPS with `result.interruptions`. Nothing asks anyone. The ask
// and the resume are the caller's job, which is what this module does.
//
// Nothing here imports a type from `@openai/agents`. The shapes below are the parts
// of `RunToolApprovalItem` and `RunState` this needs, so the `>=0.13.0` peer floor
// stays honest across the SDK's frequent type churn.

import { createPusharyGate, requirePusharyExternalId } from './core'
import { renderApprovalQuestion, type PusharyGateConfig } from '@pushary/server/adapters'

/** The part of an OpenAI Agents interruption this module reads. */
export interface AgentInterruption {
  readonly type: 'tool_approval_item'
  readonly rawItem: {
    readonly callId?: string
    readonly name?: string
    readonly arguments?: string
  }
  readonly toolName?: string
}

/** The part of `RunState` this module drives. */
export interface AgentRunState<TItem> {
  approve(item: TItem, options?: { alwaysApprove?: boolean }): void
  reject(item: TItem, options?: { alwaysReject?: boolean; message?: string }): void
}

/** Resolves a value from one interruption. */
export type InterruptionResolver<TValue> = (interruption: AgentInterruption) => TValue

export interface PusharyInterruptionConfig extends PusharyGateConfig {
  /**
   * The enrolled end-user who decides. A string binds every interruption to one
   * person; a resolver picks one per interruption.
   */
  readonly externalId: string | InterruptionResolver<string | undefined>
  /** Builds the question the human sees. Defaults to the tool name plus its arguments. */
  readonly question?: InterruptionResolver<string>
  /**
   * Groups one run's interruptions for idempotency, so a replayed run resolves to
   * the same decisions instead of paging twice. Defaults to `''`.
   */
  readonly runId?: string
}

/** What one interruption resolved to. */
export interface ResolvedInterruption {
  readonly toolName: string
  readonly callId: string
  readonly approved: boolean
  /** Why it was denied. Absent on an approval. */
  readonly reason?: string
}

export interface InterruptionOutcome {
  readonly resolved: readonly ResolvedInterruption[]
  /** True when every interruption was approved, so the run is safe to continue. */
  readonly allApproved: boolean
}

const toolNameOf = (interruption: AgentInterruption): string =>
  interruption.toolName ?? interruption.rawItem.name ?? 'tool'

const argumentsOf = (interruption: AgentInterruption): unknown => {
  const raw = interruption.rawItem.arguments
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // The SDK hands arguments through as the model produced them, so an unparsable
    // string is still the most honest thing to show the approver.
    return raw
  }
}

/**
 * A `needsApproval` predicate that always routes the call to a human.
 *
 * The SDK's own type is `(runContext, input, callId?) => Promise<boolean>`; this is
 * the constant `true` case, named so a tool definition reads as intent:
 *
 * ```ts
 * tool({ name: 'issue_refund', needsApproval: pusharyNeedsApproval(), ... })
 * ```
 *
 * The ask itself happens in {@link resolvePusharyInterruptions} after the run stops.
 */
export const pusharyNeedsApproval = (): (() => Promise<boolean>) => async () => true

/**
 * Ask a real person about every tool call the run stopped on, then approve or reject
 * each one on the run state. Fails closed: a decline, an expiry, or nobody answering
 * all reject, with the reason handed to the model.
 *
 * ```ts
 * let result = await run(agent, 'Refund order 1234')
 * while (result.interruptions?.length) {
 *   await resolvePusharyInterruptions(
 *     { externalId: user.id },
 *     { interruptions: result.interruptions, state: result.state },
 *   )
 *   result = await run(agent, result.state)
 * }
 * ```
 *
 * Interruptions are resolved one at a time, in order, so a person answering on a
 * phone sees one question at a time rather than a burst of them.
 */
export const resolvePusharyInterruptions = async <TItem extends AgentInterruption>(
  config: PusharyInterruptionConfig,
  run: {
    readonly interruptions: readonly TItem[] | undefined
    readonly state: AgentRunState<TItem>
  },
): Promise<InterruptionOutcome> => {
  const gate = createPusharyGate(config)
  const buildQuestion =
    config.question ??
    ((item: AgentInterruption) => renderApprovalQuestion(toolNameOf(item), argumentsOf(item)))
  const resolved: ResolvedInterruption[] = []

  for (const interruption of run.interruptions ?? []) {
    const toolName = toolNameOf(interruption)
    const callId = interruption.rawItem.callId ?? toolName
    const configured =
      typeof config.externalId === 'function'
        ? config.externalId(interruption)
        : config.externalId

    const decision = await gate({
      toolName,
      callId,
      sessionId: config.runId ?? '',
      question: buildQuestion(interruption),
      externalId: requirePusharyExternalId(configured),
    })

    if (decision.approved) {
      run.state.approve(interruption)
      resolved.push({ toolName, callId, approved: true })
    } else {
      run.state.reject(interruption, { message: decision.reason })
      resolved.push({ toolName, callId, approved: false, reason: decision.reason })
    }
  }

  return { resolved, allApproved: resolved.every((item) => item.approved) }
}

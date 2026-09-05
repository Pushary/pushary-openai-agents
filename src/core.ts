// Framework-free core for @pushary/openai-agents. No @openai/agents imports here, so
// it unit-tests without the framework. Everything below is the shared kernel from
// `@pushary/server/adapters`, bound to this adapter's name; the tool() and approval
// bindings live in index.ts and approval.ts.

import {
  createAdapterKernel,
  type AskHumanInput,
  type PusharyAdapterConfig,
} from '@pushary/server/adapters'
import type { AskResult, DecisionType } from '@pushary/server'

export {
  SIGNATURE_HEADER,
  verifyWebhookSignature,
  parseDecisionCallback,
  deterministicKey,
  describeAnswer,
  isAffirmative,
  idempotencyKeyFor,
  resolvePusharyCallback,
} from '@pushary/server/adapters'

export type {
  AskHumanInput,
  CreatedDecision,
  PusharyCallback,
  PusharyAdapterConfig,
  ApprovalAsk,
  ApprovalDecision,
  ApprovalGate,
  PusharyGateConfig,
} from '@pushary/server/adapters'

export type { AskResult, DecisionType }

/** Config for every OpenAI Agents helper in this package. */
export type PusharyOpenAIAgentsConfig = PusharyAdapterConfig

/** One ask, as a tool hands it to the helpers. */
export type PusharyAskInput = AskHumanInput

const kernel = createAdapterKernel('the OpenAI Agents helpers')

/**
 * Build a request-time approval gate bound to these helpers. Used by
 * {@link resolvePusharyInterruptions}; exported so you can gate anything else the
 * same way.
 */
export const createPusharyGate = kernel.createGate

/** The end-user to ask, or a clear error naming these helpers. */
export const requirePusharyExternalId = kernel.requireExternalId

/** Blocking ask (Pattern A): create then poll durably. A fresh key is used unless the caller supplies an operation-specific idempotencyKey. */
export const askExternalUser = kernel.askExternalUser

/** Durable create (Pattern B): open a decision with a callbackUrl and return at once. */
export const createDurableDecision = kernel.createDurableDecision

/** Connect one end-user's phone (keyless). Show them the returned link. */
export const connect = kernel.connect

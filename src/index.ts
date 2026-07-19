import { tool } from '@openai/agents'
import { z } from 'zod'
import { askExternalUser, describeAnswer, type PusharyOpenAIAgentsConfig } from './core'

export * from './core'

const DEFAULT_DESCRIPTION =
  'Ask a real human to approve, choose, or answer. Delivered to their phone and answered from the lock screen. Blocks until they reply. Use before any risky or irreversible action or when you need a human decision.'

export interface PusharyToolOptions {
  /**
   * The enrolled end-user who answers. Bound here, NEVER taken from model input, so a
   * prompt-injected model cannot redirect an approval to another user.
   */
  readonly externalId: string
  /** Tool name the model calls (default "ask_human"). */
  readonly name?: string
  readonly description?: string
}

/**
 * An OpenAI Agents SDK function tool that asks a real human and blocks until they
 * answer, fail-closed. Add it to `new Agent({ tools: [pusharyTool(...)] })`.
 *
 * ```ts
 * const agent = new Agent({
 *   name: 'Support',
 *   instructions: 'Call ask_human before any refund.',
 *   tools: [pusharyTool({ apiKey: KEY }, { externalId: user.id })],
 * })
 * ```
 */
export const pusharyTool = (config: PusharyOpenAIAgentsConfig, opts: PusharyToolOptions) =>
  tool({
    name: opts.name ?? 'ask_human',
    description: opts.description ?? DEFAULT_DESCRIPTION,
    // Strict-mode friendly: every field is required; `options` is nullable rather than
    // optional so the JSON schema stays strict.
    parameters: z.object({
      question: z.string().describe('The exact question to put to the human.'),
      type: z.enum(['confirm', 'select', 'input']).describe('confirm = yes/no, select = pick an option, input = free text.'),
      options: z.array(z.string()).nullable().describe('The choices, for a select question, or null.'),
    }),
    // @openai/agents: execute receives the parsed args as the FIRST positional arg.
    async execute(input): Promise<string> {
      const result = await askExternalUser(config, {
        question: input.question,
        type: input.type,
        options: input.options ?? undefined,
        externalId: opts.externalId,
        node: opts.name ?? 'ask_human',
      })
      return describeAnswer(input.type, result)
    },
  })

/**
 * Minimal OpenAI Agents SDK example: one tool that asks a human and blocks.
 *
 * Prereqs: npm i @pushary/openai-agents @openai/agents zod
 * Run:     PUSHARY_API_KEY=... OPENAI_API_KEY=... npx tsx examples/basic.ts
 */
import { Agent, run } from '@openai/agents'
import { connect, pusharyTool } from '@pushary/openai-agents'

const config = { apiKey: process.env.PUSHARY_API_KEY! }
const userId = 'user_123'

async function main() {
  const { universalLink } = await connect(config, userId)
  console.log('Ask the user to open:', universalLink)

  const agent = new Agent({
    name: 'Support',
    instructions: 'Call ask_human before issuing any refund.',
    tools: [pusharyTool(config, { externalId: userId })],
  })

  const result = await run(agent, 'Refund order 5?')
  console.log(result.finalOutput)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

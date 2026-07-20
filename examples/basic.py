"""Minimal OpenAI Agents SDK (Python) example: a tool that asks a human and blocks.

Prereqs: pip install pushary-openai-agents openai-agents
Run:     PUSHARY_API_KEY=... OPENAI_API_KEY=... python examples/basic.py
"""
import asyncio

from agents import Agent, Runner
from pushary_openai_agents import connect, pushary_tool

USER_ID = "user_123"


async def main() -> None:
    link = connect(USER_ID)
    print("Ask the user to open:", link)

    agent = Agent(
        name="Support",
        instructions="Call ask_human before issuing any refund.",
        tools=[pushary_tool(USER_ID)],
    )
    result = await Runner.run(agent, "Refund order 5?")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())

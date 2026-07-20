# pushary-openai-agents

Human-in-the-loop for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
(Python). A function tool that asks a real human to approve, delivered to their phone,
and blocks on a fail-closed answer.

Requires the Pushary [Partner plan](https://pushary.com/agent-notifications-integration?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-openai-agents&utm_content=python-readme).

## Install

```bash
pip install pushary-openai-agents
```

Set `PUSHARY_API_KEY` (get it in your [dashboard](https://pushary.com/dashboard/settings)).

## Connect a phone once

```python
from pushary_openai_agents import connect

link = connect("user_123")  # show this to your end-user; one tap connects their phone
```

## The tool

```python
from agents import Agent, Runner
from pushary_openai_agents import pushary_tool

agent = Agent(
    name="Support",
    instructions="Call ask_human before issuing any refund.",
    tools=[pushary_tool("user_123")],
)
result = await Runner.run(agent, "Refund order 5?")
```

When the model calls the tool, Pushary delivers the question to that user's phone and
the call blocks until they answer. The tool returns a fail-closed instruction. The
`external_id` is bound when you build the tool, never taken from the model, so a
prompt-injected agent cannot ask the wrong person.

## Durable approvals

For a wait longer than a request can hold, drive your own flow off `ask_human` with a
`callback_url` on `decisions.create` and resolve the signed callback:

```python
from pushary_openai_agents import resolve_pushary_callback, SIGNATURE_HEADER

def callback(request):
    cb = resolve_pushary_callback(request.body, request.headers.get(SIGNATURE_HEADER), SECRET)
    if not cb:
        return ("bad signature", 401)
    # look up your parked run by cb["correlationId"], approve/reject, resume
    return ("ok", 200)
```

For TypeScript, use `npm i @pushary/openai-agents`.

## API

- `connect(external_id, *, api_key=None, base_url=None)` — enroll an end-user's phone.
- `pushary_tool(external_id, *, name="ask_human", ...)` — an OpenAI Agents function tool bound to that user.
- `ask_human(question, *, external_id, type="confirm", ...)` — blocking, returns the decision dict.
- `resolve_pushary_callback(raw_body, signature, secret)` — verify + parse a callback for the durable path.
- `describe_answer(type, result)`, `is_affirmative(answer)`, `deterministic_key(parts)`, `SIGNATURE_HEADER`.

## License

MIT

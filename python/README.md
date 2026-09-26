# pushary-openai-agents

Phone approvals for OpenAI Agents SDK agents. Your agent asks, your user taps Approve or Deny.

This is the Python package for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/).

## What you need

- A Pushary Partner plan, from $99 a month. [Start the trial](https://pushary.com/sign-up?from=agent&plan=partner&utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-openai-agents&utm_content=python-partner-start).
- An API key from [Partner onboarding](https://pushary.com/onboarding/partner), set as `PUSHARY_API_KEY`.
- Your users install the free Pushary app ([iPhone](https://apps.apple.com/us/app/pushary/id6785677563), [Android](https://play.google.com/store/apps/details?id=com.pushary.app)). They never sign up or pay.

## Quick start

```bash
pip install pushary-openai-agents
export PUSHARY_API_KEY=pk_xxx.sk_xxx
```

```python
from agents import Agent, Runner
from pushary_openai_agents import connect, pushary_tool

link = connect("user_123")  # once per user: show this link, one tap connects their phone

agent = Agent(
    name="Support",
    instructions="Ask the customer which order they need help with.",
    tools=[pushary_tool("user_123")],
)
result = await Runner.run(agent, "Which order needs help?")
```

When the model calls the tool, Pushary delivers the question to that user's phone and
the call waits until they answer. A no, or no answer, tells the model not to proceed.
The `external_id` is bound when you build the tool, never taken from the model, so a
prompt-injected agent cannot ask the wrong person.

Keep the ask tool for information and the SDK's enforced approval interruptions (below) for permission to execute. Confirmations can be answered from the lock screen. Choices and typed answers open the app. Web remains a compatibility option.

The OpenAI Agents SDK's own approval docs: [Human in the loop](https://openai.github.io/openai-agents-python/human_in_the_loop/).

## Gating a tool the model cannot skip

`pushary_tool` is a tool the model chooses to call. That is right for "go ask someone
about this", and wrong for "this must not happen without a yes", because a model that
does not want to be interrupted can decline to call it.

The SDK's own gate splits in two: `needs_approval` decides *whether* a human is
needed, and the run then stops with `result.interruptions`. Nothing asks anyone.
Resolving those interruptions is the caller's job, and `resolve_pushary_interruptions`
is that job done:

```python
from agents import Agent, Runner, function_tool
from pushary_openai_agents import pushary_needs_approval, resolve_pushary_interruptions

@function_tool(needs_approval=pushary_needs_approval())
def issue_refund(amount: float) -> str:
    return charge_back(amount)

agent = Agent(name="Support", instructions="Refund when asked.", tools=[issue_refund])

result = await Runner.run(agent, "Refund order 1234")
while result.interruptions:
    outcome = resolve_pushary_interruptions(result, external_id="user_123")
    if not outcome.all_approved:
        break
    result = await Runner.run(agent, outcome.state)
```

Resume with `outcome.state`, not `result.to_input_list()`. The second replays the
conversation without the decisions on it, so the model asks for the same tool again
and the person gets paged twice.

Each interruption becomes one decision on the phone, resolved in order so the person
sees one question at a time. A denial is handed back to the model as the rejection
message, so it knows why it was stopped rather than retrying blindly.

Fail-closed: a denial, an expiry, or nobody answering all reject. For a multi-tenant
product, resolve the end-user per interruption:

```python
resolve_pushary_interruptions(
    result, external_id=lambda item: owner_of(item.raw_item.call_id)
)
```

Pass `run_id=` when you replay a run under ids you mint yourself, so the replay
resolves to the same decisions instead of paging twice.

## Approval boundaries

Set `policy=False` when a person must always approve. Bind the recipient to your authenticated customer's identity. The resolver passes complete tool arguments to the shared gate and refuses interruptions without a stable tool-call ID. Exact retries share a review; changed customer or action arguments require a new one.

The resolver is a bounded request-time helper. For delayed answers, persist the framework's run state with the decision ID, customer and exact call arguments, verify the authoritative answer, then resume only that call. Your application owns the atomic resume claim and recovery from uncertain execution. A typed answer is not authorization. Finish old pending operations with their original SDK version before upgrading the approval-key scheme to server SDK 2.1.

## Runtime requirements

Version `0.4.0` requires `pushary>=2.1.0,<3` and `openai-agents>=0.18`. Clean-wheel checks used Python 3.12.12 with `openai-agents==0.18.0`; broader declared ranges do not imply every version was tested.

## Durable approvals

The [TypeScript saved-state reference](../examples/DELAYED-REVIEWS.md) demonstrates SQLite claims, authoritative answer checks and restart recovery. Python callers still own equivalent coordination around their native saved state; the Python resolver remains request-time. This reference does not add a Python durable runtime.

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

- `connect(external_id, *, api_key=None, base_url=None)`: enroll an end-user's phone.
- `pushary_tool(external_id, *, name="ask_human", ...)`: an OpenAI Agents function tool bound to that user.
- `ask_human(question, *, external_id, type="confirm", ...)`: blocking, returns the decision dict.
- `pushary_needs_approval()`: a `needs_approval` predicate that routes every call to a human.
- `resolve_pushary_interruptions(result, *, external_id, run_id="", ...)`: ask about each interruption, then approve or reject it on the run's context.
- `resolve_pushary_callback(raw_body, signature, secret)`: verify + parse a callback for the durable path.
- `create_pushary_gate(...)`: the raw fail-closed gate, for anything the helpers above do not cover.
- `describe_answer(type, result)`, `is_affirmative(answer)`, `render_approval_question(tool, input)`, `deterministic_key(parts)`, `SIGNATURE_HEADER`.

## License

MIT

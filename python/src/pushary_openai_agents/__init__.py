"""Human-in-the-loop for the OpenAI Agents SDK (Python), powered by Pushary.

Two seams:

- ``pushary_tool`` is a function tool the model chooses to call. Right for "go ask
  someone about this", wrong for "this must not happen without a yes", because a
  model that does not want to be interrupted can decline to call it.
- ``pushary_needs_approval`` plus ``resolve_pushary_interruptions`` is the enforced
  gate. The SDK splits approval in two: ``needs_approval`` only decides whether a
  human is needed, and the run then STOPS with ``result.interruptions``. Nothing
  asks anyone. The ask and the resume are the caller's job, which is the second
  function's whole purpose.

Everything but the framework binding is the shared kernel from ``pushary.adapters``,
bound to this adapter's name.

Zero framework import at module load: the ``agents`` package is imported lazily inside
the tool factory, so the core helpers work (and test) without it installed.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Union

from pushary import SIGNATURE_HEADER, deterministic_key
from pushary.adapters import (
    AdapterKernel,
    ApprovalAsk,
    ApprovalDecision,
    describe_answer,
    is_affirmative,
    render_approval_question,
    resolve_pushary_callback,
)

__version__ = "0.3.0"

__all__ = [
    "connect",
    "ask_human",
    "pushary_tool",
    "pushary_needs_approval",
    "resolve_pushary_interruptions",
    "describe_answer",
    "resolve_pushary_callback",
    "is_affirmative",
    "render_approval_question",
    "deterministic_key",
    "create_pushary_gate",
    "require_pushary_external_id",
    "ApprovalAsk",
    "ApprovalDecision",
    "ResolvedInterruption",
    "InterruptionOutcome",
    "SIGNATURE_HEADER",
    "__version__",
]

_DEFAULT_DESCRIPTION = (
    "Ask a real human to approve, choose, or answer. Blocks until they reply on their phone."
)

_kernel = AdapterKernel("the OpenAI Agents helpers")

connect = _kernel.connect
ask_human = _kernel.ask_human

#: Build a request-time approval gate bound to these helpers.
create_pushary_gate = _kernel.create_gate

#: The end-user to ask, or a clear error naming these helpers.
require_pushary_external_id = _kernel.require_external_id


def pushary_tool(
    external_id: str,
    *,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    agent_name: Optional[str] = None,
    name: str = "ask_human",
    node: str = "ask-human",
):
    """Return an OpenAI Agents function tool bound to ``external_id``.

    ``external_id`` is bound here, never taken from the model, so a prompt-injected
    agent cannot redirect an approval to another user.

    ```python
    from agents import Agent, Runner
    agent = Agent(name="Support", instructions="Call ask_human before risky steps.",
                  tools=[pushary_tool("user_123")])
    ```
    """

    # Lazy import so the module loads (and tests) without the agents package installed.
    from agents import function_tool

    @function_tool(name_override=name or "ask_human")
    def ask_human_tool(question: str, kind: str = "confirm") -> str:
        """Ask a real human to approve, choose, or answer. Blocks until they reply on their phone."""
        result = ask_human(
            question,
            external_id=external_id,
            type=kind,
            node=node,
            agent_name=agent_name,
            api_key=api_key,
            base_url=base_url,
        )
        return describe_answer(kind, result)

    return ask_human_tool


def pushary_needs_approval() -> Callable[..., bool]:
    """A ``needs_approval`` predicate that always routes the call to a human.

    ```python
    @function_tool(needs_approval=pushary_needs_approval())
    def issue_refund(amount: float) -> str: ...
    ```

    The ask itself happens in :func:`resolve_pushary_interruptions` after the run
    stops.
    """

    def needs_approval(*_args: Any, **_kwargs: Any) -> bool:
        return True

    return needs_approval


class ResolvedInterruption:
    """What one interruption resolved to."""

    __slots__ = ("tool_name", "call_id", "approved", "reason")

    def __init__(
        self, tool_name: str, call_id: str, approved: bool, reason: Optional[str] = None
    ) -> None:
        self.tool_name = tool_name
        self.call_id = call_id
        self.approved = approved
        self.reason = reason

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"ResolvedInterruption(tool_name={self.tool_name!r}, call_id={self.call_id!r}, "
            f"approved={self.approved!r}, reason={self.reason!r})"
        )


class InterruptionOutcome:
    """The result of resolving every interruption in one run."""

    __slots__ = ("resolved", "state")

    def __init__(self, resolved: List[ResolvedInterruption], state: Any) -> None:
        self.resolved = resolved
        #: The ``RunState`` carrying the decisions. Resume with
        #: ``Runner.run(agent, outcome.state)``; resuming from anything else drops
        #: the approvals and asks the model to do it all again.
        self.state = state

    @property
    def all_approved(self) -> bool:
        """True when every interruption was approved, so the run is safe to continue."""

        return all(item.approved for item in self.resolved)


def _tool_name_of(interruption: Any) -> str:
    name = getattr(interruption, "tool_name", None)
    if name:
        return str(name)
    raw = getattr(interruption, "raw_item", None)
    return str(getattr(raw, "name", None) or "tool")


def _arguments_of(interruption: Any) -> Any:
    raw = getattr(interruption, "raw_item", None)
    arguments = getattr(raw, "arguments", None)
    if arguments is None:
        return None
    try:
        return json.loads(arguments)
    except (TypeError, ValueError):
        # The SDK hands arguments through as the model produced them, so an
        # unparsable string is still the most honest thing to show the approver.
        return arguments


def _call_id_of(interruption: Any, fallback: str) -> str:
    raw = getattr(interruption, "raw_item", None)
    return str(getattr(raw, "call_id", None) or fallback)


def resolve_pushary_interruptions(
    result: Any,
    *,
    external_id: Union[str, Callable[[Any], Optional[str]]],
    state: Any = None,
    run_id: str = "",
    question: Optional[Callable[[Any], str]] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    agent_name: Optional[str] = None,
    expires_in_seconds: Optional[int] = None,
    timeout_seconds: Optional[float] = None,
    require_reachable: Optional[bool] = None,
) -> InterruptionOutcome:
    """Ask a real person about every tool call the run stopped on, then approve or
    reject each one on the run state.

    Fails closed: a decline, an expiry, or nobody answering all reject, with the
    reason handed to the model.

    ```python
    result = await Runner.run(agent, "Refund order 1234")
    while result.interruptions:
        outcome = resolve_pushary_interruptions(result, external_id=user.id)
        if not outcome.all_approved:
            break
        result = await Runner.run(agent, outcome.state)
    ```

    Resume with ``outcome.state``, never with ``result.to_input_list()``: the second
    replays the conversation without the decisions, so the model asks for the same
    tool again and the person gets paged twice.

    Decisions go through ``RunState.approve`` / ``RunState.reject`` rather than the
    context wrapper directly, because those resolve nested (agent-as-tool) approvals
    and remap the interruption onto the item the state actually holds.

    Pass ``state`` to drive a state you already built; by default one is taken from
    ``result.to_state()``.

    Interruptions are resolved one at a time, in order, so a person answering on a
    phone sees one question at a time rather than a burst of them.
    """

    gate = _kernel.create_gate(
        api_key=api_key,
        base_url=base_url,
        agent_name=agent_name,
        expires_in_seconds=expires_in_seconds,
        timeout_seconds=timeout_seconds,
        require_reachable=require_reachable,
    )
    run_state = state if state is not None else result.to_state()
    resolved: List[ResolvedInterruption] = []

    for interruption in getattr(result, "interruptions", None) or []:
        tool_name = _tool_name_of(interruption)
        call_id = _call_id_of(interruption, tool_name)
        configured = external_id(interruption) if callable(external_id) else external_id

        decision = gate(
            ApprovalAsk(
                tool_name=tool_name,
                call_id=call_id,
                session_id=run_id,
                question=(
                    question(interruption)
                    if question
                    else render_approval_question(tool_name, _arguments_of(interruption))
                ),
                external_id=require_pushary_external_id(configured),
            )
        )

        if decision.approved:
            run_state.approve(interruption)
            resolved.append(ResolvedInterruption(tool_name, call_id, True))
        else:
            run_state.reject(interruption, rejection_message=decision.reason)
            resolved.append(ResolvedInterruption(tool_name, call_id, False, decision.reason))

    return InterruptionOutcome(resolved, run_state)

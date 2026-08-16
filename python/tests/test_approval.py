"""Tests for the enforced gate. Framework-free: the agents package is never imported
here, because resolve_pushary_interruptions reads the run result structurally.
"""

import os
import unittest

import pushary_openai_agents as poa
from pushary import adapters


class FakeDecisions:
    def __init__(self, results):
        self.ask_calls = []
        self._results = list(results)
        self._i = 0

    def ask(self, question, **kwargs):
        self.ask_calls.append({"question": question, **kwargs})
        result = self._results[min(self._i, len(self._results) - 1)]
        self._i += 1
        return result


class FakeClient:
    def __init__(self, decisions):
        self.decisions = decisions


class WithFakeClient:
    """Patch the kernel's client constructor to a FakeClient for one test."""

    def __init__(self, client):
        self.client = client
        self._orig = None
        self._orig_key = None

    def __enter__(self):
        self._orig = adapters.PusharyServer
        adapters.PusharyServer = lambda **kwargs: self.client
        self._orig_key = os.environ.get("PUSHARY_API_KEY")
        os.environ["PUSHARY_API_KEY"] = "pk_test.sk_test"
        return self.client

    def __exit__(self, *exc):
        adapters.PusharyServer = self._orig
        if self._orig_key is None:
            os.environ.pop("PUSHARY_API_KEY", None)
        else:
            os.environ["PUSHARY_API_KEY"] = self._orig_key


ANSWERED_YES = {"answered": True, "approved": True, "value": "yes"}
ANSWERED_NO = {"answered": True, "approved": False, "value": "no"}
UNANSWERED = {"answered": False, "approved": False, "value": None}


class FakeRawItem:
    def __init__(self, call_id="call_1", name="issue_refund", arguments='{"amount":480}'):
        self.call_id = call_id
        self.name = name
        self.arguments = arguments


class FakeInterruption:
    def __init__(self, raw_item=None, tool_name=None):
        self.raw_item = raw_item or FakeRawItem()
        self.tool_name = tool_name
        self.type = "tool_approval_item"


class FakeRunState:
    """Stands in for agents.RunState: approve/reject, then resume the run with it."""

    def __init__(self):
        self.approved = []
        self.rejected = []

    def approve(self, item, always_approve=False):
        self.approved.append(item)

    def reject(self, item, always_reject=False, *, rejection_message=None):
        self.rejected.append({"item": item, "message": rejection_message})


class FakeResult:
    def __init__(self, interruptions):
        self.interruptions = interruptions
        self.state = FakeRunState()
        self.to_state_calls = 0

    def to_state(self):
        self.to_state_calls += 1
        return self.state


class NeedsApprovalTests(unittest.TestCase):
    def test_routes_every_call_to_a_human(self):
        self.assertTrue(poa.pushary_needs_approval()(None, {"amount": 1}, "call_1"))


class ResolveInterruptionsTests(unittest.TestCase):
    def test_approves_the_context_when_the_human_says_yes(self):
        decisions = FakeDecisions([ANSWERED_YES])
        result = FakeResult([FakeInterruption()])
        with WithFakeClient(FakeClient(decisions)):
            outcome = poa.resolve_pushary_interruptions(result, external_id="user_1")
        self.assertEqual(len(result.state.approved), 1)
        self.assertEqual(len(result.state.rejected), 0)
        self.assertTrue(outcome.all_approved)
        self.assertEqual(outcome.resolved[0].tool_name, "issue_refund")

    def test_rejects_with_the_reason_when_the_human_says_no(self):
        decisions = FakeDecisions([ANSWERED_NO])
        result = FakeResult([FakeInterruption()])
        with WithFakeClient(FakeClient(decisions)):
            outcome = poa.resolve_pushary_interruptions(result, external_id="user_1")
        self.assertEqual(len(result.state.approved), 0)
        self.assertIn("denied", result.state.rejected[0]["message"])
        self.assertFalse(outcome.all_approved)

    def test_fails_closed_when_nobody_answers(self):
        decisions = FakeDecisions([UNANSWERED])
        result = FakeResult([FakeInterruption()])
        with WithFakeClient(FakeClient(decisions)):
            outcome = poa.resolve_pushary_interruptions(result, external_id="user_1")
        self.assertEqual(len(result.state.rejected), 1)
        self.assertIn("No answer", outcome.resolved[0].reason)

    def test_puts_the_tool_arguments_in_the_question(self):
        decisions = FakeDecisions([ANSWERED_YES])
        with WithFakeClient(FakeClient(decisions)):
            poa.resolve_pushary_interruptions(
                FakeResult([FakeInterruption()]), external_id="user_1"
            )
        self.assertIn("480", decisions.ask_calls[0]["question"])

    def test_still_asks_when_the_model_produced_unparsable_arguments(self):
        decisions = FakeDecisions([ANSWERED_YES])
        interruption = FakeInterruption(FakeRawItem(arguments="{not json"))
        with WithFakeClient(FakeClient(decisions)):
            poa.resolve_pushary_interruptions(FakeResult([interruption]), external_id="user_1")
        self.assertIn("{not json", decisions.ask_calls[0]["question"])

    def test_resolves_each_interruption_against_its_own_decision(self):
        decisions = FakeDecisions([ANSWERED_YES, ANSWERED_NO])
        result = FakeResult(
            [
                FakeInterruption(FakeRawItem(call_id="call_1", name="issue_refund")),
                FakeInterruption(FakeRawItem(call_id="call_2", name="delete_account")),
            ]
        )
        with WithFakeClient(FakeClient(decisions)):
            outcome = poa.resolve_pushary_interruptions(result, external_id="user_1")
        self.assertEqual(len(decisions.ask_calls), 2)
        self.assertNotEqual(
            decisions.ask_calls[0]["idempotency_key"], decisions.ask_calls[1]["idempotency_key"]
        )
        self.assertEqual(len(result.state.approved), 1)
        self.assertEqual(len(result.state.rejected), 1)
        self.assertFalse(outcome.all_approved)

    def test_lets_external_id_be_resolved_per_interruption(self):
        decisions = FakeDecisions([ANSWERED_YES])
        with WithFakeClient(FakeClient(decisions)):
            poa.resolve_pushary_interruptions(
                FakeResult([FakeInterruption()]),
                external_id=lambda item: f"tenant:{item.raw_item.name}",
            )
        self.assertEqual(decisions.ask_calls[0]["external_id"], "tenant:issue_refund")

    def test_prefers_an_explicit_tool_name_over_the_raw_item(self):
        decisions = FakeDecisions([ANSWERED_YES])
        interruption = FakeInterruption(tool_name="namespaced__issue_refund")
        with WithFakeClient(FakeClient(decisions)):
            outcome = poa.resolve_pushary_interruptions(
                FakeResult([interruption]), external_id="user_1"
            )
        self.assertEqual(outcome.resolved[0].tool_name, "namespaced__issue_refund")

    def test_does_nothing_when_the_run_stopped_for_some_other_reason(self):
        decisions = FakeDecisions([ANSWERED_YES])
        with WithFakeClient(FakeClient(decisions)):
            outcome = poa.resolve_pushary_interruptions(FakeResult(None), external_id="user_1")
        self.assertEqual(len(decisions.ask_calls), 0)
        self.assertEqual(outcome.resolved, [])
        self.assertTrue(outcome.all_approved)

    def test_returns_the_state_to_resume_with(self):
        decisions = FakeDecisions([ANSWERED_YES])
        result = FakeResult([FakeInterruption()])
        with WithFakeClient(FakeClient(decisions)):
            outcome = poa.resolve_pushary_interruptions(result, external_id="user_1")
        # Resuming with anything but this state drops the approvals.
        self.assertIs(outcome.state, result.state)
        self.assertEqual(result.to_state_calls, 1)

    def test_drives_a_state_handed_in_directly(self):
        decisions = FakeDecisions([ANSWERED_YES])
        result = FakeResult([FakeInterruption()])
        own_state = FakeRunState()
        with WithFakeClient(FakeClient(decisions)):
            outcome = poa.resolve_pushary_interruptions(
                result, external_id="user_1", state=own_state
            )
        self.assertEqual(result.to_state_calls, 0)
        self.assertEqual(len(own_state.approved), 1)
        self.assertIs(outcome.state, own_state)

    def test_keys_on_run_id_so_a_replayed_run_does_not_ask_twice(self):
        decisions = FakeDecisions([ANSWERED_YES, ANSWERED_YES])
        with WithFakeClient(FakeClient(decisions)):
            poa.resolve_pushary_interruptions(
                FakeResult([FakeInterruption()]), external_id="user_1", run_id="run_1"
            )
            poa.resolve_pushary_interruptions(
                FakeResult([FakeInterruption()]), external_id="user_1", run_id="run_1"
            )
        self.assertEqual(
            decisions.ask_calls[0]["idempotency_key"], decisions.ask_calls[1]["idempotency_key"]
        )


if __name__ == "__main__":
    unittest.main()

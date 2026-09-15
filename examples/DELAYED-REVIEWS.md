# A customer answers after the process exits

This reference uses OpenAI Agents' native `RunState`, the shared Pushary server SDK, and application-owned SQLite. The `resolvePusharyInterruptions` helper remains a bounded request-time path. The delayed path saves the interruption before asking and resumes later without a new model run.

From this package's source directory, using Node.js 22.13 or later (tested on 24.3):

```bash
npm install
npm run build
npm run test:restart
```

Examples also ship in the npm artifact: `node node_modules/@pushary/openai-agents/examples/delayed-review.mjs` runs after installing the package and peers. Tested with `@openai/agents@0.16.1` and Node.js 24.3; SQLite is experimental in that Node runtime.

The checks use the real framework, fresh processes, a scripted model, simulated HTTP, and SQLite execution receipts. They cover approval/denial/expiry, concurrent and duplicate workers, wrong-customer and changed-state refusal, altered decision context, a process exit after the simulated effect, a subsequent interruption, and output preservation when finalization and uncertainty writes fail. No model, phone, or payment API is contacted.

## Adapt the three files

- `delayed-review.mjs` defines a protected tool with `pusharyNeedsApproval()`, saves `result.state.toString()`, rebuilds the original agent graph, and restores with `RunState.fromString`. It rechecks the exact interruption before calling `state.approve` or `state.reject`, then passes the state to `runner.run`.
- `delayed-review-store.mjs` holds the immutable operation/customer/call/arguments/version binding and snapshot hash. It uses the shared SDK to create a durable decision and read the authoritative answer. Its small schema intentionally supports one protected function-tool interruption per saved operation.
- `delayed-simulation.mjs` is test-only wiring. Replace the simulated model, transport and effect with your application code; never install its global `fetch` replacement in a production process.

Enroll the authenticated customer with `connect` and a Partner credential. The decision requires a reachable customer. Save state before `openReview`, then call `reconcileReview` from your existing job system after the user answers. An operation ID identifies this pause and stays unchanged on retry. The deterministic creation key permits recovery after a decision was created but its ID was not saved. The bounded refund schema supplies structured order, EUR amount and draft-version fields for the phone; context carries only the immutable binding fingerprint. Adapt this trusted presentation and input schema together for your business action.

Reconciliation verifies customer, code/framework version, exact saved state, decision ID, question/options and authoritative context. Only `confirm: yes` allows the function tool; denial, expiry and cancellation reject it. A nullable API recipient is accepted only alongside the exact original binding context. Never drive approval from model-supplied identity or unverified callback data. The reference is for protected confirmations, not deferred free-text questions.

A signed callback may wake this same worker: verify the raw callback, durably enqueue its receipt, and reconcile through the authenticated SDK. Periodic reconciliation is still needed because webhook retries are bounded. This reference does not require a callback route or introduce a scheduler.

## Preserve execution and output

SQLite atomically moves a pending operation to resuming. Other workers return busy; completed duplicates return the original persisted output. The completion write saves the final output, history, subsequent interruptions and new serialized state together with the completed status. Handle new interruptions using a distinct operation ID. All resumers of a run must use the same coordination boundary; extend the record and serialize the entire run before supporting several simultaneous pending tools. This store locks an operation, not an arbitrary framework run: never assign different operation IDs to the same saved run/pause. There must be exactly one outstanding protected call and operation for that snapshot; create the next operation only from the previous completed continuation's new pause.

A failed resume is uncertain, never automatically retried. A crashed worker leaves resuming; no timeout resets the claim. Reconcile the SDK state and business receipt manually before settling or replacing it. If completion persistence fails, the return value still includes the generated output; if recording uncertainty fails too, it also carries that persistence error. Save those diagnostics through your application's recovery path. Completion means the framework output was stored, not that every business tool succeeded.

Keep real effects idempotent by business operation, validate the current draft inside the business write, and retain the execution receipt. The simulated effect demonstrates such an operation-keyed receipt while checking that duplicate delivery never invokes it twice. Use SQLite only for workers sharing its file; use an existing transactional database across distributed machines. Treat serialized state/history as private customer data, preserve the same root agent graph and tool behavior, and retain old code/framework versions while old runs drain. Do not replay raw items to work around an incompatible `RunState`.

The Python package remains a request-time helper. Python applications still own equivalent delayed coordination using their native saved state; this TypeScript reference does not add a Python durable runtime.

Official reference: [OpenAI Agents human-in-the-loop and long approval waits](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/). Physical phone delivery remains a separate live test.

`node:sqlite` is available without its experimental flag from [Node.js 22.13](https://nodejs.org/api/sqlite.html). The recipe does not change the runtime requirements of the installed framework.

## Streaming uses the same saved state

Run `npm run test:stream` to execute the same checks with streamed model responses and streamed continuations. The worker consumes events and awaits `result.completed` before inspecting interruptions or serializing state. Only the settled paused run is stored; resumption restores that same state. The simulation emits a completed model-response event, not a real token-by-token network stream.

For direct Responses API MCP approvals, see [the phone approval tutorial](PHONE-APPROVALS.md). That path persists the response and approval request IDs, not an Agents SDK RunState.

# Changelog

## 0.4.0

**Customer reviews for OpenAI Agents.**

Keep optional questions separate from enforced tool approval interruptions. Bind each review to the authenticated customer and complete proposed action.

The TypeScript saved-state recipe uses native RunState, application-owned SQLite and execution receipts to demonstrate delayed answers and duplicate-worker handling. A timed-out request-time helper does not resume itself later.

Requires the shared Pushary SDK 2.1. Finish existing pending operations on their original SDK version before upgrading. The adapter is MIT-licensed; real phone delivery uses the hosted Partner service.

[Run or adapt the example](https://github.com/Pushary/pushary-openai-agents/blob/main/examples/DELAYED-REVIEWS.md).

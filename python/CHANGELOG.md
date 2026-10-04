# Changelog

## 0.4.2

A denied tool call now reaches the model. The approval loop in the README example broke out before resuming the run, so a rejection was recorded on the run state but the model never saw the reason, and any call approved in the same batch never ran. The example now resumes once and then stops if anything was denied. No behavior changes.

## 0.4.1

The README and the package description now lead with what the package does: your agent asks, your user taps Approve or Deny on their phone. No code changes.

## 0.4.0

**Customer reviews for Python OpenAI Agents.**

Ask customers in the native Pushary app and resolve enforced approval interruptions against the authenticated customer and complete tool arguments. Exact retries reuse reviews; changed actions need new ones.

This Python resolver is a bounded request-time helper. Applications own saved run state and delayed resumption; the TypeScript SQLite recipe is not a Python durable runtime.

Requires the shared Pushary SDK 2.1. Finish existing pending operations on their original SDK version before upgrading. The adapter is MIT-licensed; real phone delivery uses the hosted Partner service.

[Run or adapt the example](https://github.com/Pushary/pushary-openai-agents/blob/main/python/README.md).

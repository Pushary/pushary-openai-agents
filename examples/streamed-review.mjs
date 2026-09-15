// The same persisted-review checks with streaming enabled in every worker.
process.env.PUSHARY_EXAMPLE_STREAM = '1'
await import('./delayed-review.mjs')

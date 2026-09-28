# Port notes: EventStream / FifoQueue (Go)

## Scope

Ported the generic `FifoQueue<T>` and `EventStream<T, R>` behavior from
`packages/ai/src/utils/event-stream.ts` into `event_stream.go` (package `port`).
`AssistantMessageEventStream` and `createAssistantMessageEventStream` are **not**
ported, because they depend on pi-ai message types (`AssistantMessage`,
`AssistantMessageEvent`) which are outside the task scope. Only the standard
library is used (`context`, `sync`).

Original license (MIT, Copyright (c) 2025 Mario Zechner) is reproduced in the
header of `event_stream.go`; the existing `LICENSE` file is retained.

## Interface mapping

| TypeScript | Go |
| --- | --- |
| `class FifoQueue<T>` (incoming/outgoing stacks) | unexported `fifoQueue[T]` with `incoming`/`outgoing` slices, `length()`, `enqueue`, `dequeue` returning `(T, bool)` |
| `IteratorResult<T>` (`{value, done}`) | exported `StreamItem[T]{ Value T; Done bool }` |
| `new EventStream<T,R>(isComplete, extractResult)` | `NewEventStream[T any, R any](isComplete func(T) bool, extractResult func(T) R) *EventStream[T,R]` |
| `push(event)` | `(*EventStream[T,R]).Push(event T)` |
| `[Symbol.asyncIterator]().next()` | `(*EventStream[T,R]).Next() <-chan StreamItem[T]` |
| `end(result?)` | `(*EventStream[T,R]).End(result *R)` (nil = "no result") |
| `result(): Promise<R>` | `(*EventStream[T,R]).Result(ctx context.Context) (R, error)` |

## Behavioral fidelity

- **FIFO order** preserved by the two-stack queue (reverse-transfer into
  `outgoing`, pop from the end), matching the TS algorithm exactly.
- **Synchronous consumer registration**: `Next()` registers a consumer
  immediately under the mutex and returns a buffered result channel
  (capacity 1). If buffered events exist they are delivered at once; if the
  stream is done and the buffer is empty, a `Done` item is delivered; otherwise
  the consumer is enqueued for a future `Push`/`End`.
- **Not a broadcast**: `Push` dequeues a single waiter (or buffers); each event
  goes to exactly one consumer.
- **Completion event still consumable**: in `Push`, when `isComplete(event)` is
  true the stream is marked done and the result resolved, but the event is
  still delivered to a waiter or buffered — so the completing event can be
  consumed (matches TS test 1: events `[1,2,3]`).
- **Push after done is ignored** (early return), matching TS.
- **Draining after End**: `End` sets done and wakes all waiters with `Done`,
  but buffered events remain in the queue. Subsequent `Next` calls dequeue the
  buffered events first and only report `Done` once the queue is empty
  (matches TS test 4: events `[1,2]` after `end("complete")`).
- **First result wins**: `resolveResult` stores the value only once
  (`resultReady` guard); the completing `Push` and any later `End(result)` do
  not overwrite it.
- **`End(nil)` does not resolve `Result`** but does wake waiting consumers:
  `End` only calls `resolveResult` when `result != nil`, while all waiters are
  drained and closed with `Done`.
- **`Result` context cancellation**: blocks on `resultWaitCh` vs `ctx.Done()`,
  returning `ctx.Err()` if the context fires first. Once resolved, `Result`
  returns immediately for any context.
- **Concurrency safety**: all mutable state is guarded by a single
  `sync.Mutex`. Waiter channels have capacity 1 so `Push`/`End` never block on
  a consumer that has not yet read, and each waiter channel is closed after
  exactly one delivery.

## Known differences / limitations

- The TS `asyncIterator` is a puller that re-checks `queue`/`done` each loop
  iteration. The Go equivalent uses one `Next()` call per item; after `Done` a
  subsequent `Next()` will keep returning `Done` items (the TS iterator would
  return `done:true` and be exhausted too). Loops should stop at the first
  `Done`, as `drain` in the tests does.
- `End(result *R)` uses `nil` to mean "no result", matching `end(result?)`.
  A caller who wants to resolve a nil-able result pointer value cannot; this
  mirrors the TS `undefined` check. R is not constrained to a comparable/pointer
  type for the "no result" case, so `nil` is the only sentinel.
- `Result` takes a `context.Context`; the TS version returned a bare Promise
  with no cancellation. Behavior without cancellation is equivalent.
- TS `dequeue()` returns `undefined` for an empty queue; Go returns
  `(zero, false)` so that a legitimately zero-valued element is distinguishable
  from an empty queue.
- `AssistantMessageEventStream` / `createAssistantMessageEventStream` are
  intentionally omitted (see Scope).

## Verification

This port has **not** been executed here; the tooling allowed no command
execution, so nothing below is a claim of passing. Please run:

```
go test ./...
go vet ./...
```

The tests in `event_stream_test.go` mirror all five scenarios from
`packages/ai/test/event-stream.test.ts` (drain+ignore-after-complete,
order during draining, registration-order delivery, drain-after-end with
explicit result, wake-all on end without result) and add coverage for context
cancellation, first-result-wins, `Next` after `End`, and concurrent
push/next. Cross-checks against the original TS scenarios remain the
independent verifier's responsibility.

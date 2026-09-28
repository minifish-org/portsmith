// Package port contains a faithful Go port of the generic EventStream and
// FifoQueue behavior from packages/ai/src/utils/event-stream.ts.
//
// Original TypeScript source:
//
//	MIT License
//
//	Copyright (c) 2025 Mario Zechner
//
//	Permission is hereby granted, free of charge, to any person obtaining a copy
//	of this software and associated documentation files (the "Software"), to deal
//	in the Software without restriction, including without limitation the rights
//	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//	copies of the Software, and to permit persons to whom the Software is
//	furnished to do so, subject to the following conditions:
//
//	The above copyright notice and this permission notice shall be included in all
//	copies or substantial portions of the Software.
//
//	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//	SOFTWARE.
package port

import (
	"context"
	"sync"
)

// fifoQueue mirrors the two-stack FIFO queue used by the TypeScript original.
// The incoming slice receives enqueued values; when a dequeue finds the
// outgoing slice empty, all incoming values are moved over in reverse so that
// the oldest value ends up at the end of outgoing. Dequeue then pops from
// outgoing, yielding FIFO order with amortized O(1) operations.
type fifoQueue[T any] struct {
	incoming []T
	outgoing []T
}

func (q *fifoQueue[T]) length() int {
	return len(q.incoming) + len(q.outgoing)
}

func (q *fifoQueue[T]) enqueue(value T) {
	q.incoming = append(q.incoming, value)
}

func (q *fifoQueue[T]) dequeue() (T, bool) {
	if len(q.outgoing) == 0 {
		for len(q.incoming) > 0 {
			n := len(q.incoming) - 1
			value := q.incoming[n]
			q.incoming = q.incoming[:n]
			q.outgoing = append(q.outgoing, value)
		}
	}
	if len(q.outgoing) == 0 {
		var zero T
		return zero, false
	}
	n := len(q.outgoing) - 1
	value := q.outgoing[n]
	q.outgoing = q.outgoing[:n]
	return value, true
}

// StreamItem is the Go analog of the JavaScript IteratorResult delivered to
// consumers. Done reports completion; Value carries the event when Done is
// false. When Done is true, Value is the zero value of T.
type StreamItem[T any] struct {
	Value T
	Done  bool
}

// waiter represents a registered consumer. The EventStream delivers exactly
// one StreamItem to each waiter channel and then closes it, mirroring the
// single-use resolve callback in the TypeScript implementation.
type waiter[T any] struct {
	ch chan StreamItem[T]
}

// EventStream is the Go analog of the TypeScript EventStream<T, R>. It is safe
// for concurrent use.
type EventStream[T any, R any] struct {
	mu      sync.Mutex
	queue   fifoQueue[T]
	waiting fifoQueue[*waiter[T]]

	done         bool
	resultReady  bool
	finalResult  R
	resultWaitCh chan struct{}

	isComplete    func(T) bool
	extractResult func(T) R
}

// NewEventStream constructs an EventStream.
//
// isComplete reports whether an event completes the stream; extractResult
// derives the final result from a completing event. These correspond to the
// TypeScript constructor arguments.
func NewEventStream[T any, R any](isComplete func(T) bool, extractResult func(T) R) *EventStream[T, R] {
	return &EventStream[T, R]{
		resultWaitCh:  make(chan struct{}),
		isComplete:    isComplete,
		extractResult: extractResult,
	}
}

// Push enqueues an event. Events pushed after the stream is done are ignored.
// A completing event marks the stream done and resolves the final result
// before delivery. Delivery goes to the earliest registered waiting consumer
// when one exists, otherwise the event is buffered. This is not a broadcast;
// each event is handed to exactly one consumer.
func (s *EventStream[T, R]) Push(event T) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.done {
		return
	}

	if s.isComplete != nil && s.isComplete(event) {
		s.done = true
		s.resolveResult(s.extractResult(event))
	}

	if w, ok := s.waiting.dequeue(); ok {
		w.ch <- StreamItem[T]{Value: event, Done: false}
		close(w.ch)
	} else {
		s.queue.enqueue(event)
	}
}

// Next synchronously registers a consumer and returns a result channel of
// capacity 1. If buffered events are available they are delivered immediately;
// otherwise, if the stream is done, the channel receives a Done item. If the
// stream is still open, the channel is delivered to when a future Push or End
// occurs. Every returned channel yields exactly one item and is then closed.
func (s *EventStream[T, R]) Next() <-chan StreamItem[T] {
	s.mu.Lock()
	defer s.mu.Unlock()

	ch := make(chan StreamItem[T], 1)

	if value, ok := s.queue.dequeue(); ok {
		ch <- StreamItem[T]{Value: value, Done: false}
		close(ch)
		return ch
	}

	if s.done {
		var zero T
		ch <- StreamItem[T]{Value: zero, Done: true}
		close(ch)
		return ch
	}

	s.waiting.enqueue(&waiter[T]{ch: ch})
	return ch
}

// End marks the stream done and optionally resolves the final result. When
// result is non-nil the first resolved value is stored and all waiters for
// Result are woken. All registered consumers are woken with a Done item.
// Buffered events already queued remain consumable via subsequent Next calls
// (which will drain the queue before reporting Done).
func (s *EventStream[T, R]) End(result *R) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.done = true
	if result != nil {
		s.resolveResult(*result)
	}

	for {
		w, ok := s.waiting.dequeue()
		if !ok {
			break
		}
		var zero T
		w.ch <- StreamItem[T]{Value: zero, Done: true}
		close(w.ch)
	}
}

// Result returns the final result, blocking until a result is resolved or the
// context is canceled. Only the first resolved result (from a completing Push
// or from a non-nil End result) is stored; later resolutions are ignored.
// When End is called with a nil result and no completing event was pushed,
// Result does not resolve and blocks until the context is canceled.
func (s *EventStream[T, R]) Result(ctx context.Context) (R, error) {
	s.mu.Lock()
	if s.resultReady {
		res := s.finalResult
		s.mu.Unlock()
		return res, nil
	}
	ch := s.resultWaitCh
	s.mu.Unlock()

	select {
	case <-ctx.Done():
		var zero R
		return zero, ctx.Err()
	case <-ch:
		s.mu.Lock()
		res := s.finalResult
		s.mu.Unlock()
		return res, nil
	}
}

// resolveResult stores the first resolved result and wakes Result waiters.
// Callers must hold s.mu.
func (s *EventStream[T, R]) resolveResult(value R) {
	if s.resultReady {
		return
	}
	s.resultReady = true
	s.finalResult = value
	close(s.resultWaitCh)
}

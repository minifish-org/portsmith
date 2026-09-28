package port

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"
)

func mustReceive[T any](t *testing.T, ch <-chan StreamItem[T]) StreamItem[T] {
	t.Helper()
	select {
	case item, ok := <-ch:
		if !ok {
			t.Fatalf("channel closed without delivering a StreamItem")
		}
		return item
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for StreamItem")
		return StreamItem[T]{}
	}
}

// Ports test: "drains buffered events in order and ignores events pushed after
// completion".
func TestDrainsBufferedEventsInOrderAndIgnoresAfterCompletion(t *testing.T) {
	stream := NewEventStream[float64, float64](
		func(event float64) bool { return event == 3 },
		func(event float64) float64 { return event },
	)
	stream.Push(1)
	stream.Push(2)
	stream.Push(3)
	stream.Push(4) // ignored: stream completed on 3

	result, err := stream.Result(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != 3 {
		t.Fatalf("expected result 3, got %v", result)
	}

	events := drain[float64, float64](t, stream)
	if !reflect.DeepEqual(events, []float64{1, 2, 3}) {
		t.Fatalf("expected [1 2 3], got %v", events)
	}
}

// Ports test: "preserves order when events arrive after buffered draining
// starts".
func TestPreservesOrderWhenEventsArriveDuringDraining(t *testing.T) {
	stream := NewEventStream[float64, float64](
		func(event float64) bool { return false },
		func(event float64) float64 { return event },
	)
	stream.Push(1)
	stream.Push(2)

	first := mustReceive(t, stream.Next())
	if first.Done || first.Value != 1 {
		t.Fatalf("expected value 1, got %+v", first)
	}

	stream.Push(3)

	second := mustReceive(t, stream.Next())
	if second.Done || second.Value != 2 {
		t.Fatalf("expected value 2, got %+v", second)
	}
	third := mustReceive(t, stream.Next())
	if third.Done || third.Value != 3 {
		t.Fatalf("expected value 3, got %+v", third)
	}

	complete := 3.0
	stream.End(&complete)

	last := mustReceive(t, stream.Next())
	if !last.Done {
		t.Fatalf("expected Done item, got %+v", last)
	}
}

// Ports test: "delivers events to waiting consumers in registration order".
func TestDeliversEventsToWaitingConsumersInRegistrationOrder(t *testing.T) {
	stream := NewEventStream[float64, float64](
		func(event float64) bool { return false },
		func(event float64) float64 { return event },
	)

	first := stream.Next()
	second := stream.Next()

	stream.Push(1)
	stream.Push(2)

	firstItem := mustReceive(t, first)
	if firstItem.Done || firstItem.Value != 1 {
		t.Fatalf("expected first consumer to get 1, got %+v", firstItem)
	}
	secondItem := mustReceive(t, second)
	if secondItem.Done || secondItem.Value != 2 {
		t.Fatalf("expected second consumer to get 2, got %+v", secondItem)
	}
}

// Ports test: "drains buffered events after end and resolves the explicit
// result".
func TestDrainsBufferedEventsAfterEndAndResolvesResult(t *testing.T) {
	stream := NewEventStream[float64, string](
		func(event float64) bool { return false },
		func(event float64) string { return "" },
	)
	stream.Push(1)
	stream.Push(2)

	complete := "complete"
	stream.End(&complete)

	result, err := stream.Result(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "complete" {
		t.Fatalf("expected \"complete\", got %q", result)
	}

	events := drain[float64, string](t, stream)
	if !reflect.DeepEqual(events, []float64{1, 2}) {
		t.Fatalf("expected [1 2], got %v", events)
	}
}

// Ports test: "wakes all waiting consumers when ended without a result".
func TestWakesAllWaitingConsumersWhenEndedWithoutResult(t *testing.T) {
	stream := NewEventStream[float64, float64](
		func(event float64) bool { return false },
		func(event float64) float64 { return event },
	)

	first := stream.Next()
	second := stream.Next()

	stream.End(nil)

	firstItem := mustReceive(t, first)
	if !firstItem.Done {
		t.Fatalf("expected first consumer Done, got %+v", firstItem)
	}
	secondItem := mustReceive(t, second)
	if !secondItem.Done {
		t.Fatalf("expected second consumer Done, got %+v", secondItem)
	}
}

// Additional behavior: Result respects context cancellation when no result is
// resolved (End(nil) does not resolve).
func TestResultRespectsContextCancellation(t *testing.T) {
	stream := NewEventStream[float64, float64](
		func(event float64) bool { return false },
		func(event float64) float64 { return event },
	)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := stream.Result(ctx)
	if err == nil {
		t.Fatalf("expected context error, got nil")
	}
}

// Additional behavior: the first resolved result wins, even if a later End
// supplies a different value.
func TestFirstResultWins(t *testing.T) {
	stream := NewEventStream[float64, float64](
		func(event float64) bool { return event == 7 },
		func(event float64) float64 { return event },
	)
	stream.Push(7)
	other := 99.0
	stream.End(&other)

	result, err := stream.Result(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != 7 {
		t.Fatalf("expected first result 7, got %v", result)
	}
}

// Additional behavior: Next yields Done immediately once the stream is done and
// the buffer is empty.
func TestNextYieldsDoneAfterEnd(t *testing.T) {
	stream := NewEventStream[float64, float64](
		func(event float64) bool { return false },
		func(event float64) float64 { return event },
	)
	stream.End(nil)

	item := mustReceive(t, stream.Next())
	if !item.Done {
		t.Fatalf("expected Done, got %+v", item)
	}
}

// Additional behavior: concurrent producers and consumers do not race and
// every non-completing event is delivered exactly once.
func TestConcurrentPushAndNext(t *testing.T) {
	const n = 200
	stream := NewEventStream[int, int](
		func(event int) bool { return false },
		func(event int) int { return event },
	)

	var wg sync.WaitGroup
	received := make([]int, 0, n)
	var recvMu sync.Mutex

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(v int) {
			defer wg.Done()
			item := <-stream.Next()
			if !item.Done {
				recvMu.Lock()
				received = append(received, item.Value)
				recvMu.Unlock()
			}
		}(i)
		stream.Push(i)
	}
	wg.Wait()

	if len(received) != n {
		t.Fatalf("expected %d received events, got %d", n, len(received))
	}
}

func drain[T any, R any](t *testing.T, stream *EventStream[T, R]) []T {
	t.Helper()
	var events []T
	for {
		item := mustReceive(t, stream.Next())
		if item.Done {
			return events
		}
		events = append(events, item.Value)
	}
}

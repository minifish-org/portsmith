import path from "node:path";
import { pathToFileURL } from "node:url";

type Step = {
  op: "push" | "end" | "next" | "wait" | "take" | "result";
  value?: number;
};
type Case = { name: string; complete: number; steps: Step[] };
const push = (value: number): Step => ({ op: "push", value });
const next: Step = { op: "next" };
const result: Step = { op: "result" };
export const cases: Case[] = [
  {
    name: "completion retains event and ignores later pushes",
    complete: 3,
    steps: [push(1), push(2), push(3), push(4), result, next, next, next, next],
  },
  {
    name: "interleaved draining",
    complete: -1,
    steps: [
      push(1),
      push(2),
      next,
      push(3),
      next,
      next,
      { op: "end", value: 7 },
      next,
      result,
    ],
  },
  {
    name: "explicit end preserves queue",
    complete: -1,
    steps: [
      push(5),
      push(6),
      { op: "end", value: 42 },
      push(7),
      result,
      next,
      next,
      next,
    ],
  },
  {
    name: "registered waiters are FIFO",
    complete: -1,
    steps: [
      { op: "wait" },
      { op: "wait" },
      push(7),
      push(8),
      { op: "take" },
      { op: "take" },
      { op: "end" },
      next,
    ],
  },
  {
    name: "end without result wakes waiters",
    complete: -1,
    steps: [
      { op: "wait" },
      { op: "wait" },
      { op: "end" },
      { op: "take" },
      { op: "take" },
    ],
  },
  {
    name: "first result wins",
    complete: 3,
    steps: [push(3), { op: "end", value: 99 }, result, next, next],
  },
  {
    name: "end can later resolve an absent result",
    complete: -1,
    steps: [{ op: "end" }, { op: "end", value: 0 }, result, next],
  },
];

// A fixed runner outside candidate/ supplies the same operations to the original TS and Go.
// Passing this suite establishes these cases only, not complete Pi compatibility.
export async function eventStreamOracle(root: string) {
  const modulePath = path.join(
    root,
    "references/packages/ai/src/utils/event-stream.ts",
  );
  const { EventStream } = await import(pathToFileURL(modulePath).href);
  const golden = [];
  for (const scenario of cases) {
    const stream = new EventStream(
      (n: number) => n === scenario.complete,
      (n: number) => n,
    );
    const iterator = stream[Symbol.asyncIterator]();
    const waiting: Promise<IteratorResult<number>>[] = [];
    const trace: unknown[] = [];
    const item = (value: IteratorResult<number>) => ({
      done: value.done === true,
      value: value.done ? 0 : value.value,
    });
    for (const step of scenario.steps) {
      if (step.op === "push") stream.push(step.value);
      if (step.op === "end") stream.end(step.value);
      if (step.op === "next") trace.push(item(await iterator.next()));
      if (step.op === "wait")
        waiting.push(stream[Symbol.asyncIterator]().next());
      if (step.op === "take") trace.push(item(await waiting.shift()!));
      if (step.op === "result") trace.push({ result: await stream.result() });
    }
    golden.push({ ...scenario, expected: trace });
  }
  return golden;
}

export const goOracle = `package port
import ("context"; "encoding/json"; "os"; "reflect"; "testing"; "time")
func TestPortOracle(t *testing.T) {
 var cases []struct { Name string; Complete int; Steps []struct { Op string; Value *int }; Expected []any }
 data, err := os.ReadFile("port_oracle.json"); if err != nil { t.Fatal(err) }
 if err := json.Unmarshal(data, &cases); err != nil { t.Fatal(err) }
 for _, c := range cases { t.Run(c.Name, func(t *testing.T) {
  s := NewEventStream[int,int](func(n int) bool { return n == c.Complete }, func(n int) int { return n })
  waiting := []<-chan StreamItem[int]{}; trace := []any{}
  receive := func(ch <-chan StreamItem[int]) {
   select { case v, ok := <-ch:
    if !ok { t.Fatal("Next closed without an item") }; value := v.Value; if v.Done { value = 0 }
    trace = append(trace, map[string]any{"done":v.Done,"value":value})
   case <-time.After(time.Second): t.Fatal("Next blocked") }
  }
  for _, step := range c.Steps { switch step.Op {
   case "push": s.Push(*step.Value)
   case "end": s.End(step.Value)
   case "wait": waiting = append(waiting, s.Next())
   case "take": receive(waiting[0]); waiting = waiting[1:]
   case "next": receive(s.Next())
   case "result":
    ctx, cancel := context.WithTimeout(context.Background(),time.Second)
    value, err := s.Result(ctx); cancel(); if err != nil { t.Fatal(err) }
    trace = append(trace,map[string]any{"result":value})
  } }
  encoded, _ := json.Marshal(trace); var normalized []any; _ = json.Unmarshal(encoded,&normalized)
  if !reflect.DeepEqual(normalized,c.Expected) { t.Fatalf("trace %s != TS %v",encoded,c.Expected) }
 }) }
}
func TestPortResultCancellation(t *testing.T) {
 s := NewEventStream[int,int](func(int)bool{return false},func(n int)int{return n})
 s.End(nil)
 ctx, cancel := context.WithTimeout(context.Background(),20*time.Millisecond); defer cancel()
 if _, err := s.Result(ctx); err == nil { t.Fatal("End(nil) must not resolve an absent result") }
}
`;

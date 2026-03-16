# nodellmdebug — Skateboard PRD

## The scenario

A Deno web server has a bug: `GET /api/users` should return users filtered by
`role` query param, but it returns all users regardless. A human would set a
breakpoint on the filter line and check if the query param is being read
correctly. We do the same thing — but in batch.

### The buggy app (we ship this as a test fixture)

```ts
// test_app/server.ts
const users = [
  { name: "Alice", role: "admin" },
  { name: "Bob", role: "user" },
  { name: "Charlie", role: "user" },
];

Deno.serve({ port: 3000 }, (req: Request) => {
  const url = new URL(req.url);
  const role = url.searchParams.get("role");
  const filtered = users.filter((u) => u.role === role);
  // Bug: returns `users` instead of `filtered`
  return new Response(JSON.stringify(users));
});
```

The bug is obvious from reading the code — but that's the point. The skateboard
proves the tool works on a case where we already know the answer.

## What the skateboard does

1. **Launch** the buggy app with `--inspect`
2. **Connect** to the V8 inspector via WebSocket (CDP)
3. **Set breakpoints** on 3 lines: the `role` assignment, the `filter` call, and
   the `return`
4. **Fire the trigger**: `curl http://localhost:3000/api/users?role=admin`
5. **At each breakpoint pause**, capture all local variables in parallel
6. **Resume** to the next breakpoint automatically
7. **Output** the trace as JSON to stdout
8. **Kill** the target process

## Actual output

```json
{
  "file": "test_app/server.ts",
  "trigger": "curl http://localhost:3000/api/users?role=admin",
  "steps": [
    {
      "line": 9,
      "source": "const role = url.searchParams.get(\"role\");",
      "locals": {
        "req": "[Request]",
        "url": "http://localhost:3000/api/users?role=admin"
      }
    },
    {
      "line": 11,
      "source": "const filtered = users.filter((u) => u.role === role);",
      "locals": {
        "req": "[Request]",
        "url": "http://localhost:3000/api/users?role=admin",
        "role": "admin"
      }
    },
    {
      "line": 13,
      "source": "return new Response(JSON.stringify(users));",
      "locals": {
        "req": "[Request]",
        "url": "http://localhost:3000/api/users?role=admin",
        "role": "admin",
        "filtered": [{ "name": "Alice", "role": "admin" }]
      }
    }
  ]
}
```

## How the LLM reads this trace

Step 3 is the anomaly. `filtered` has 1 user (correct), but the return statement
uses `users` (all 3) instead of `filtered`. The variable names in the return
expression don't match the filtered result. Bug found.

## What anomaly scanning looks like

The LLM doesn't need fancy heuristics. It reads the trace and asks:

- Does the return value match what the filter produced? **No.** `filtered` has 1
  item, response has 3.
- Is there a variable that was computed but never used in the output? **Yes.**
  `filtered` is computed but the return uses `users`.

That's the bug. Two simple checks on structured data.

## Scope — what's IN the skateboard

- WebSocket connection to V8 inspector
- `Debugger.enable`, `Debugger.setBreakpoint`, `Debugger.paused`,
  `Debugger.resume`
- `Debugger.evaluateOnCallFrame` to capture locals (fired in parallel per pause)
- Breakpoint lines configurable via CLI args (`--lines 10,11,13`) — not
  hardcoded
- JSON trace to stdout, diagnostic logs to stderr
- Nonzero exit code on connection failure or crash
- Process launch and teardown via `sh -c`
- Two test fixtures:
  - `test_app/server.ts` — logic bug (static analysis can catch it)
  - `test_app/order_server.ts` — data bug (only the debugger catches it)
- BDD test suite (`test_app/order_test.ts`)

## Scope — what's NOT in the skateboard

- Smart breakpoint selection (LLM chooses lines, but no auto-detection)
- Expression watch lists
- Multi-file tracing
- Filtering/summarization
- Any UI
- npm packaging
- `--help` / CLI usage output
- Log files

## The real scenario — a bug static analysis can't catch

The order server calculates `promoAmount + handlingFee + product.price`. The
code is correct. The type annotation says `amount: number`. But a legacy CSV
import wrote the promo amount as `"15"` (string) to Deno KV. The `+` operator
concatenates: `"15" + 5 + 49.99 = "15549.99"`.

No linter, type checker, or static analysis catches this — the code is correct,
the data is wrong.

### Debugger trace

```json
{
  "steps": [
    {
      "line": 21,
      "source": "promoAmount = promo.amount;",
      "locals": { "promoAmount": 0 }
    },
    {
      "line": 26,
      "source": "const total = promoAmount + handlingFee + product.price;",
      "locals": {
        "promoAmount": "15",
        "handlingFee": 5,
        "product": { "name": "Mouse", "price": 49.99 }
      }
    }
  ]
}
```

`promoAmount` is `"15"` — a string in quotes. Bug found. Fix:
`Number(promo.amount)` or validate at the data boundary.

## Success criteria

Run it. Read the JSON. Find the bug without reading the source code. If an LLM
can do that from the trace alone, the skateboard works.

---

## Bike

- **Edge cases**: Handle missing query params, malformed URLs, server errors
  gracefully instead of crashing
- **Error handling**: Detect when the target process fails to start or the
  WebSocket connection drops, with clear error messages
- **Multiple files**: Support breakpoints across multiple files in a single
  trace
- **Smart breakpoint selection**: LLM chooses where to set breakpoints based on
  static analysis of the code, instead of hardcoding
- **Extensible output format**: JSON schema that accommodates watch expressions,
  multi-file traces, and metadata without breaking consumers

## Car

- **Automated validation**: Test harness that runs the debugger on known-buggy
  fixtures and checks whether the trace is sufficient to identify the bug
- **Performance**: Handle large functions and files with many breakpoints
  without overwhelming the LLM's context window — filtering, summarization,
  layered traces
- **Watch expressions**: User-defined or LLM-defined expressions to evaluate at
  each breakpoint beyond just locals
- **CLI polish**: Proper arg parsing, help text, `--attach` mode for
  already-running processes

## Bus

- **Runtime support**: Explicit testing and documentation for Node.js,
  Chrome/Chromium, and future V8-based runtimes beyond Deno
- **Distribution**: npm/deno package, `npx` invocation, integration as an MCP
  tool
- **IDE integration**: Plugin or extension that lets an LLM-in-an-IDE trigger
  debug sessions
- **Multi-session tracing**: Correlate traces across multiple requests or
  process restarts

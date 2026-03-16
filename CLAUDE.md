# nodellmdebug

## What this is

A debugger designed for LLMs. Instead of interactive step-through debugging
(built for humans), this debugger captures full execution state in batch mode —
every line, every variable, every branch — in a single pass. An LLM reads the
complete trace and reasons about bugs from full context rather than stepping
through code one line at a time.

## Why this exists

LLMs can read code but can't interact with a debugger. When debugging, an LLM
has to guess runtime state from static code. This tool gives LLMs actual runtime
state — the same information a human gets from a debugger session, but delivered
all at once instead of interactively.

A human debugger session is serial: breakpoint, inspect, think, step, repeat.
Most debugging questions are independent. This tool asks them all in parallel,
collapsing an interactive session into a single batch execution.

## How it works

1. Connects to a V8 runtime via the Chrome DevTools Protocol (WebSocket)
2. Sets breakpoints on every line of a target function/file
3. Triggers execution (e.g. an HTTP request)
4. At each breakpoint pause: captures all local variables, scope chain, and
   evaluates expressions
5. Auto-resumes to the next breakpoint
6. Returns the full execution trace as structured JSON

## Target runtimes

Any V8-based runtime that supports `--inspect`:

- Deno (`deno run --inspect`)
- Node.js (`node --inspect`)
- Chrome/Chromium

## Tech stack

- Deno (for the debugger tool itself)
- Chrome DevTools Protocol over WebSocket
- Zero dependencies

## How the LLM uses this (no human in the loop)

The LLM does everything itself:

1. Launches the target process with `--inspect` (e.g.
   `deno run --inspect --allow-net src/main.ts`)
2. Runs `nodellmdebug` to connect, set breakpoints, and capture state
3. Fires the trigger (e.g. `curl http://localhost:3000/api/videogames`)
4. Reads the JSON trace output
5. Kills the target process when done

No F5. No IDE. No human clicking buttons. The LLM has full control of the debug
lifecycle from the terminal.

## CLI interface

```bash
deno run --allow-all jsr:@gman622/llmdebug \
  --run "deno run --inspect --allow-net your-app.ts" \
  --target "your-app.ts" \
  --lines "9,11,13" \
  --trigger "curl http://localhost:3000/your-endpoint"
```

Arguments:

- `--run`: Command to launch the target process (must include `--inspect`)
- `--target`: Source file to set breakpoints in
- `--lines`: Comma-separated line numbers (1-indexed)
- `--trigger`: Command that causes the target code to execute

## Output format

```json
{
  "file": "test_app/server.ts",
  "trigger": "curl http://localhost:3000/?role=admin",
  "steps": [
    {
      "line": 9,
      "source": "const role = url.searchParams.get(\"role\");",
      "locals": {
        "req": "[Request]",
        "url": "http://localhost:3000/?role=admin"
      }
    },
    {
      "line": 11,
      "source": "const filtered = users.filter((u) => u.role === role);",
      "locals": { "role": "admin" }
    },
    {
      "line": 13,
      "source": "return new Response(JSON.stringify(users));",
      "locals": {
        "role": "admin",
        "filtered": [{ "name": "Alice", "role": "admin" }]
      }
    }
  ]
}
```

## Testing

```bash
deno test --allow-all --unstable-kv src/main_test.ts
```

Integration tests in `src/main_test.ts` cover all 4 test fixtures, error
handling, edge cases, and output format validation (46 test steps).

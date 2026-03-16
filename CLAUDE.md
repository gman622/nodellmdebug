# nodellmdebug

## What this is

A debugger designed for LLMs. Instead of interactive step-through debugging (built for humans), this debugger captures full execution state in batch mode — every line, every variable, every branch — in a single pass. An LLM reads the complete trace and reasons about bugs from full context rather than stepping through code one line at a time.

## Why this exists

LLMs can read code but can't interact with a debugger. When debugging, an LLM has to guess runtime state from static code. This tool gives LLMs actual runtime state — the same information a human gets from a debugger session, but delivered all at once instead of interactively.

A human debugger session is serial: breakpoint, inspect, think, step, repeat. Most debugging questions are independent. This tool asks them all in parallel, collapsing an interactive session into a single batch execution.

## How it works

1. Connects to a V8 runtime via the Chrome DevTools Protocol (WebSocket)
2. Sets breakpoints on every line of a target function/file
3. Triggers execution (e.g. an HTTP request)
4. At each breakpoint pause: captures all local variables, scope chain, and evaluates expressions
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

1. Launches the target process with `--inspect` (e.g. `deno run --inspect --allow-net src/main.ts`)
2. Runs `nodellmdebug` to connect, set breakpoints, and capture state
3. Fires the trigger (e.g. `curl http://localhost:3000/api/videogames`)
4. Reads the JSON trace output
5. Kills the target process when done

No F5. No IDE. No human clicking buttons. The LLM has full control of the debug lifecycle from the terminal.

## CLI interface (planned)

```bash
# Full self-contained debug session — launches the process, debugs, and tears down
nodellmdebug --run "deno run --inspect --allow-net --unstable-kv src/main.ts" \
  --target src/routes/videoGames.ts --function handleVideoGames \
  --trigger "curl http://localhost:3000/api/videogames"

# Attach to an already-running process
nodellmdebug --attach localhost:9229 \
  --target src/db.ts --lines 24-32 \
  --trigger "curl -X POST http://localhost:3000/api/videogames -d '{...}'"
```

## Output format (planned)

```json
{
  "file": "src/routes/videoGames.ts",
  "function": "handleVideoGames",
  "trigger": "curl http://localhost:3000/api/videogames",
  "steps": [
    {
      "line": 5,
      "source": "const url = new URL(req.url);",
      "locals": {
        "req": { "method": "GET", "url": "http://localhost:3000/api/videogames" }
      }
    },
    {
      "line": 6,
      "source": "const path = url.pathname;",
      "locals": {
        "req": "...",
        "url": "http://localhost:3000/api/videogames",
        "path": "/api/videogames"
      }
    }
  ]
}
```

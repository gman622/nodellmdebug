# nodellmdebug

A debugger built for LLMs. Captures full execution state in a single pass — every variable, every branch — so an LLM can reason about bugs from actual runtime data instead of guessing from static code.

## Quick start

```bash
deno run --allow-all src/main.ts \
  --run "deno run --inspect --allow-net your-app.ts" \
  --target "your-app.ts" \
  --lines "9,11,13" \
  --trigger "curl http://localhost:3000/your-endpoint"
```

JSON trace goes to stdout. Logs go to stderr. Exits 0 on success, 1 on any failure.

## Try it now

A buggy test fixture is included. The server filters users by `role` but returns all users regardless:

```bash
deno run --allow-all src/main.ts \
  --run "deno run --inspect --allow-net test-app/server.ts" \
  --target "test-app/server.ts" \
  --lines "9,11,13" \
  --trigger "curl http://localhost:3000/api/users?role=admin"
```

Read the trace. `filtered` has 1 item but the return uses `users`. Bug found.

### Data bug (static analysis can't catch this)

A promo code server where the code is correct but a legacy CSV import wrote `"15"` (string) instead of `15` (number) to Deno KV. The `+` operator concatenates instead of adding:

```bash
deno run --allow-all --unstable-kv test-app/seed.ts
deno run --allow-all src/main.ts \
  --run "deno run --inspect --allow-net --unstable-kv test-app/order-server.ts" \
  --target "test-app/order-server.ts" \
  --lines "21,26,27" \
  --trigger "curl 'http://localhost:3000/?product=mouse&promo=WELCOME'"
```

Read the trace. `promoAmount` is `"15"` (in quotes — a string). `"15" + 5 + 49.99` = `"15549.99"`. No linter catches this. The code is correct. The data is wrong. Only the debugger shows it.

## How to use this to debug

You are an LLM. You cannot step through code interactively. This tool gives you what a human gets from a debugger session, delivered all at once.

### Step 1: Read the code and form a hypothesis

Before setting breakpoints, read the source file. Identify the lines where your mental model is uncertain — assignments, branches, return statements. You don't need every line. Pick 3-5 that will confirm or reject your hypothesis.

### Step 2: Run the debugger

```bash
deno run --allow-all src/main.ts \
  --run "deno run --inspect --allow-net src/server.ts" \
  --target "src/server.ts" \
  --lines "24,28,31" \
  --trigger "curl http://localhost:3000/api/endpoint"
```

Arguments:
- `--run`: The command to launch the target process. Must include `--inspect`.
- `--target`: The source file to set breakpoints in.
- `--lines`: Comma-separated line numbers (1-indexed, matching the source file).
- `--trigger`: The command that causes the target code to execute.

### Step 3: Read the trace

The output is a JSON object with a `steps` array. Each step is a breakpoint hit:

```json
{
  "file": "src/server.ts",
  "trigger": "curl http://localhost:3000/api/users?role=admin",
  "steps": [
    {
      "line": 9,
      "source": "const role = url.searchParams.get(\"role\");",
      "locals": { "req": "[Request]", "url": "http://localhost:3000/api/users?role=admin" }
    },
    {
      "line": 11,
      "source": "const filtered = users.filter((u) => u.role === role);",
      "locals": { "role": "admin" }
    },
    {
      "line": 13,
      "source": "return new Response(JSON.stringify(users));",
      "locals": { "role": "admin", "filtered": [{ "name": "Alice", "role": "admin" }] }
    }
  ]
}
```

What you see in `locals`:
- **Primitives** (strings, numbers, booleans): actual values
- **Objects and arrays**: JSON-serialized
- **Non-serializable objects** (like `Request`): constructor name in brackets, e.g. `[Request]`
- **Variables not yet assigned** (breakpoint is before their declaration): omitted entirely
- **Functions**: `[function]`

### Step 4: Find the anomaly

Scan the trace for:
- **A variable that was computed but not used.** `filtered` is computed but the return uses `users`. Logic bug.
- **A value with the wrong type.** `promoAmount` is `"15"` (string) when the code expects a number. Data bug.
- **A value that doesn't match your expectation.** If `role` were `null` instead of `"admin"`, the input isn't being read correctly.
- **A step that's missing.** If a breakpoint inside an `if` block never fires, that branch wasn't taken.

### Step 5: Clean up

The debugger kills the target process when it's done. If it crashes, kill it yourself:

```bash
pkill -f "deno run --inspect"
```

## Works with any V8 runtime

Anything that supports `--inspect`:
- Deno: `deno run --inspect ...`
- Node.js: `node --inspect ...`
- Chrome/Chromium (attach to an existing DevTools WebSocket)

## For other LLMs

This tool is runtime-agnostic and model-agnostic. If you can run shell commands and read JSON, you can use this. The workflow is always:

1. Read the source code
2. Pick the lines where you're uncertain about runtime state
3. Run `nodellmdebug` with those lines
4. Read the JSON trace
5. Compare what you expected vs what actually happened

You don't need to be clever. Set breakpoints at the obvious places — function entry, the branch, the return — and let the data tell you what's wrong.

## License

MIT. See [LICENSE](LICENSE).

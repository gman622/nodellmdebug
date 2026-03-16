// nodellmdebug — skateboard
// Batch debugger for LLMs: launch, breakpoint, capture, dump, kill.

interface Step {
  line: number;
  source: string;
  locals: Record<string, unknown>;
}

interface Trace {
  file: string;
  trigger: string;
  steps: Step[];
}

interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { message: string };
  method?: string;
  params?: Record<string, unknown>;
}

// --- CLI arg parsing ---

function parseArgs(args: string[]): {
  run: string;
  target: string;
  lines: number[];
  trigger: string;
} {
  const flagMap: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flagMap[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  const missing = ["run", "target", "lines", "trigger"].filter(
    (f) => !flagMap[f],
  );
  if (missing.length > 0) {
    console.error(
      `Missing required flags: ${missing.map((f) => `--${f}`).join(", ")}`,
    );
    console.error(
      `Usage: deno run --allow-all src/main.ts --run "deno run --inspect ..." --target file.ts --lines 10,11,13 --trigger "curl ..."`,
    );
    Deno.exit(1);
  }

  return {
    run: flagMap.run,
    target: flagMap.target,
    lines: flagMap.lines.split(",").map((n) => parseInt(n.trim(), 10)),
    trigger: flagMap.trigger,
  };
}

// --- CDP WebSocket client ---

class CDPClient {
  private ws: WebSocket;
  private msgId = 0;
  private pending = new Map<number, {
    resolve: (v: CDPResponse) => void;
    reject: (e: Error) => void;
  }>();
  private eventHandlers = new Map<
    string,
    (params: Record<string, unknown>) => void
  >();
  private ready: Promise<void>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`WebSocket error: ${e}`));
    });
    this.ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string) as CDPResponse;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg);
        }
      } else if (msg.method) {
        const handler = this.eventHandlers.get(msg.method);
        if (handler) handler(msg.params ?? {});
      }
    };
  }

  async connect(): Promise<void> {
    await this.ready;
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<CDPResponse> {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: Record<string, unknown>) => void): void {
    this.eventHandlers.set(event, handler);
  }

  close(): void {
    this.ws.close();
  }
}

// --- Extract inspector WS URL from process stderr ---

async function getInspectorUrl(process: Deno.ChildProcess): Promise<string> {
  const reader = process.stderr.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const timeout = setTimeout(() => {
    throw new Error("Timed out waiting for inspector URL");
  }, 10000);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("Process exited before inspector URL was found");
      }
      buffer += decoder.decode(value);
      const match = buffer.match(/ws:\/\/[^\s]+/);
      if (match) {
        reader.releaseLock();
        return match[0];
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

// --- Extract locals from scope chain ---

async function captureLocalsFromScopes(
  cdp: CDPClient,
  callFrame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const locals: Record<string, unknown> = {};
  const scopeChain = callFrame.scopeChain as Array<Record<string, unknown>>;
  const callFrameId = callFrame.callFrameId as string;

  // First, get variable names from the local scope
  for (const scope of scopeChain) {
    if (scope.type !== "local") continue;
    const obj = scope.object as Record<string, unknown>;
    const objectId = obj.objectId as string;

    const propsResult = await cdp.send("Runtime.getProperties", {
      objectId,
      ownProperties: true,
    });

    const result = propsResult.result as Record<string, unknown>;
    const descriptors = result.result as Array<Record<string, unknown>>;
    if (!descriptors) continue;

    // Collect variable names, then evaluate each with JSON.stringify on the call frame
    const varNames = descriptors
      .map((d) => d.name as string)
      .filter((n) => !n.startsWith("__"));

    // Evaluate all variables in parallel
    const evaluations = await Promise.all(
      varNames.map(async (name) => {
        try {
          const evalResult = await cdp.send("Debugger.evaluateOnCallFrame", {
            callFrameId,
            expression: `${name}`,
            returnByValue: false, // get RemoteObject, not value
          });
          const r = evalResult.result as Record<string, unknown>;
          const inner = r.result as Record<string, unknown>;

          // Check for errors (TDZ, ReferenceError)
          if (
            inner?.subtype === "error" ||
            (inner as Record<string, unknown>)?.className?.toString().includes(
              "Error",
            )
          ) {
            return { name, value: null };
          }
          // Also check exceptionDetails
          const exceptionDetails = r.exceptionDetails as
            | Record<string, unknown>
            | undefined;
          if (exceptionDetails) {
            return { name, value: null };
          }

          // Primitive values
          if (
            inner?.type === "string" || inner?.type === "number" ||
            inner?.type === "boolean"
          ) {
            return { name, value: inner.value };
          }
          if (inner?.type === "undefined") {
            return { name, value: null };
          }
          if (inner?.subtype === "null") {
            return { name, value: null };
          }
          if (inner?.type === "function") {
            return { name, value: "[function]" };
          }

          // Objects/arrays: use JSON.stringify via a second eval
          if (inner?.type === "object" && inner.objectId) {
            const jsonEval = await cdp.send("Debugger.evaluateOnCallFrame", {
              callFrameId,
              expression: `(() => {
                try {
                  const v = ${name};
                  const s = JSON.stringify(v);
                  if (s && s !== '{}') return s;
                  // Fallback for non-serializable objects
                  return '"[' + (v.constructor?.name || 'Object') + ']"';
                } catch(e) { return '"[' + (typeof ${name}) + ']"'; }
              })()`,
              returnByValue: true,
            });
            const jr = jsonEval.result as Record<string, unknown>;
            const jInner = jr.result as Record<string, unknown>;
            if (jInner?.value && typeof jInner.value === "string") {
              try {
                return { name, value: JSON.parse(jInner.value) };
              } catch { /* parse failed */ }
              return { name, value: jInner.value };
            }
          }

          return { name, value: `[${inner?.type ?? "unknown"}]` };
        } catch {
          return { name, value: "<capture-error>" };
        }
      }),
    );

    for (const { name, value } of evaluations) {
      if (value !== null) {
        locals[name] = value;
      }
    }
  }
  return locals;
}

// --- TS-to-compiled line mapping ---

function findCompiledLine(
  tsLine: number,
  originalLines: string[],
  compiledLines: string[],
): number {
  const tsContent = originalLines[tsLine - 1]?.trim();
  if (!tsContent) return -1;

  // Strip type annotations and normalize whitespace for matching
  const stripped = tsContent
    .replace(/:\s*\w+(\[\])?/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();

  for (let i = 0; i < compiledLines.length; i++) {
    const compiled = compiledLines[i].trim().replace(/\s+/g, "").toLowerCase();
    if (compiled.includes(stripped) || stripped.includes(compiled)) {
      return i;
    }
  }

  // Fuzzy: match on key identifiers
  const identifiers = tsContent.match(/\b\w+\b/g) || [];
  const significantIds = identifiers.filter(
    (id) =>
      !["const", "let", "var", "return", "new", "function", "if", "else", "for"]
        .includes(id),
  );
  for (let i = 0; i < compiledLines.length; i++) {
    const compiled = compiledLines[i];
    if (
      significantIds.length > 0 &&
      significantIds.every((id) => compiled.includes(id))
    ) {
      return i;
    }
  }

  return -1;
}

// --- Main ---

async function main() {
  const config = parseArgs(Deno.args);
  const steps: Step[] = [];

  // Resolve target to absolute path for URL matching
  const targetAbsolute = Deno.realPathSync(config.target);
  const targetFileUrl = `file://${targetAbsolute}`;
  console.error(`[nodellmdebug] Target file URL: ${targetFileUrl}`);

  // Launch target process
  console.error(`[nodellmdebug] Launching: ${config.run}`);
  const parts = config.run.split(" ");
  const proc = new Deno.Command(parts[0], {
    args: parts.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let cdp: CDPClient | undefined;

  try {
    // Get inspector URL
    const wsUrl = await getInspectorUrl(proc);
    console.error(`[nodellmdebug] Inspector at: ${wsUrl}`);

    // Connect CDP
    cdp = new CDPClient(wsUrl);
    await cdp.connect();
    console.error("[nodellmdebug] Connected to inspector");

    // Register scriptParsed handler BEFORE enabling debugger
    let targetScriptId: string | undefined;
    cdp.on("Debugger.scriptParsed", (params) => {
      const url = params.url as string;
      if (url && url.includes(config.target.replace(/^\.\//, ""))) {
        console.error(
          `[nodellmdebug] Found target script: ${url} (scriptId=${params.scriptId})`,
        );
        targetScriptId = params.scriptId as string;
      }
    });

    // Enable debugger and runtime — this triggers scriptParsed events
    await cdp.send("Debugger.enable", {});
    await cdp.send("Runtime.enable", {});

    // Give event handlers time to process
    await new Promise((r) => setTimeout(r, 500));

    if (!targetScriptId) {
      console.error("[nodellmdebug] ERROR: Could not find target script");
      Deno.exit(1);
    }

    // Get compiled source and build source map: TS line -> compiled line
    const sourceResp = await cdp.send("Debugger.getScriptSource", {
      scriptId: targetScriptId,
    });
    const sourceResult = sourceResp.result as Record<string, unknown>;
    const compiledSource = sourceResult.scriptSource as string;
    const compiledLines = compiledSource.split("\n");

    // Read the original TS source
    const originalSource = await Deno.readTextFile(config.target);
    const originalLines = originalSource.split("\n");

    // Set breakpoints on compiled lines using scriptId
    // Build reverse map: compiled line (0-indexed) -> TS line (1-indexed)
    const compiledToTsLine = new Map<number, number>();

    for (const line of config.lines) {
      const compiledLine = findCompiledLine(line, originalLines, compiledLines);
      if (compiledLine === -1) {
        console.error(
          `[nodellmdebug] WARNING: Could not map TS line ${line} to compiled JS`,
        );
        continue;
      }
      compiledToTsLine.set(compiledLine, line);
      console.error(
        `[nodellmdebug] TS line ${line} ("${
          originalLines[line - 1]?.trim()
        }") -> compiled line ${compiledLine} ("${
          compiledLines[compiledLine]?.trim()
        }")`,
      );
      const result = await cdp.send("Debugger.setBreakpoint", {
        location: {
          scriptId: targetScriptId,
          lineNumber: compiledLine,
        },
      });
      console.error(
        `[nodellmdebug] Breakpoint set: ${JSON.stringify(result.result)}`,
      );
    }

    cdp.on("Debugger.paused", (params) => {
      // Handle synchronously by creating a promise chain
      const handle = async () => {
        const callFrames = params.callFrames as Array<Record<string, unknown>>;
        if (!callFrames || callFrames.length === 0) {
          await cdp!.send("Debugger.resume", {});
          return;
        }

        const topFrame = callFrames[0];
        const location = topFrame.location as Record<string, unknown>;
        const compiledLineNum = location.lineNumber as number; // 0-indexed

        // Map back to TS line number
        const tsLineNum = compiledToTsLine.get(compiledLineNum) ??
          (compiledLineNum + 1);
        const sourceLine = originalLines[tsLineNum - 1]?.trim() ??
          compiledLines[compiledLineNum]?.trim() ?? "";

        console.error(
          `[nodellmdebug] Paused at TS line ${tsLineNum} (compiled: ${compiledLineNum})`,
        );

        // Capture locals from scope chain
        const locals = await captureLocalsFromScopes(cdp!, topFrame);

        steps.push({ line: tsLineNum, source: sourceLine, locals });

        await cdp!.send("Debugger.resume", {});
      };

      handle().catch((err) => {
        console.error(`[nodellmdebug] Error in pause handler: ${err}`);
        cdp!.send("Debugger.resume", {}).catch(() => {});
      });
    });

    // Fire trigger
    console.error(`[nodellmdebug] Firing trigger: ${config.trigger}`);
    const triggerProc = new Deno.Command("sh", {
      args: ["-c", config.trigger],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Wait for trigger to complete
    const triggerStatus = await triggerProc.status;
    console.error(
      `[nodellmdebug] Trigger completed with status: ${triggerStatus.code}`,
    );

    // Give time for breakpoints to finish firing
    await new Promise((r) => setTimeout(r, 3000));

    // Build and output trace
    const trace: Trace = {
      file: config.target,
      trigger: config.trigger,
      steps: steps.sort((a, b) => a.line - b.line),
    };

    console.log(JSON.stringify(trace, null, 2));
  } catch (err) {
    console.error(`[nodellmdebug] Error: ${err}`);
    Deno.exit(1);
  } finally {
    // Cleanup
    cdp?.close();
    try {
      proc.kill("SIGTERM");
    } catch {
      // process may have already exited
    }
  }
}

main();

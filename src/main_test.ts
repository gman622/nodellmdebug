import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assert, assertEquals, assertExists } from "@std/assert";

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

/** Run nodellmdebug and return { trace, stdout, stderr, exitCode } */
async function runDebugger(
  args: { run: string; target: string; lines: string; trigger: string },
): Promise<
  { trace: Trace | null; stdout: string; stderr: string; exitCode: number }
> {
  const proc = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-all",
      "src/main.ts",
      "--run",
      args.run,
      "--target",
      args.target,
      "--lines",
      args.lines,
      "--trigger",
      args.trigger,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  const exitCode = output.code;

  let trace: Trace | null = null;
  if (stdout.trim()) {
    try {
      trace = JSON.parse(stdout) as Trace;
    } catch { /* not valid JSON */ }
  }

  return { trace, stdout, stderr, exitCode };
}

describe("nodellmdebug integration", () => {
  // Kill any leftover inspect processes before and after the suite
  beforeAll(async () => {
    const kill = new Deno.Command("pkill", {
      args: ["-f", "deno run --inspect"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    await kill.status.catch(() => {});
  });

  afterAll(async () => {
    const kill = new Deno.Command("pkill", {
      args: ["-f", "deno run --inspect"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    await kill.status.catch(() => {});
  });

  // Bug: server filters users by role but returns the unfiltered `users` array.
  // The trace should show `filtered` was computed correctly but never used in the return.
  describe("server.ts — filter bug", () => {
    let result: Awaited<ReturnType<typeof runDebugger>>;

    beforeAll(async () => {
      result = await runDebugger({
        run: "deno run --inspect --allow-net test-app/server.ts",
        target: "test-app/server.ts",
        lines: "9,11,13",
        trigger: "curl http://localhost:3000/?role=admin",
      });
    });

    it("should exit 0", () => {
      assertEquals(result.exitCode, 0);
    });

    it("should output valid JSON trace", () => {
      assertExists(result.trace, "trace should be valid JSON");
    });

    it("should set file and trigger in trace", () => {
      assertEquals(result.trace!.file, "test-app/server.ts");
      assertEquals(
        result.trace!.trigger,
        "curl http://localhost:3000/?role=admin",
      );
    });

    it("should capture all 3 breakpoint steps", () => {
      assertEquals(result.trace!.steps.length, 3);
    });

    it("should hit the expected lines in order", () => {
      const lines = result.trace!.steps.map((s) => s.line);
      assertEquals(lines, [9, 11, 13]);
    });

    it("should capture role = 'admin' at line 9", () => {
      const step = result.trace!.steps.find((s) => s.line === 9);
      assertExists(step);
      assert(
        step.source.includes("searchParams") || step.source.includes("role"),
      );
    });

    it("should capture filtered array at line 13 (the return)", () => {
      const step = result.trace!.steps.find((s) => s.line === 13);
      assertExists(step);
      assertExists(step.locals.filtered, "filtered should be captured");
      const filtered = step.locals.filtered as Array<Record<string, string>>;
      assertEquals(filtered.length, 1);
      assertEquals(filtered[0].name, "Alice");
      assertEquals(filtered[0].role, "admin");
    });

    it("should show the bug: return uses 'users' not 'filtered'", () => {
      const step = result.trace!.steps.find((s) => s.line === 13);
      assertExists(step);
      assert(
        step.source.includes("users") && !step.source.includes("filtered"),
        "return statement should reference 'users' (the bug)",
      );
    });
  });

  // Bug: `products.find((p) => p.id === id)` compares number === string.
  // `searchParams.get` returns a string, but product ids are numbers, so find() always misses.
  describe("server2.ts — type mismatch bug", () => {
    let result: Awaited<ReturnType<typeof runDebugger>>;

    beforeAll(async () => {
      result = await runDebugger({
        run: "deno run --inspect --allow-net test-app/server2.ts",
        target: "test-app/server2.ts",
        lines: "9,11,13",
        trigger: "curl http://localhost:3000/?id=1",
      });
    });

    it("should exit 0", () => {
      assertEquals(result.exitCode, 0);
    });

    it("should output valid JSON trace", () => {
      assertExists(result.trace);
    });

    it("should capture id as a string (the bug)", () => {
      const step = result.trace!.steps.find((s) => s.locals.id !== undefined);
      assertExists(step, "should have a step with id in locals");
      assertEquals(
        typeof step.locals.id,
        "string",
        "id should be a string from searchParams — the type mismatch bug",
      );
      assertEquals(step.locals.id, "1");
    });
  });

  // Validates CLI arg parsing: missing required flags should exit 1 with a helpful message.
  describe("missing flags — error handling", () => {
    it("should exit 1 when --run is missing", async () => {
      const proc = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-all",
          "src/main.ts",
          "--target",
          "test-app/server.ts",
          "--lines",
          "9",
          "--trigger",
          "curl http://localhost:3000",
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      const output = await proc.output();
      assertEquals(output.code, 1);

      const stderr = new TextDecoder().decode(output.stderr);
      assert(stderr.includes("--run"), "should mention missing --run flag");
    });

    it("should exit 1 when all flags are missing", async () => {
      const proc = new Deno.Command("deno", {
        args: ["run", "--allow-all", "src/main.ts"],
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      const output = await proc.output();
      assertEquals(output.code, 1);

      const stderr = new TextDecoder().decode(output.stderr);
      assert(stderr.includes("Missing required flags"));
    });
  });

  // Bug: a legacy CSV import wrote promo amount as "15" (string) to Deno KV.
  // The code does `promoAmount + handlingFee + price` which string-concatenates
  // instead of adding: "15" + 5 + 49.99 = "15549.99". The code is correct; the data is wrong.
  describe("order-server.ts — data type bug", () => {
    let result: Awaited<ReturnType<typeof runDebugger>>;

    beforeAll(async () => {
      // Seed the KV database first
      const seed = new Deno.Command("deno", {
        args: ["run", "--allow-all", "--unstable-kv", "test-app/seed.ts"],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      await seed.output();

      result = await runDebugger({
        run:
          "deno run --inspect --allow-net --unstable-kv test-app/order-server.ts",
        target: "test-app/order-server.ts",
        lines: "22,27",
        trigger: "curl 'http://localhost:3000/?product=mouse&promo=WELCOME'",
      });
    });

    it("should exit 0", () => {
      assertEquals(result.exitCode, 0);
    });

    it("should output valid JSON trace", () => {
      assertExists(result.trace);
    });

    it("should have steps in the trace", () => {
      assert(result.trace!.steps.length > 0, "should have at least one step");
    });

    it("should capture promoAmount as a string (the data bug)", () => {
      // Line 27: `const total = promoAmount + handlingFee + product.price`
      // By this point promoAmount has been assigned from KV as "15" (string)
      const step = result.trace!.steps.find((s) => s.line === 27);
      assertExists(step, "should have a step at line 27");
      assertExists(step.locals.promoAmount, "promoAmount should be in locals");
      assertEquals(
        typeof step.locals.promoAmount,
        "string",
        "promoAmount should be a string — the legacy CSV bug",
      );
      assertEquals(step.locals.promoAmount, "15");
    });
  });

  // Validates the debugger handles bad input gracefully: nonexistent target file,
  // invalid line numbers, bad trigger command.
  describe("unexpected input", () => {
    it("should exit 1 when target file does not exist", async () => {
      const result = await runDebugger({
        run: "deno run --inspect --allow-net test-app/server.ts",
        target: "nonexistent/file.ts",
        lines: "1",
        trigger: "curl http://localhost:3000",
      });
      assertEquals(result.exitCode, 1);
    });

    it("should exit 1 when --run command is invalid", async () => {
      const result = await runDebugger({
        run: "this-command-does-not-exist",
        target: "test-app/server.ts",
        lines: "9",
        trigger: "curl http://localhost:3000",
      });
      assertEquals(result.exitCode, 1);
    });

    it("should handle lines that don't map to compiled JS", async () => {
      // Line 1 is a comment — no compiled JS equivalent
      const result = await runDebugger({
        run: "deno run --inspect --allow-net test-app/server.ts",
        target: "test-app/server.ts",
        lines: "1",
        trigger: "curl http://localhost:3000/?role=admin",
      });
      // Should still exit 0 — unmapped lines are warnings, not errors
      assertEquals(result.exitCode, 0);
      assertExists(result.trace);
      assert(
        result.stderr.includes("WARNING") || result.trace!.steps.length === 0,
        "should warn about unmapped lines or produce an empty trace",
      );
    });
  });

  // Validates output formatting: JSON is well-formed, steps are sorted, stderr has logs.
  describe("output format", () => {
    let result: Awaited<ReturnType<typeof runDebugger>>;

    beforeAll(async () => {
      result = await runDebugger({
        run: "deno run --inspect --allow-net test-app/server.ts",
        target: "test-app/server.ts",
        lines: "9,13,11",
        trigger: "curl http://localhost:3000/?role=admin",
      });
    });

    it("should output pretty-printed JSON (indented)", () => {
      assert(result.stdout.includes("\n"), "JSON should be multi-line");
      assert(result.stdout.includes("  "), "JSON should be indented");
    });

    it("should sort steps by line number regardless of input order", () => {
      // Lines were passed as 9,13,11 but steps should be sorted 9,11,13
      assertExists(result.trace);
      const lines = result.trace!.steps.map((s) => s.line);
      const sorted = [...lines].sort((a, b) => a - b);
      assertEquals(lines, sorted);
    });

    it("should log to stderr (not pollute stdout)", () => {
      assert(
        result.stderr.includes("[nodellmdebug]"),
        "stderr should contain diagnostic logs",
      );
      // stdout should be pure JSON — first non-whitespace char should be {
      assertEquals(result.stdout.trim()[0], "{");
    });

    it("should include source text for each step", () => {
      assertExists(result.trace);
      for (const step of result.trace!.steps) {
        assert(
          step.source.length > 0,
          `step at line ${step.line} should have source text`,
        );
      }
    });
  });
});

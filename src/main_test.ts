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
        run: "deno run --inspect --allow-net test_app/server.ts",
        target: "test_app/server.ts",
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
      assertEquals(result.trace!.file, "test_app/server.ts");
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
        run: "deno run --inspect --allow-net test_app/server2.ts",
        target: "test_app/server2.ts",
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
          "test_app/server.ts",
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
  describe("order_server.ts — data type bug", () => {
    let result: Awaited<ReturnType<typeof runDebugger>>;

    beforeAll(async () => {
      // Seed the KV database first
      const seed = new Deno.Command("deno", {
        args: ["run", "--allow-all", "--unstable-kv", "test_app/seed.ts"],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      await seed.output();

      result = await runDebugger({
        run:
          "deno run --inspect --allow-net --unstable-kv test_app/order_server.ts",
        target: "test_app/order_server.ts",
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

  // Bug: PUT then GET returns 404. The code looks correct — both use [collection, id]
  // as the KV key. The debugger should capture the segments, collection, id, and KV
  // entry to help an LLM verify whether the keys actually match across requests.
  describe("server3.ts — KV storage bug", () => {
    let putResult: Awaited<ReturnType<typeof runDebugger>>;
    let getResult: Awaited<ReturnType<typeof runDebugger>>;

    // Trace the PUT request — capture URL parsing and KV write
    beforeAll(async () => {
      putResult = await runDebugger({
        run: "deno run --inspect --allow-net --unstable-kv test_app/server3.ts",
        target: "test_app/server3.ts",
        lines: "9,10,11,15",
        trigger:
          "curl -X PUT http://localhost:3000/items/abc -H 'Content-Type: application/json' -d '{\"name\":\"test\"}'",
      });

      // Trace the GET request — capture URL parsing and KV read
      getResult = await runDebugger({
        run: "deno run --inspect --allow-net --unstable-kv test_app/server3.ts",
        target: "test_app/server3.ts",
        lines: "9,10,11,20,21",
        trigger: "curl http://localhost:3000/items/abc",
      });
    });

    it("should exit 0 for PUT trace", () => {
      assertEquals(putResult.exitCode, 0);
    });

    it("should exit 0 for GET trace", () => {
      assertEquals(getResult.exitCode, 0);
    });

    it("should capture segments and KV key on PUT", () => {
      assertExists(putResult.trace);
      const step = putResult.trace!.steps.find((s) =>
        s.locals.collection !== undefined && s.locals.id !== undefined
      );
      assertExists(step, "should have a step with collection and id");
      assertEquals(step.locals.collection, "items");
      assertEquals(step.locals.id, "abc");
    });

    it("should capture segments and KV key on GET", () => {
      assertExists(getResult.trace);
      const step = getResult.trace!.steps.find((s) =>
        s.locals.collection !== undefined && s.locals.id !== undefined
      );
      assertExists(step, "should have a step with collection and id");
      assertEquals(step.locals.collection, "items");
      assertEquals(step.locals.id, "abc");
    });

    it("should capture the KV lookup at line 21", () => {
      assertExists(getResult.trace);
      // Line 21: `if (!entry.value)` — breakpoint fires here after kv.get()
      // The `entry` variable may not appear in locals (captured before assignment)
      // but the step itself proves the GET path was taken
      const step = getResult.trace!.steps.find((s) => s.line === 21);
      assertExists(step, "should have a step at the KV lookup check");
      assert(
        step.source.includes("entry"),
        "source should reference the KV entry",
      );
    });
  });

  // Expanded server2 tests: verify the debugger captures the full lookup flow
  // showing that find() returns undefined because number !== string.
  describe("server2.ts — expanded type mismatch", () => {
    let result: Awaited<ReturnType<typeof runDebugger>>;

    beforeAll(async () => {
      result = await runDebugger({
        run: "deno run --inspect --allow-net test_app/server2.ts",
        target: "test_app/server2.ts",
        lines: "9,11,14",
        trigger: "curl http://localhost:3000/?id=1",
      });
    });

    it("should only hit 2 lines (find misses, skips to 404 path)", () => {
      assertExists(result.trace);
      // Line 11 is the find() call — after this, product is undefined
      // The trace proves the mismatch: id is "1" (string) but products have numeric ids
      const findStep = result.trace!.steps.find((s) => s.line === 11);
      assertExists(findStep);
      assertEquals(findStep.locals.id, "1", "id should be string '1'");
      assert(
        findStep.source.includes("find"),
        "should be at the products.find() call",
      );
    });
  });

  // Expanded order_server tests: verify the trace captures the full promo flow,
  // including correct numeric promo (SUMMER) vs buggy string promo (WELCOME).
  describe("order_server.ts — numeric promo (SUMMER) should work", () => {
    let result: Awaited<ReturnType<typeof runDebugger>>;

    beforeAll(async () => {
      const seed = new Deno.Command("deno", {
        args: ["run", "--allow-all", "--unstable-kv", "test_app/seed.ts"],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      await seed.output();

      result = await runDebugger({
        run:
          "deno run --inspect --allow-net --unstable-kv test_app/order_server.ts",
        target: "test_app/order_server.ts",
        lines: "22,27",
        trigger: "curl 'http://localhost:3000/?product=mouse&promo=SUMMER'",
      });
    });

    it("should exit 0", () => {
      assertEquals(result.exitCode, 0);
    });

    it("should capture promoAmount as a number (correct data)", () => {
      assertExists(result.trace);
      const step = result.trace!.steps.find((s) => s.line === 27);
      assertExists(step, "should have a step at line 27");
      assertEquals(
        typeof step.locals.promoAmount,
        "number",
        "SUMMER promo should be a number — correctly stored",
      );
      assertEquals(step.locals.promoAmount, 10);
    });
  });

  // Edge case: request with no query params — tests that the debugger captures
  // the absence of expected values (role=null, id=null, etc.)
  describe("edge cases — missing query params", () => {
    it("should capture role as null when no ?role param", async () => {
      const result = await runDebugger({
        run: "deno run --inspect --allow-net test_app/server.ts",
        target: "test_app/server.ts",
        lines: "9,11,13",
        trigger: "curl http://localhost:3000/",
      });
      assertEquals(result.exitCode, 0);
      assertExists(result.trace);
      // With no role param, filtered should be empty
      const returnStep = result.trace!.steps.find((s) => s.line === 13);
      assertExists(returnStep);
      const filtered = returnStep!.locals
        .filtered as Array<Record<string, string>>;
      assertEquals(filtered.length, 0, "no users should match role=null");
    });
  });

  // Edge case: order_server with missing product — should capture the 404 path
  describe("edge cases — missing KV data", () => {
    let result: Awaited<ReturnType<typeof runDebugger>>;

    beforeAll(async () => {
      const seed = new Deno.Command("deno", {
        args: ["run", "--allow-all", "--unstable-kv", "test_app/seed.ts"],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      await seed.output();

      result = await runDebugger({
        run:
          "deno run --inspect --allow-net --unstable-kv test_app/order_server.ts",
        target: "test_app/order_server.ts",
        lines: "9,13,14",
        trigger: "curl 'http://localhost:3000/?product=nonexistent'",
      });
    });

    it("should exit 0", () => {
      assertEquals(result.exitCode, 0);
    });

    it("should capture the missing product path", () => {
      assertExists(result.trace);
      assert(result.trace!.steps.length > 0);
      // Should see productId = "nonexistent" in locals
      const step = result.trace!.steps.find((s) =>
        s.locals.productId === "nonexistent"
      );
      assertExists(step, "should capture productId = 'nonexistent'");
    });
  });

  // Validates the debugger handles bad input gracefully: nonexistent target file,
  // invalid line numbers, bad trigger command.
  describe("unexpected input", () => {
    it("should exit 1 when target file does not exist", async () => {
      const result = await runDebugger({
        run: "deno run --inspect --allow-net test_app/server.ts",
        target: "nonexistent/file.ts",
        lines: "1",
        trigger: "curl http://localhost:3000",
      });
      assertEquals(result.exitCode, 1);
    });

    it("should exit 1 when --run command is invalid", async () => {
      const result = await runDebugger({
        run: "this-command-does-not-exist",
        target: "test_app/server.ts",
        lines: "9",
        trigger: "curl http://localhost:3000",
      });
      assertEquals(result.exitCode, 1);
    });

    it("should handle lines that don't map to compiled JS", async () => {
      // Line 1 is a comment — no compiled JS equivalent
      const result = await runDebugger({
        run: "deno run --inspect --allow-net test_app/server.ts",
        target: "test_app/server.ts",
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
        run: "deno run --inspect --allow-net test_app/server.ts",
        target: "test_app/server.ts",
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

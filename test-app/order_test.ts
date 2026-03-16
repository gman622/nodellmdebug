import { describe, it, beforeAll, afterAll } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";

describe("order pricing with promo codes", () => {
  let serverProcess: Deno.ChildProcess;

  beforeAll(async () => {
    // Seed the database
    const seed = new Deno.Command("deno", {
      args: ["run", "--allow-all", "--unstable-kv", "test-app/seed.ts"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    await seed.status;

    // Start the server
    serverProcess = new Deno.Command("deno", {
      args: ["run", "--allow-net", "--unstable-kv", "test-app/order-server.ts"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Wait for server to start
    await new Promise((r) => setTimeout(r, 2000));
  });

  afterAll(() => {
    try {
      serverProcess.kill("SIGTERM");
    } catch { /* already dead */ }
  });

  describe("when no promo code is applied", () => {
    it("should return the base price", async () => {
      const res = await fetch("http://localhost:3000/?product=keyboard");
      const data = await res.json();
      assertEquals(data.total, 79.99);
    });
  });

  describe("when SUMMER promo is applied (amount stored as number)", () => {
    it("should calculate total = promo.amount + handlingFee + product.price", async () => {
      const res = await fetch("http://localhost:3000/?product=mouse&promo=SUMMER");
      const data = await res.json();
      // 10 + 5 + 49.99 = 64.99
      assertEquals(typeof data.total, "number");
      assertEquals(data.total, 64.99);
    });
  });

  describe("when WELCOME promo is applied (amount stored as string by legacy service)", () => {
    it("should calculate total = promo.amount + handlingFee + product.price", async () => {
      const res = await fetch("http://localhost:3000/?product=mouse&promo=WELCOME");
      const data = await res.json();
      // Expected: 15 + 5 + 49.99 = 69.99
      // Actual: "15" + 5 + 49.99 = "15549.99" (string concatenation)
      assertEquals(typeof data.total, "number");
      assertEquals(data.total, 69.99);
    });
  });
});

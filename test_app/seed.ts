// Seed script — simulates data written by different services
// The pricing service stores values correctly.
// The promotions service was ported from Python and writes strings.

const kv = await Deno.openKv();

await kv.set(["products", "keyboard"], { name: "Keyboard", price: 79.99 });
await kv.set(["products", "mouse"], { name: "Mouse", price: 49.99 });

// Promo amounts — the promotions service writes these
// Some are numbers (new service), some are strings (legacy Python service)
await kv.set(["promos", "summer"], { code: "SUMMER", amount: 10 });
await kv.set(["promos", "welcome"], { code: "WELCOME", amount: "15" });

console.log("Seeded KV");
kv.close();

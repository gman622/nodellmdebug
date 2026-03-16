/// <reference lib="deno.unstable" />
// Order server — applies promo code to product price
// Bug report: "WELCOME promo on mouse gives '15549.99' instead of 69.99"

const kv = await Deno.openKv();

Deno.serve({ port: 3000 }, async (req: Request) => {
  const url = new URL(req.url);
  const productId = url.searchParams.get("product");
  const promoCode = url.searchParams.get("promo");
  if (!productId) return new Response("missing product", { status: 400 });

  const productEntry = await kv.get(["products", productId]);
  if (!productEntry.value) return new Response("not found", { status: 404 });
  const product = productEntry.value as { name: string; price: number };

  let promoAmount = 0;
  if (promoCode) {
    const promoEntry = await kv.get(["promos", promoCode.toLowerCase()]);
    if (promoEntry.value) {
      const promo = promoEntry.value as { code: string; amount: number };
      promoAmount = promo.amount;
    }
  }

  const handlingFee = 5;
  const total = promoAmount + handlingFee + product.price;
  const response = {
    product: product.name,
    price: product.price,
    promoAmount,
    handlingFee,
    total,
  };
  return new Response(JSON.stringify(response));
});

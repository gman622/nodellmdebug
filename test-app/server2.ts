const products = [
  { id: 1, name: "Keyboard", price: 79.99, inStock: true },
  { id: 2, name: "Mouse", price: 49.99, inStock: true },
  { id: 3, name: "Monitor", price: 299.99, inStock: false },
];

Deno.serve({ port: 3000 }, (req: Request) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  // @ts-expect-error intentional bug: number === string
  const product = products.find((p) => p.id === id);

  if (!product) {
    return new Response(JSON.stringify({ error: "Product not found" }), {
      status: 404,
    });
  }

  return new Response(JSON.stringify(product));
});

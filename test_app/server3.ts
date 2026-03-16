/// <reference lib="deno.unstable" />
// A server that stores and retrieves items from Deno KV.
// Bug report: "PUT creates the item, GET returns 404 immediately after"

const kv = await Deno.openKv();

Deno.serve({ port: 3000 }, async (req: Request) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const collection = segments[0];
  const id = segments[1];

  if (req.method === "PUT" && collection && id) {
    const body = await req.json();
    await kv.set([collection, id], body);
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  }

  if (req.method === "GET" && collection && id) {
    const entry = await kv.get([collection, id]);
    if (!entry.value) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(entry.value));
  }

  return new Response("usage: PUT or GET /:collection/:id", { status: 400 });
});

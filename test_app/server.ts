const users = [
  { name: "Alice", role: "admin" },
  { name: "Bob", role: "user" },
  { name: "Charlie", role: "user" },
];

Deno.serve({ port: 3000 }, (req: Request) => {
  const url = new URL(req.url);
  const role = url.searchParams.get("role");
  // deno-lint-ignore no-unused-vars
  const filtered = users.filter((u) => u.role === role);
  // Bug: returns `users` instead of `filtered`
  return new Response(JSON.stringify(users));
});

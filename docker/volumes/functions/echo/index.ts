Deno.serve((req: Request) => {
  return new Response(req.body, {
    headers: { 'Content-Type': 'text/plain' },
  })
})

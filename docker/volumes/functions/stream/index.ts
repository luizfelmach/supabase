Deno.serve(() => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        controller.enqueue(encoder.encode(`chunk-${i}\n`))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
})

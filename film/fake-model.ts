// Stands in for Anthropic's Messages API during a take: streams REPLY, or LIGHT_REPLY when the
// system prompt carries the light guide, so the film shows omp drawing a fixed reply.
//   bun film/fake-model.ts [port]
import { LIGHT_REPLY, REPLY } from "./script.ts";

const port = Number(process.argv[2] ?? 4599);
const CHUNK = 6;

function events(text: string): string[] {
  const sse = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [
    sse("message_start", {
      message: { id: "msg_film", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1 } },
    }),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  ];
  for (let i = 0; i < text.length; i += CHUNK) {
    out.push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + CHUNK) } }));
  }
  out.push(
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.ceil(text.length / 4) } }),
    sse("message_stop", {}),
  );
  return out;
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/messages")) return new Response("{}", { headers: { "content-type": "application/json" } });
    const body = (await req.json()) as { system?: unknown; stream?: boolean };
    const isLight = JSON.stringify(body.system ?? "").includes("a sentence or two per paragraph");
    const chunks = events(isLight ? LIGHT_REPLY : REPLY);
    const stream = new ReadableStream({
      async start(controller) {
        for (const c of chunks) {
          controller.enqueue(new TextEncoder().encode(c));
          await Bun.sleep(25);
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`fake model on http://127.0.0.1:${port}`);

const MODEL = "models/gemini-flash-lite-latest";
const GEMINI_TIMEOUT_MS = 65_000; // чуть больше 60с, бот оборвёт сам
const MAX_OUTPUT_TOKENS = 900;

function extractTextFromGeminiResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map(p => (p?.text || "")).join("");
}

async function handleProxy(request, env) {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  const secret = request.headers.get("x-proxy-secret");
  if (!env.PROXY_SECRET || secret !== env.PROXY_SECRET) {
    // (можно временно оставить debug-поля, чтобы понять, видит ли Proxy env)
    return new Response(
      JSON.stringify({ status: 403, error: "forbidden", debug: { hasEnvSecret: !!env.PROXY_SECRET, hasHeader: !!secret } }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }

  let body = {};
  try { body = await request.json(); } catch {}

  const prompt = (body.prompt || "").toString().trim();
  const wantStream = !!body.stream;

  if (!prompt) {
    return new Response(JSON.stringify({ text: "" }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (!env.GEMINI_KEY) {
    return new Response(JSON.stringify({ status: 500, error: "no_gemini_key" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: MAX_OUTPUT_TOKENS },
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  const clientAbort = () => controller.abort();
  try { request.signal?.addEventListener?.("abort", clientAbort, { once: true }); } catch {}

  try {
    // ===== STREAM MODE =====
    if (wantStream) {
      const url = `https://generativelanguage.googleapis.com/v1beta/${MODEL}:streamGenerateContent?alt=sse&key=${env.GEMINI_KEY}`;

      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "text/event-stream" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return new Response(JSON.stringify({ status: r.status, error: data }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }

      if (!r.body) {
        const raw = await r.text();
        return new Response(raw || "", {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const stream = new ReadableStream({
        async start(streamController) {
          const reader = r.body.getReader();
          let buf = "";

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;

              buf += decoder.decode(value, { stream: true });

              // SSE события разделены пустой строкой
              let idx;
              while ((idx = buf.indexOf("\n\n")) !== -1) {
                const event = buf.slice(0, idx);
                buf = buf.slice(idx + 2);

                for (const line of event.split("\n")) {
                  const l = line.trim();
                  if (!l.startsWith("data:")) continue;

                  const dataStr = l.slice(5).trim();
                  if (!dataStr || dataStr === "[DONE]") continue;

                  let obj = null;
                  try { obj = JSON.parse(dataStr); } catch {}
                  if (!obj) continue;

                  const chunk = extractTextFromGeminiResponse(obj);
                  if (chunk) streamController.enqueue(encoder.encode(chunk));
                }
              }
            }

            streamController.close();
          } catch {
            try { streamController.close(); } catch {}
          }
        },
        cancel() {
          controller.abort();
        }
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // ===== NON-STREAM MODE =====
    const url = `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=${env.GEMINI_KEY}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return new Response(JSON.stringify({ status: r.status, error: data }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    const text = extractTextFromGeminiResponse(data).trim() || "";
    return new Response(JSON.stringify({ text }), {
      headers: { "content-type": "application/json" },
    });

  } catch {
    return new Response(JSON.stringify({ status: 504, error: "timeout_or_network" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  } finally {
    clearTimeout(t);
    try { request.signal?.removeEventListener?.("abort", clientAbort); } catch {}
  }
}

// Workers entry
export default {
  async fetch(request, env, ctx) {
    return handleProxy(request, env);
  },
};

// Pages entry
export async function onRequest(context) {
  return handleProxy(context.request, context.env);
}

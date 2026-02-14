export const config = {
  runtime: "edge",
  regions: ["fra1", "cdg1", "lhr1"],
};

const MODEL = "models/gemini-flash-lite-latest";

const GEMINI_TIMEOUT_JSON_MS = 9000;
const GEMINI_TIMEOUT_STREAM_MS = 70000;

const MAX_OUTPUT_TOKENS = 900;

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map(p => (p?.text || "")).join("");
}

export default async function handler(request) {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  const secret = (request.headers.get("x-proxy-secret") || "").trim();
  const expected = (process.env.PROXY_SECRET || "").trim();

  if (!expected || secret !== expected) {
    return new Response(JSON.stringify({ status: 403, error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
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

  const geminiKey = (process.env.GEMINI_KEY || "").trim();
  if (!geminiKey) {
    return new Response(JSON.stringify({ status: 500, error: "no_gemini_key" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: MAX_OUTPUT_TOKENS },
  };

  // ================= STREAM MODE =================
  if (wantStream) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        // Важно: отдаем первый байт сразу, чтобы Vercel не убил функцию за 25s "no initial response"
        controller.enqueue(encoder.encode("\n"));

        let sentAny = false;

        const upstreamController = new AbortController();
        const timer = setTimeout(() => upstreamController.abort(), GEMINI_TIMEOUT_STREAM_MS);

        const onClientAbort = () => upstreamController.abort();
        try { request.signal?.addEventListener?.("abort", onClientAbort, { once: true }); } catch {}

        try {
          const url =
            `https://generativelanguage.googleapis.com/v1beta/${MODEL}:streamGenerateContent?alt=sse&key=${geminiKey}`;

          const r = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "accept": "text/event-stream",
            },
            body: JSON.stringify(payload),
            signal: upstreamController.signal,
          });

          if (!r.ok || !r.body) {
            controller.enqueue(encoder.encode("__PROXY_ERROR__ upstream_not_ok"));
            controller.close();
            return;
          }

          const reader = r.body.getReader();
          const decoder = new TextDecoder();

          let tail = "";
          let eventLines = [];

          const flushEvent = () => {
            if (!eventLines.length) return;
            for (const line of eventLines) {
              const l = line.trim();
              if (!l.startsWith("data:")) continue;

              const dataStr = l.slice(5).trim();
              if (!dataStr) continue;
              if (dataStr === "[DONE]") continue;

              try {
                const obj = JSON.parse(dataStr);
                const chunk = extractText(obj);
                if (chunk) {
                  sentAny = true;
                  controller.enqueue(encoder.encode(chunk));
                }
              } catch {
                // ignore bad json lines
              }
            }
            eventLines = [];
          };

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const s = decoder.decode(value, { stream: true });
            const combined = tail + s;

            // line-by-line parser (works for \n and \r\n)
            const lines = combined.split("\n");
            tail = lines.pop() || "";

            for (let line of lines) {
              if (line.endsWith("\r")) line = line.slice(0, -1);

              if (line === "") {
                // пустая строка = конец SSE события
                flushEvent();
              } else {
                eventLines.push(line);
              }
            }
          }

          // добиваем последнее событие
          flushEvent();

          if (!sentAny) {
            controller.enqueue(encoder.encode("__EMPTY__"));
          }

          controller.close();
        } catch {
          controller.enqueue(encoder.encode("__PROXY_ERROR__ timeout_or_network"));
          controller.close();
        } finally {
          clearTimeout(timer);
          try { request.signal?.removeEventListener?.("abort", onClientAbort); } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // ================= NON-STREAM (быстрый JSON) =================
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_JSON_MS);

  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=${geminiKey}`;

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

    const text = extractText(data).trim() || "";
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
  }
}

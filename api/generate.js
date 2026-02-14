export const config = {
  runtime: "edge",
  regions: ["fra1", "cdg1", "lhr1"],
};

const MODEL = "models/gemini-flash-lite-latest";

// Обычный JSON режим
const GEMINI_TIMEOUT_JSON_MS = 9000;
const MAX_OUTPUT_TOKENS_JSON = 220;

// ВАЖНО: Vercel Edge у тебя таймится, поэтому здесь копим SSE-ответ ограниченно.
// Подбери 7000..9000, чтобы не ловить FUNCTION_INVOCATION_TIMEOUT.
const STREAM_COLLECT_MS = 8000;
const MAX_OUTPUT_TOKENS_STREAM = 900;

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map(p => (p?.text || "")).join("");
}

async function collectFromSSE(r, maxMs) {
  if (!r.body) return { text: "", done: false };

  const reader = r.body.getReader();
  const decoder = new TextDecoder();

  let text = "";
  let done = false;

  // line-based SSE parser (works for \n and \r\n)
  let tail = "";
  let eventLines = [];

  const flushEvent = () => {
    if (!eventLines.length) return;
    for (const line of eventLines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;

      const dataStr = l.slice(5).trim();
      if (!dataStr) continue;

      if (dataStr === "[DONE]") {
        done = true;
        continue;
      }

      try {
        const obj = JSON.parse(dataStr);
        const chunk = extractText(obj);
        if (chunk) text += chunk;
      } catch {
        // ignore
      }
    }
    eventLines = [];
  };

  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { value, done: rdDone } = await reader.read().catch(() => ({ value: null, done: true }));
    if (rdDone) break;
    if (!value) continue;

    const s = decoder.decode(value, { stream: true });
    const combined = tail + s;

    const lines = combined.split("\n");
    tail = lines.pop() || "";

    for (let line of lines) {
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        flushEvent(); // end of event
        if (done) break;
      } else {
        eventLines.push(line);
      }
    }

    if (done) break;
  }

  flushEvent();
  return { text: (text || "").trim(), done };
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

  // ===== режим "stream:true", но наружу отдаём JSON с частичным текстом =====
  if (wantStream) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/${MODEL}:streamGenerateContent?alt=sse&key=${geminiKey}`;

    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: MAX_OUTPUT_TOKENS_STREAM },
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), STREAM_COLLECT_MS + 1500);

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "text/event-stream" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return new Response(JSON.stringify({ status: r.status, error: errText || "upstream_not_ok" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }

      const { text, done } = await collectFromSSE(r, STREAM_COLLECT_MS);

      // partial=true если не успели дочитать до [DONE]
      return new Response(JSON.stringify({ text, partial: !done }), {
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ status: 504, error: "timeout_or_network" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    } finally {
      clearTimeout(t);
    }
  }

  // ===== обычный JSON режим (как у тебя работал) =====
  const url =
    `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=${geminiKey}`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: MAX_OUTPUT_TOKENS_JSON },
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_JSON_MS);

  try {
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
    return new Response(JSON.stringify({ text, partial: false }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ status: 504, error: "timeout_or_network" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  } finally {
    clearTimeout(t);
  }
}

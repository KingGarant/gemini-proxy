export const config = {
  runtime: "edge",
  regions: ["fra1", "cdg1", "lhr1"],
};

const MODEL = "models/gemini-flash-lite-latest";

// JSON режим
const GEMINI_TIMEOUT_JSON_MS = 9000;
const MAX_OUTPUT_TOKENS_JSON = 220;

// В режиме stream:true мы НЕ стримим наружу, а собираем SSE внутри функции ограниченное время
const STREAM_COLLECT_MS = 8000;         // можно 7000..9000
const MAX_OUTPUT_TOKENS_STREAM = 900;

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map(p => (p?.text || "")).join("");
}

async function collectFromSSE(r, maxMs) {
  if (!r.body) return { text: "", timedOut: false, ended: true, sawDone: false };

  const reader = r.body.getReader();
  const decoder = new TextDecoder();

  let text = "";
  let sawDone = false;
  let ended = false;
  let timedOut = false;

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
        sawDone = true;
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

  while (true) {
    if (Date.now() - start >= maxMs) {
      timedOut = true;
      break;
    }

    let value, rdDone;
    try {
      ({ value, done: rdDone } = await reader.read());
    } catch {
      // ошибка чтения = считаем, что поток оборвался
      ended = true;
      break;
    }

    if (rdDone) {
      ended = true;
      break;
    }

    if (!value) continue;

    const s = decoder.decode(value, { stream: true });
    const combined = tail + s;

    const lines = combined.split("\n");
    tail = lines.pop() || "";

    for (let line of lines) {
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        flushEvent();
        if (sawDone) break;
      } else {
        eventLines.push(line);
      }
    }

    if (sawDone) break;
  }

  flushEvent();

  // если мы вышли по тайм-ауту — отменим чтение, чтобы не держать ресурсы
  if (timedOut) {
    try { await reader.cancel(); } catch {}
  }

  return { text: (text || "").trim(), timedOut, ended, sawDone };
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
    return new Response(JSON.stringify({ text: "", partial: false }), {
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

  // ===== stream:true (внутри собираем SSE, наружу отдаем JSON) =====
  if (wantStream) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/${MODEL}:streamGenerateContent?alt=sse&key=${geminiKey}`;

    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: MAX_OUTPUT_TOKENS_STREAM },
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), STREAM_COLLECT_MS + 2000);

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

      const { text, timedOut, ended, sawDone } = await collectFromSSE(r, STREAM_COLLECT_MS);

      // Считаем "partial" только если мы реально уперлись во время.
      // Если поток сам закрылся (ended=true) раньше тайма — это полный ответ.
      const partial = !!text && timedOut && !sawDone && !ended;

      return new Response(JSON.stringify({ text, partial }), {
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

  // ===== stream:false (быстрый JSON как раньше) =====
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
  } catch {
    return new Response(JSON.stringify({ status: 504, error: "timeout_or_network" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  } finally {
    clearTimeout(t);
  }
}

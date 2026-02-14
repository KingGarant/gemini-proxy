export const config = {
  runtime: "edge",
  regions: ["fra1", "cdg1", "lhr1"],
};

// Модель Groq (можно поменять)
const GROQ_MODEL = "llama-3.1-8b-instant";

// Настройки генерации
const TIMEOUT_MS = 12000;
const MAX_TOKENS = 400;     // ограничивает длину ответа
const TEMPERATURE = 0.6;

export default async function handler(request) {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  // --- auth by secret header ---
  const secret = (request.headers.get("x-proxy-secret") || "").trim();
  const expected = (process.env.PROXY_SECRET || "").trim();

  if (!expected || secret !== expected) {
    return new Response(JSON.stringify({ status: 403, error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const groqKey = (process.env.GROQ_API_KEY || "").trim();
  if (!groqKey) {
    return new Response(JSON.stringify({ status: 500, error: "no_groq_api_key" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  // --- body ---
  let body = {};
  try { body = await request.json(); } catch {}

  const prompt = (body.prompt || "").toString().trim();
  if (!prompt) {
    return new Response(JSON.stringify({ text: "", partial: false }), {
      headers: { "content-type": "application/json" },
    });
  }

  const payload = {
    model: GROQ_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: false,
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${groqKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!r.ok) {
      // Cloudflare-бот ожидает JSON с полем status
      return new Response(JSON.stringify({ status: r.status, error: data }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    const text = (data?.choices?.[0]?.message?.content || "").toString().trim();
    return new Response(JSON.stringify({ text, partial: false }), {
      headers: { "content-type": "application/json" },
    });

  } catch (e) {
    const isAbort = e && (e.name === "AbortError" || String(e).includes("AbortError"));
    return new Response(JSON.stringify({ status: 504, error: isAbort ? "timeout" : "network_or_runtime" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  } finally {
    clearTimeout(t);
  }
}

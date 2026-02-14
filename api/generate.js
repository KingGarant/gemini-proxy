const MODEL = "models/gemini-flash-lite-latest";
const GEMINI_TIMEOUT_MS = 9000;
const MAX_OUTPUT_TOKENS = 220;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok", { status: 200 });

    const secret = request.headers.get("x-proxy-secret");
    if (!env.PROXY_SECRET || secret !== env.PROXY_SECRET) {
      return new Response(JSON.stringify({ status: 403, error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    let body = {};
    try { body = await request.json(); } catch {}

    const prompt = (body.prompt || "").toString().trim();
    if (!prompt) {
      return new Response(JSON.stringify({ text: "" }), {
        headers: { "content-type": "application/json" },
      });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=${env.GEMINI_KEY}`;
    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: MAX_OUTPUT_TOKENS },
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

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

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
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
};

export const config = {
  runtime: "edge",
  regions: ["fra1"], // ЕС (Франкфурт). Можно iad1 (США)
};

const MODEL = "models/gemini-flash-lite-latest";

export default async function handler(request) {
  if (request.method !== "POST") return new Response("ok");

  const secret = request.headers.get("x-proxy-secret");
  if (!process.env.PROXY_SECRET || secret !== process.env.PROXY_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let body = {};
  try { body = await request.json(); } catch {}

  const prompt = (body.prompt || "").toString().trim();
  if (!prompt) {
    return new Response(JSON.stringify({ text: "" }), {
      headers: { "content-type": "application/json" },
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=${process.env.GEMINI_KEY}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 350 },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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
}

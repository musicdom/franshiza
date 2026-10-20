const https = require("https");

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "VolnaMusicMiniApp/1.0", "Accept": "application/json" },
      timeout: 9000
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          reject(new Error("Music catalog HTTP " + res.statusCode));
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error("Invalid catalog response")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Music catalog timeout")));
    req.on("error", reject);
  });
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9а-яё]+/gi, " ").trim();
}

module.exports = async function handler(req, res) {
  const origin=String(req.headers.origin||"");
  if(["https://musicdom.github.io","https://franshiza.vercel.app"].includes(origin)||/^https:\/\/franshiza-[a-z0-9-]+\.vercel\.app$/.test(origin)) res.setHeader("Access-Control-Allow-Origin",origin);
  res.setHeader("Vary","Origin");
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const query = String(req.query && req.query.q || "").trim().slice(0, 180);
  if (!query) return res.status(400).json({ ok: false, error: "Укажи название песни или исполнителя" });

  try {
    const endpoint = "https://api.deezer.com/search?q=" + encodeURIComponent(query) + "&limit=12";
    const data = await getJson(endpoint);
    const results = Array.isArray(data.data) ? data.data : [];
    const queryNorm = normalize(query);
    const queryWords = queryNorm.split(" ").filter(word => word.length > 2);
    const scored = results.filter(item => item && item.preview && item.link).map(item => {
      const title = normalize(item.title);
      const artist = normalize(item.artist && item.artist.name);
      const combined = title + " " + artist;
      let score = queryWords.reduce((sum, word) => sum + (combined.includes(word) ? 1 : 0), 0);
      if (title && queryNorm.includes(title)) score += 2;
      return { item, score };
    }).sort((a, b) => b.score - a.score);

    if (!scored.length || scored[0].score < Math.min(2, queryWords.length)) {
      return res.status(404).json({ ok: false, error: "Для этой композиции не найдено доступное аудиопревью" });
    }

    const item = scored[0].item;
    return res.status(200).json({
      ok: true,
      previewUrl: item.preview,
      title: item.title,
      artist: item.artist && item.artist.name || "",
      duration: 30,
      source: "Deezer",
      sourceUrl: item.link
    });
  } catch (error) {
    console.error("Music preview search failed:", String(error && error.message || error).slice(0, 180));
    return res.status(502).json({ ok: false, error: "Каталог Deezer сейчас недоступен. Попробуй ещё раз чуть позже." });
  }
};

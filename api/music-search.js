const https = require("https");

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "VolnaMusicMiniApp/1.1", "Accept": "application/json" },
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

function commercialLicense(url) {
  const license = String(url || "").toLowerCase();
  if (license.includes("creativecommons.org/publicdomain") || license.includes("creativecommons.org/cc0")) return true;
  return /creativecommons\.org\/licenses\/(by|by-sa|by-nd)(\/|$)/.test(license) &&
    !license.includes("-nc");
}

function scoreText(queryWords, title, creator) {
  const normalizedTitle = normalize(title);
  const normalizedCreator = normalize(creator);
  const combined = normalizedTitle + " " + normalizedCreator;
  return queryWords.reduce((score, word) => score + (combined.includes(word) ? 1 : 0), 0) +
    (normalizedTitle && queryWords.every(word => normalizedTitle.includes(word)) ? 2 : 0);
}

async function findFullTrack(titleWanted, artistWanted) {
  const wantedTitle = normalize(titleWanted);
  const titleWords = wantedTitle.split(" ").filter(word => word.length > 1);
  const artistWords = normalize(artistWanted).split(" ").filter(word =>
    word.length > 2 && !["feat", "ft", "the", "and", "with"].includes(word)
  );
  if (!titleWords.length) return null;
  const safeTitle = String(titleWanted || "").replace(/["\\]/g, " ").trim();
  const searchQuery = 'mediatype:audio AND licenseurl:*creativecommons.org* AND title:"' + safeTitle + '"';
  const searchUrl = "https://archive.org/advancedsearch.php?q=" +
    encodeURIComponent(searchQuery) +
    "&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&rows=20&page=1&output=json";
  try {
    const search = await getJson(searchUrl);
    const docs = search && search.response && Array.isArray(search.response.docs) ? search.response.docs : [];
    const candidates = docs.filter(doc => {
      const actualTitle = normalize(doc.title);
      const actualArtist = normalize(doc.creator);
      const titleMatches = titleWords.every(word => actualTitle.includes(word));
      const artistMatches = !artistWords.length ||
        artistWords.filter(word => actualArtist.includes(word)).length >= Math.min(2, artistWords.length);
      return titleMatches && artistMatches;
    });

    for (const candidateDoc of candidates.slice(0, 6)) {
      const candidate = { doc: candidateDoc };
      const identifier = String(candidate.doc.identifier || "");
      if (!/^[a-zA-Z0-9._-]+$/.test(identifier)) continue;
      const metadata = await getJson("https://archive.org/metadata/" + encodeURIComponent(identifier));
      const meta = metadata && metadata.metadata || {};
      const licenseUrl = meta.licenseurl || candidate.doc.licenseurl || "";
      if (!commercialLicense(licenseUrl)) continue;
      const files = Array.isArray(metadata.files) ? metadata.files : [];
      const audioFile = files.find(file =>
        file && typeof file.name === "string" &&
        /\.(mp3|m4a|ogg|opus|flac|wav)$/i.test(file.name) &&
        !/(_sample|_preview|_low\.)/i.test(file.name) &&
        file.source !== "derivative" &&
        file.size && Number(file.size) > 150000
      );
      if (!audioFile) continue;
      const title = String(meta.title || candidate.doc.title || titleWanted).slice(0, 180);
      const artist = String(meta.creator || candidate.doc.creator || "").slice(0, 180);
      return {
        ok: true,
        previewUrl: "https://archive.org/download/" + encodeURIComponent(identifier) + "/" + encodeURIComponent(audioFile.name),
        title,
        artist,
        duration: Number(audioFile.length) || 0,
        source: "Internet Archive",
        sourceUrl: "https://archive.org/details/" + encodeURIComponent(identifier),
        fullTrack: true,
        licenseUrl
      };
    }
  } catch (error) {
    console.error("Open audio catalog failed:", String(error && error.message || error).slice(0, 180));
  }
  return null;
}

module.exports = async function handler(req, res) {
  const origin = String(req.headers.origin || "");
  if (["https://musicdom.github.io", "https://franshiza.vercel.app"].includes(origin) ||
      /^https:\/\/franshiza-[a-z0-9-]+\.vercel\.app$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const title = String(req.query && req.query.title || "").trim().slice(0, 120);
  const artist = String(req.query && req.query.artist || "").trim().slice(0, 120);
  const legacyQuery = String(req.query && req.query.q || "").trim().slice(0, 180);
  const requestedTitle = title || legacyQuery;
  if (!requestedTitle) return res.status(400).json({ ok: false, error: "Укажи название песни" });
  const fullTrack = await findFullTrack(requestedTitle, artist);
  if (fullTrack) return res.status(200).json(fullTrack);

  return res.status(404).json({
    ok: false,
    error: "Полная запись с разрешённой лицензией не найдена. Короткие 30-секундные превью отключены."
  });
};

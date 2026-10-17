const fs = require("fs");
const https = require("https");
const path = require("path");

function getCertificates() {
  const rootPath = path.join(process.cwd(), "certs", "russian_trusted_root_ca.pem");
  const gostPath = path.join(process.cwd(), "certs", "russian_trusted_root_ca_gost_2025.pem");
  if (!fs.existsSync(rootPath) || !fs.existsSync(gostPath)) {
    throw new Error("Ministry of Digital Development CA certificates are missing");
  }
  return [fs.readFileSync(rootPath), fs.readFileSync(gostPath)];
}

function requestMax({ token, method = "GET", apiPath, body = null }) {
  return new Promise((resolve, reject) => {
    const bodyText = body == null ? null : JSON.stringify(body);
    const options = {
      hostname: "platform-api2.max.ru",
      path: apiPath,
      method,
      headers: {
        Authorization: token,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(bodyText ? { "Content-Length": Buffer.byteLength(bodyText) } : {})
      },
      ca: getCertificates(),
      rejectUnauthorized: true,
      timeout: 15000
    };
    const request = https.request(options, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}
        resolve({ status: response.statusCode || 0, ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300, data, raw });
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("MAX API request timed out")));
    if (bodyText) request.write(bodyText);
    request.end();
  });
}

module.exports = { requestMax };

const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/music-library");

test("authenticated POST delete removes only the selected song", async () => {
  const oldEnv = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    MUSIC_ADMIN_PASSWORD: process.env.MUSIC_ADMIN_PASSWORD
  };
  const oldFetch = global.fetch;
  let storedTracks = [
    { id: "keep-me", title: "Keep" },
    { id: "remove-me", title: "Remove" }
  ];
  process.env.KV_REST_API_URL = "https://redis.example.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.MUSIC_ADMIN_PASSWORD = "test-password";
  global.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    if (command[0] === "GET") {
      return { ok: true, json: async () => ({ result: JSON.stringify(storedTracks) }) };
    }
    if (command[0] === "SET") {
      storedTracks = JSON.parse(command[2]);
      return { ok: true, json: async () => ({ result: "OK" }) };
    }
    throw new Error("Unexpected Redis command");
  };

  const headers = {};
  let statusCode = 200;
  let responseBody = "";
  const res = {
    setHeader(name, value) { headers[name] = value; },
    status(code) { statusCode = code; return this; },
    end(body = "") { responseBody = body; return this; }
  };

  try {
    await handler({
      method: "POST",
      headers: { origin: "https://franshiza.vercel.app" },
      body: { action: "delete", id: "remove-me", password: "test-password" },
      query: {}
    }, res);
    assert.equal(statusCode, 200);
    assert.deepEqual(JSON.parse(responseBody), { ok: true });
    assert.deepEqual(storedTracks.map(track => track.id), ["keep-me"]);
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

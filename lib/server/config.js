function getConfig() {
  const required = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "ADMIN_PASSWORD", "SESSION_SECRET"];
  const missing = required.filter((key) => !process.env[key] || !process.env[key].trim());
  if (missing.length) {
    const error = new Error("Backend is not configured");
    error.code = "BACKEND_NOT_CONFIGURED";
    error.missing = missing;
    throw error;
  }
  if (process.env.ADMIN_PASSWORD.length < 16) {
    const error = new Error("ADMIN_PASSWORD must contain at least 16 characters");
    error.code = "INVALID_BACKEND_CONFIG";
    throw error;
  }
  if (process.env.SESSION_SECRET.length < 32) {
    const error = new Error("SESSION_SECRET must contain at least 32 characters");
    error.code = "INVALID_BACKEND_CONFIG";
    throw error;
  }
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "");
  if (!/^https:\/\//i.test(redisUrl)) {
    const error = new Error("UPSTASH_REDIS_REST_URL must use HTTPS");
    error.code = "INVALID_BACKEND_CONFIG";
    throw error;
  }
  return {
    redisUrl,
    redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    adminPassword: process.env.ADMIN_PASSWORD,
    sessionSecret: process.env.SESSION_SECRET,
    maxBotToken: process.env.MAX_BOT_TOKEN || "",
    maxAdminChatId: process.env.MAX_ADMIN_CHAT_ID || "",
    privacyApproved: process.env.PRIVACY_POLICY_APPROVED === "true",
    dataControllerName: process.env.DATA_CONTROLLER_NAME || "",
    dataControllerContact: process.env.DATA_CONTROLLER_CONTACT || ""
  };
}
module.exports = { getConfig };

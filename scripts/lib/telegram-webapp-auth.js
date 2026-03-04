"use strict";

const crypto = require("crypto");

function timingSafeEqualHex(a, b) {
  try {
    const left = Buffer.from(String(a || ""), "hex");
    const right = Buffer.from(String(b || ""), "hex");
    if (left.length === 0 || right.length === 0) return false;
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  } catch (err) {
    return false;
  }
}

function parseInitData(initData) {
  const raw = String(initData || "").trim();
  if (!raw) {
    return {
      ok: false,
      reason: "missing_init_data",
    };
  }

  const params = new URLSearchParams(raw);
  const hash = params.get("hash") || "";
  if (!hash) {
    return {
      ok: false,
      reason: "missing_hash",
    };
  }

  const dataEntries = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    dataEntries.push([key, value]);
  }

  dataEntries.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = dataEntries.map(([key, value]) => `${key}=${value}`).join("\n");

  let userId = null;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      const user = JSON.parse(userRaw);
      if (user && Object.prototype.hasOwnProperty.call(user, "id")) {
        userId = String(user.id);
      }
    } catch (err) {
      return {
        ok: false,
        reason: "invalid_user_json",
      };
    }
  }

  const authDateRaw = params.get("auth_date") || "";
  const authDate = Number(authDateRaw);

  return {
    ok: true,
    hash,
    dataCheckString,
    userId,
    authDate,
    authDateRaw,
  };
}

function validateInitData(initData, botToken, options = {}) {
  const token = String(botToken || "").trim();
  if (!token) {
    return {
      ok: false,
      reason: "missing_bot_token",
    };
  }

  const parsed = parseInitData(initData);
  if (!parsed.ok) return parsed;

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const expectedHash = crypto.createHmac("sha256", secretKey).update(parsed.dataCheckString).digest("hex");
  if (!timingSafeEqualHex(expectedHash, parsed.hash)) {
    return {
      ok: false,
      reason: "hash_mismatch",
    };
  }

  const maxAgeSeconds = Number.isFinite(options.maxAgeSeconds)
    ? Math.max(0, Math.floor(options.maxAgeSeconds))
    : 24 * 60 * 60;

  if (!Number.isFinite(parsed.authDate) || parsed.authDate <= 0) {
    return {
      ok: false,
      reason: "missing_auth_date",
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSeconds - parsed.authDate;
  if (ageSeconds > maxAgeSeconds) {
    return {
      ok: false,
      reason: "auth_date_too_old",
      ageSeconds,
    };
  }

  if (ageSeconds < -120) {
    return {
      ok: false,
      reason: "auth_date_in_future",
      ageSeconds,
    };
  }

  return {
    ok: true,
    userId: parsed.userId,
    authDate: parsed.authDate,
    ageSeconds,
  };
}

module.exports = {
  parseInitData,
  validateInitData,
};

const { createHmac, timingSafeEqual } = require("node:crypto");

const webhookPath = "/api/telegram/webhook";

function createTelegramBot({ env = process.env, fetchImpl = fetch, logger = console } = {}) {
  const token = (env.TELEGRAM_BOT_TOKEN || "").trim();
  // A stable secret works across Railway restarts without another environment variable.
  const secret = token ? createHmac("sha256", token).update("deikin-telegram-webhook-v1").digest("hex") : "";
  const processedUpdates = new Map();
  let username;
  let retryTimer;
  let stopped = false;

  async function callTelegram(method, payload = {}) {
    let response;
    let data;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      data = await response.json();
    } catch {
      // Do not expose the request URL: it contains the bot token.
      throw new Error(`Telegram ${method} request could not be completed`);
    }
    if (!response.ok || !data.ok) {
      throw new Error(`Telegram ${method} failed (HTTP ${response.status})`);
    }
    return data.result;
  }

  async function getUsername() {
    if (!username) {
      const me = await callTelegram("getMe");
      username = me.username.toLowerCase();
    }
    return username;
  }

  async function replyToCommand(update) {
    const message = update.message;
    if (!message || message.from?.is_bot || typeof message.text !== "string") return;
    if (!Number.isSafeInteger(message.chat?.id)) return;
    if (!["private", "group", "supergroup"].includes(message.chat.type)) return;

    // Also accept "/start @bot", as it is easy to insert a space on a phone.
    const command = message.text.match(/^\s*\/(start|chatid)(?:\s*@([a-z0-9_]+))?(?:\s|$)/i);
    if (!command) return;
    if (command[2] && command[2].toLowerCase() !== await getUsername()) return;

    const label = message.chat.type === "private" ? "этого чата" : "этой группы";
    const payload = {
      chat_id: message.chat.id,
      text: [
        "Бот заявок DEIKIN работает.",
        `ID ${label}: ${message.chat.id}`,
        "",
        "Чтобы получать сюда заявки с сайта, добавь этот ID в TELEGRAM_CHAT_IDS в Railway и примени изменения.",
        "Чтобы сохранить отправку в личку, оставь свой текущий ID и добавь ID группы через запятую.",
      ].join("\n"),
    };
    if (Number.isSafeInteger(message.message_thread_id)) payload.message_thread_id = message.message_thread_id;
    await callTelegram("sendMessage", payload);
  }

  async function handleWebhook({ httpMethod, headers = {}, body = "" }) {
    if (httpMethod !== "POST") return { statusCode: 405, headers: { Allow: "POST" }, body: "Method Not Allowed" };
    if (!token) return { statusCode: 503, body: "Telegram integration is not configured" };
    const suppliedSecret = headers["x-telegram-bot-api-secret-token"];
    if (typeof suppliedSecret !== "string" || Buffer.byteLength(suppliedSecret) !== Buffer.byteLength(secret)
      || !timingSafeEqual(Buffer.from(suppliedSecret), Buffer.from(secret))) {
      return { statusCode: 403, body: "Forbidden" };
    }

    let update;
    try {
      update = JSON.parse(body);
    } catch {
      return { statusCode: 400, body: "Invalid JSON" };
    }
    if (!update || !Number.isSafeInteger(update.update_id)) return { statusCode: 400, body: "Invalid update" };

    // Telegram may deliver an update again. Share in-flight work and remember successful replies.
    let pending = processedUpdates.get(update.update_id);
    if (!pending) {
      pending = replyToCommand(update);
      processedUpdates.set(update.update_id, pending);
    }
    try {
      await pending;
      if (processedUpdates.size > 1000) processedUpdates.delete(processedUpdates.keys().next().value);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
    } catch (error) {
      processedUpdates.delete(update.update_id);
      logger.error(error.message);
      return { statusCode: 502, body: "Telegram reply failed" };
    }
  }

  async function start() {
    if (stopped || !token) return false;
    const domain = (env.RAILWAY_PUBLIC_DOMAIN || "").trim();
    const webhookUrl = (env.TELEGRAM_WEBHOOK_URL || "").trim() || (domain ? `https://${domain}${webhookPath}` : "");
    if (!webhookUrl) {
      logger.warn("Telegram commands disabled: enable a Railway public domain or set TELEGRAM_WEBHOOK_URL.");
      return false;
    }
    try {
      const url = new URL(webhookUrl);
      if (url.protocol !== "https:" || url.pathname !== webhookPath || url.username || url.password || url.search || url.hash) {
        throw new Error();
      }
    } catch {
      logger.error(`TELEGRAM_WEBHOOK_URL must be an HTTPS URL ending in ${webhookPath}.`);
      return false;
    }

    clearTimeout(retryTimer);
    try {
      await getUsername();
      await callTelegram("setWebhook", {
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ["message"],
        max_connections: 1,
      });
      logger.info("Telegram commands enabled: /start and /chatid.");
      return true;
    } catch (error) {
      logger.error(`${error.message}. Webhook setup will retry in 15 seconds.`);
      if (!stopped) {
        retryTimer = setTimeout(() => { void start(); }, 15000);
        retryTimer.unref();
      }
      return false;
    }
  }

  function stop() {
    stopped = true;
    clearTimeout(retryTimer);
  }

  return { handleWebhook, start, stop };
}

module.exports = { createTelegramBot, webhookPath };

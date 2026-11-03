const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { createTelegramBot, webhookPath } = require("../telegram-bot");
const { createServer } = require("../server");

const testToken = "local-test-token";
const groupId = -1001234567890;

async function fixture(t, { env = {}, reply } = {}) {
  const calls = [];
  const logs = [];
  const bot = createTelegramBot({
    env: { TELEGRAM_BOT_TOKEN: testToken, RAILWAY_PUBLIC_DOMAIN: "deikin-test.up.railway.app", ...env },
    logger: Object.fromEntries(["info", "warn", "error"].map(level => [level, message => logs.push(message)])),
    fetchImpl: async (url, options) => {
      const method = new URL(url).pathname.split("/").pop();
      const payload = JSON.parse(options.body);
      calls.push({ method, payload, url, options });
      if (reply) {
        const response = await reply(method, payload);
        if (response) return response;
      }
      const result = method === "getMe" ? { username: "deikin_applications_bot" } : true;
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    },
  });
  t.after(() => bot.stop());
  const started = await bot.start();
  const secret = calls.find(call => call.method === "setWebhook")?.payload.secret_token;
  function dispatch(update, overrides = {}) {
    return bot.handleWebhook({
      httpMethod: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(update),
      ...overrides,
    });
  }
  return { bot, calls, logs, started, secret, dispatch };
}

function command(text = "/chatid@deikin_applications_bot", updateId = 1, message = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 123456, is_bot: false },
      chat: { id: groupId, type: "supergroup", title: "Команда Deikin_edu" },
      text,
      ...message,
    },
  };
}

async function serve(t, bot) {
  const server = createServer({ telegramBot: bot });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("registers an authenticated webhook automatically using the Railway domain", async t => {
  const { calls, logs, started, secret } = await fixture(t);
  assert.equal(started, true);
  assert.deepEqual(calls.map(call => call.method), ["getMe", "setWebhook"]);
  const registration = calls[1].payload;
  assert.equal(registration.url, `https://deikin-test.up.railway.app${webhookPath}`);
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.deepEqual(registration.allowed_updates, ["message"]);
  assert.equal(registration.max_connections, 1);
  assert.equal(registration.drop_pending_updates, undefined);
  assert.ok(calls.every(call => call.options.method === "POST" && call.options.signal));
  assert.ok(logs.every(message => !message.includes(testToken)));
});

test("/start and /chatid reply with the group ID, including commands typed with a space", async t => {
  const { calls, dispatch } = await fixture(t);
  const commands = ["/start", "/chatid", "/start@deikin_applications_bot", "/start @deikin_applications_bot", "/chatid@DEIKIN_APPLICATIONS_BOT"];
  for (let index = 0; index < commands.length; index++) {
    assert.equal((await dispatch(command(commands[index], index))).statusCode, 200);
  }
  const sent = calls.filter(call => call.method === "sendMessage");
  assert.equal(sent.length, commands.length);
  for (const { payload } of sent) {
    assert.equal(payload.chat_id, groupId);
    assert.match(payload.text, new RegExp(`ID этой группы: ${groupId}`));
    assert.match(payload.text, /TELEGRAM_CHAT_IDS/);
    assert.equal(payload.parse_mode, undefined);
  }
});

test("responds in private chats and keeps a command reply in its forum topic", async t => {
  const { calls, dispatch } = await fixture(t);
  await dispatch(command("/start", 1, { chat: { id: 123456, type: "private" } }));
  await dispatch(command("/chatid", 2, { message_thread_id: 42 }));
  const sent = calls.filter(call => call.method === "sendMessage");
  assert.match(sent[0].payload.text, /ID этого чата: 123456/);
  assert.equal(sent[0].payload.chat_id, 123456);
  assert.equal(sent[1].payload.message_thread_id, 42);
});

test("ignores ordinary messages, commands for other bots, and other update types", async t => {
  const { calls, dispatch } = await fixture(t);
  const updates = [
    command("Обычное сообщение", 1),
    command("/start@another_bot", 2),
    command("/chatid @another_bot", 3),
    command("/starter", 4),
    command("/start", 5, { from: { is_bot: true } }),
    command("/start", 6, { chat: { id: groupId, type: "channel" } }),
    { update_id: 7, edited_message: command().message },
  ];
  for (const update of updates) assert.equal((await dispatch(update)).statusCode, 200);
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 0);
});

test("rejects unauthenticated requests, invalid JSON, and invalid update bodies", async t => {
  const { calls, dispatch } = await fixture(t);
  assert.equal((await dispatch(command(), { httpMethod: "GET" })).statusCode, 405);
  for (const headers of [{}, { "x-telegram-bot-api-secret-token": "x".repeat(64) }, { "x-telegram-bot-api-secret-token": "я".repeat(32) }]) {
    assert.equal((await dispatch(command(), { headers })).statusCode, 403);
  }
  for (const body of ["{", "null", "[]", "{}", '{"update_id":"1"}']) {
    assert.equal((await dispatch(command(), { body })).statusCode, 400);
  }
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 0);
});

test("does not send another reply when Telegram delivers the same update concurrently", async t => {
  const { calls, dispatch } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => dispatch(command())));
  assert.ok(results.every(result => result.statusCode === 200));
  await dispatch(command());
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 1);
});

test("allows Telegram to retry a command after a failed reply", async t => {
  let attempts = 0;
  const { calls, dispatch } = await fixture(t, {
    reply: method => {
      if (method === "sendMessage" && attempts++ === 0) {
        return { ok: false, status: 503, json: async () => ({ ok: false }) };
      }
    },
  });
  assert.equal((await dispatch(command())).statusCode, 502);
  assert.equal((await dispatch(command())).statusCode, 200);
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 2);
});

test("supports an explicit webhook URL and skips missing or invalid configuration", async t => {
  const explicit = await fixture(t, { env: { TELEGRAM_WEBHOOK_URL: `https://example.com${webhookPath}` } });
  assert.equal(explicit.calls.find(call => call.method === "setWebhook").payload.url, `https://example.com${webhookPath}`);
  const missingToken = await fixture(t, { env: { TELEGRAM_BOT_TOKEN: "" } });
  assert.equal(missingToken.started, false);
  assert.equal(missingToken.calls.length, 0);
  assert.equal((await missingToken.dispatch(command())).statusCode, 503);
  for (const env of [
    { RAILWAY_PUBLIC_DOMAIN: "" },
    { TELEGRAM_WEBHOOK_URL: `http://example.com${webhookPath}` },
    { TELEGRAM_WEBHOOK_URL: "https://example.com/wrong-path" },
    { TELEGRAM_WEBHOOK_URL: `https://example.com${webhookPath}?secret=oops` },
  ]) {
    const result = await fixture(t, { env });
    assert.equal(result.started, false);
    assert.equal(result.calls.length, 0);
  }
});

test("a startup network error is logged without exposing the bot token", async t => {
  const { started, calls, logs } = await fixture(t, {
    reply: () => { throw new Error(`Failure at https://api.telegram.org/bot${testToken}/getMe`); },
  });
  assert.equal(started, false);
  assert.equal(calls.length, 1);
  assert.ok(logs.some(message => message.includes("retry in 15 seconds")));
  assert.ok(logs.every(message => !message.includes(testToken)));
});

test("HTTP webhook replies work alongside the site, healthcheck, and existing form", async t => {
  const { bot, calls, secret } = await fixture(t);
  const base = await serve(t, bot);
  async function check(path, status, options) {
    const response = await fetch(base + path, options);
    assert.equal(response.status, status, path);
    return response.text();
  }
  assert.match(await check("/", 200), /DEIKIN/);
  assert.deepEqual(JSON.parse(await check("/health", 200)), { ok: true });
  for (const path of ["/telegram-bot.js", "/.env", "/test/telegram-bot.test.js"]) await check(path, 404);
  await check(webhookPath, 405);
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(command()),
  };
  await check(webhookPath, 403, { ...options, headers: {} });
  await check(webhookPath, 400, { ...options, body: "{" });
  await check(webhookPath, 413, { ...options, body: "x".repeat(33 * 1024) });
  assert.deepEqual(JSON.parse(await check(webhookPath, 200, options)), { ok: true });
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 1);
  await check("/.netlify/functions/lead", 400, { method: "POST", body: "{}" });
});

test("the existing lead form still delivers to both a private chat and a group", async t => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChats = process.env.TELEGRAM_CHAT_IDS;
  process.env.TELEGRAM_BOT_TOKEN = testToken;
  process.env.TELEGRAM_CHAT_IDS = `123456, ${groupId}`;
  t.after(() => {
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousChats === undefined) delete process.env.TELEGRAM_CHAT_IDS;
    else process.env.TELEGRAM_CHAT_IDS = previousChats;
  });
  const sent = [];
  t.mock.method(https, "request", (options, callback) => {
    assert.equal(options.hostname, "api.telegram.org");
    const request = new EventEmitter();
    request.write = body => sent.push(JSON.parse(body));
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => { response.emit("data", '{"ok":true}'); response.emit("end"); });
    };
    return request;
  });
  const { bot } = await fixture(t);
  const base = await serve(t, bot);
  const response = await fetch(`${base}/.netlify/functions/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Тест <DEIKIN>", country: "Кыргызстан", program: "Бакалавриат", level: "Школа", contact: "@test" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(sent.map(message => message.chat_id), ["123456", String(groupId)]);
  assert.match(sent[0].text, /Тест &lt;DEIKIN&gt;/);
});

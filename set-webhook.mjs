// Registers the Telegram webhook with the settings Stars payments need.
// Usage (Mac/Linux): BOT_TOKEN=... WORKER_URL=https://kcse-papers-bot.YOURNAME.workers.dev WEBHOOK_SECRET=... node set-webhook.mjs
// Windows PowerShell: $env:BOT_TOKEN="..."; $env:WORKER_URL="..."; $env:WEBHOOK_SECRET="..."; node set-webhook.mjs
const { BOT_TOKEN, WORKER_URL, WEBHOOK_SECRET } = process.env;
if (!BOT_TOKEN || !WORKER_URL || !WEBHOOK_SECRET) {
  console.error("Set BOT_TOKEN, WORKER_URL and WEBHOOK_SECRET first.");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
  console.error("WEBHOOK_SECRET may only contain letters, numbers, _ and - (max 256 chars).");
  process.exit(1);
}
const api = method => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
const call = async (method, body) => (await fetch(api(method), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body || {}),
})).json();

const set = await call("setWebhook", {
  url: `${WORKER_URL.replace(/\/+$/, "")}/telegram`,
  secret_token: WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query", "pre_checkout_query"], // pre_checkout_query is required for payments
  drop_pending_updates: true,
});
console.log("setWebhook:", set);
const info = await call("getWebhookInfo");
console.log("getWebhookInfo:", info.result);
if (!set.ok) process.exit(1);

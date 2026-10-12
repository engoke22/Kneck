# KCSE Papers Bot — Deployment Guide

Telegram bot on Cloudflare Workers + KV. Students pay with Telegram Stars (one payment per resource).

## Files
| File | Purpose |
|---|---|
| `kcse-papers-worker.js` | The bot |
| `wrangler.toml` | Worker, KV and variable configuration |
| `package.json` | Installs Wrangler (Cloudflare CLI) and shortcut commands |
| `set-webhook.mjs` | Registers the webhook correctly for Stars payments |
| `.dev.vars.example` | Template for local testing |
| `.gitignore` | Keeps secrets out of Git |

## 1. Prepare Telegram
1. In **@BotFather**: `/newbot`, copy the **bot token**. Stars payments need no payment provider setup.
2. Get your numeric Telegram ID from **@userinfobot**. This becomes `ADMIN_ID`.

## 2. Deploy with the CLI (needs Node.js 18+)
```bash
npm install
npx wrangler login
npx wrangler kv namespace create BOT_KV      # copy the printed id into wrangler.toml
```
Edit `wrangler.toml`: set the KV `id`, `ADMIN_ID`, `STARS_PRICE`, `SUPPORT_CONTACT`.

Set the two secrets (paste values when prompted):
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET       # e.g. output of: openssl rand -hex 24
```
Deploy and note the URL it prints (`https://kcse-papers-bot.<you>.workers.dev`):
```bash
npx wrangler deploy
```

## 3. Register the webhook
```bash
BOT_TOKEN=xxx WORKER_URL=https://kcse-papers-bot.<you>.workers.dev WEBHOOK_SECRET=yyy node set-webhook.mjs
```
`ok: true` and an empty `last_error_message` in the output means it works.
**Phone/no-computer alternative:** open this in a browser (fill in the three values):
```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>/telegram&secret_token=<WEBHOOK_SECRET>&allowed_updates=["message","callback_query","pre_checkout_query"]
```

## Dashboard-only deployment (no CLI)
1. Cloudflare dashboard → **Workers & Pages → Create → Worker**, paste `kcse-papers-worker.js`, deploy.
2. **Storage & Databases → KV → Create namespace** `BOT_KV`.
3. Worker → **Settings → Bindings → Add → KV namespace**: variable name **`BOT_KV`**.
4. Worker → **Settings → Variables and Secrets**: add secrets `BOT_TOKEN`, `WEBHOOK_SECRET`; variables `ADMIN_ID`, `STARS_PRICE`, `KSH_EQUIVALENT`, `SUPPORT_CONTACT`.
5. Register the webhook (step 3).

> If you deploy with `wrangler deploy`, values in `[vars]` overwrite variables set in the dashboard. Keep them in one place.

## 4. Test before announcing
1. Send `/start` to the bot, then `/admin` → upload a small PDF.
2. Temporarily set `STARS_PRICE = "1"`, redeploy, and buy it from a second Telegram account.
3. Confirm the file arrives, shows under **My Purchases**, and you got a "New sale" message.
4. Test `/refund <userId> <chargeId>` using the IDs from that message.
5. Set the real `STARS_PRICE` and redeploy.

## Troubleshooting
- **Bot silent:** `npx wrangler tail`, then send a message. A 403 means the webhook secret does not match; run step 3 again with the same secret.
- **Payment fails or hangs:** the webhook is missing `pre_checkout_query`. Re-run `set-webhook.mjs` and check `getWebhookInfo`.
- **"Missing ... configuration" (500):** one of `BOT_TOKEN`, `ADMIN_ID`, `WEBHOOK_SECRET`, `BOT_KV` is not set.
- **Changing the bot token or creating a new bot** invalidates stored file IDs. Keep your original files and re-upload.
- **Rotating the webhook secret:** change the secret, then re-run step 3.

## Notes
- Stars earnings are withdrawn through Telegram's own tools. Check Telegram's current minimums and holding period before promising payouts.
- Keep the original PDFs elsewhere; the export only backs up the catalogue, not the files.

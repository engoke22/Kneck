/**
 * KCSE Papers Telegram Bot — Cloudflare Worker (paid with Telegram Stars)
 *
 * Cloudflare configuration:
 *   Secret:   BOT_TOKEN
 *   Secret:   WEBHOOK_SECRET        (required)
 *   Variable: ADMIN_ID              (numeric Telegram user ID)
 *   Variable: STARS_PRICE           (Stars per resource, default 50 — tune to ≈ KSh 100)
 *   Variable: KSH_EQUIVALENT        (display only, default 100)
 *   Variable: SUPPORT_CONTACT       (optional, e.g. @yourusername)
 *   KV namespace binding: BOT_KV
 *
 * Register the webhook (pre_checkout_query is REQUIRED for Stars payments):
 *   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
 *     -d url=https://YOUR-WORKER.workers.dev/telegram \
 *     -d secret_token=<WEBHOOK_SECRET> \
 *     -d 'allowed_updates=["message","callback_query","pre_checkout_query"]'
 *
 * Students pay once per resource and can re-download it any time from "My Purchases".
 * The admin never pays. Refunds: /refund <userId> <chargeId> (admin only).
 */

const DB_KEY = "kcse:database:v1";
const SESSION_PREFIX = "kcse:session:";
const BUY_PREFIX = "kcse:buy:";
const MAX_IMAGES = 20;
const PAGE_SIZE = 8;
const DEFAULT_STARS = 50;
const RESOURCE_TYPES = [
  ["exam", "KCSE Paper"],
  ["marking_scheme", "Marking Scheme"],
  ["revision_notes", "Revision Notes"],
];
// Old catalogues stored type "past_paper"; it is migrated to "exam" on first read.
const LEGACY_TYPES = { past_paper: "exam" };

// Starter examples only. The administrator can add, rename and delete subjects and papers.
const DEFAULT_SUBJECTS = [
  ["English", ["Paper 1", "Paper 2", "Paper 3"]],
  ["Kiswahili", ["Paper 1", "Paper 2", "Paper 3"]],
  ["Mathematics", ["Paper 1", "Paper 2"]],
  ["Biology", ["Paper 1", "Paper 2", "Paper 3"]],
  ["Chemistry", ["Paper 1", "Paper 2", "Paper 3"]],
  ["Physics", ["Paper 1", "Paper 2", "Paper 3"]],
  ["History & Government", ["Paper 1", "Paper 2"]],
  ["Geography", ["Paper 1", "Paper 2"]],
  ["Christian Religious Education", ["Paper 1", "Paper 2"]],
  ["Islamic Religious Education", ["Paper 1", "Paper 2"]],
  ["Agriculture", ["Paper 1", "Paper 2"]],
  ["Business Studies", ["Paper 1", "Paper 2"]],
  ["Computer Studies", ["Paper 1", "Paper 2", "Paper 3"]],
];

const makeId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const esc = value => String(value ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const button = (text, callback_data) => ({ text, callback_data });
const markup = rows => ({ inline_keyboard: rows });
const mainRow = () => [button("Main Menu", "stu:home")];
const backRow = callback => [button("Back", callback), button("Main Menu", "stu:home")];
const typeLabel = type => RESOURCE_TYPES.find(item => item[0] === type)?.[1] || "Resource";
const isAdmin = (env, userId) => String(userId) === String(env.ADMIN_ID || "");
const stars = env => Math.max(1, parseInt(env.STARS_PRICE, 10) || DEFAULT_STARS);
const priceText = env => `⭐ ${stars(env)} Stars (≈ KSh ${esc(env.KSH_EQUIVALENT || 100)})`;
const sortResources = list => [...list].sort((a, b) =>
  String(b.year || "").localeCompare(String(a.year || "")) || String(a.title).localeCompare(String(b.title)));

/* ───────────── Telegram helpers ───────────── */

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    console.error(`Telegram ${method} failed:`, result.description || response.status);
    throw new Error(result.description || `Telegram API request failed: ${method}`);
  }
  return result.result;
}

async function send(env, chatId, text, reply_markup, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML",
    ...(reply_markup ? { reply_markup } : {}), ...extra,
  });
}

async function edit(env, chatId, messageId, text, reply_markup) {
  try {
    return await telegram(env, "editMessageText", {
      chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
      ...(reply_markup ? { reply_markup } : {}),
    });
  } catch (error) {
    if (!String(error.message).includes("message is not modified")) throw error;
  }
}

async function answerCallback(env, callbackId) {
  try { await telegram(env, "answerCallbackQuery", { callback_query_id: callbackId }); }
  catch (error) { console.error("Callback acknowledgement failed:", error.message); }
}

/* ───────────── Storage ───────────── */

async function getDb(env) {
  let db = await env.BOT_KV.get(DB_KEY, "json");
  if (!db) {
    db = {
      version: 1,
      subjects: DEFAULT_SUBJECTS.map(([name, papers]) => ({
        id: makeId(), name,
        papers: papers.map(paperName => ({ id: makeId(), name: paperName })),
      })),
      resources: [],
    };
    await saveDb(env, db);
    return db;
  }
  // Never overwrite a damaged catalogue with defaults.
  if (!Array.isArray(db.subjects) || !Array.isArray(db.resources)) throw new Error("Catalogue is malformed; refusing to overwrite it.");
  let changed = false;
  for (const r of db.resources) if (LEGACY_TYPES[r.type]) { r.type = LEGACY_TYPES[r.type]; changed = true; }
  if (changed) await saveDb(env, db);
  return db;
}
async function saveDb(env, db) { await env.BOT_KV.put(DB_KEY, JSON.stringify(db)); }
async function getSession(env, userId) { return (await env.BOT_KV.get(SESSION_PREFIX + userId, "json")) || {}; }
async function setSession(env, userId, session) {
  await env.BOT_KV.put(SESSION_PREFIX + userId, JSON.stringify(session), { expirationTtl: 21600 });
}
async function clearSession(env, userId) { await env.BOT_KV.delete(SESSION_PREFIX + userId); }

// One KV key per buyer, so purchases never overwrite each other.
async function getBuys(env, userId) { return (await env.BOT_KV.get(BUY_PREFIX + userId, "json")) || { items: {} }; }
async function saveBuys(env, userId, buys) { await env.BOT_KV.put(BUY_PREFIX + userId, JSON.stringify(buys)); }
async function hasAccess(env, userId, resourceId) {
  return isAdmin(env, userId) || !!(await getBuys(env, userId)).items[resourceId];
}
async function ownedChecker(env, userId) {
  if (isAdmin(env, userId)) return () => true;
  const buys = await getBuys(env, userId);
  return id => !!buys.items[id];
}
const resLabel = (owned, r) => `${owned(r.id) ? "✅" : "⭐"} ${r.title}`;

function findSubject(db, subjectId) { return db.subjects.find(s => s.id === subjectId); }
function findPaper(subject, paperId) { return subject?.papers?.find(p => p.id === paperId); }
function listResources(db, subjectId, paperId, type = null) {
  return db.resources.filter(r => r.subjectId === subjectId && r.paperId === paperId && (!type || r.type === type));
}
function defaultTitle(db, s, p, type, year) {
  const base = [s.name, p.name, year, typeLabel(type)].filter(Boolean).join(" — ");
  return year ? base : `${base} ${listResources(db, s.id, p.id, type).length + 1}`;
}
function studentSubjects(db) {
  return db.subjects.filter(s => s.papers.some(p => db.resources.some(r => r.subjectId === s.id && r.paperId === p.id)));
}

// Builds one page of buttons plus Prev/Next navigation.
function paged(items, page, toButton, navCb) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const rows = items.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE).map(i => [toButton(i)]);
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push(button("◀ Prev", navCb(p - 1)));
    nav.push(button(`${p + 1}/${pages}`, "noop"));
    if (p < pages - 1) nav.push(button("Next ▶", navCb(p + 1)));
    rows.push(nav);
  }
  return rows;
}

/* ───────────── Student menus ───────────── */

async function home(env, chatId, messageId = null) {
  const text = `<b>KCSE PAPERS</b>\nYour KCSE exam revision library.\n\nEach resource costs ${priceText(env)}. Paid items stay in <b>My Purchases</b> so you can download them again any time.`;
  const kb = markup([
    [button("Browse Subjects", "stu:subjects")],
    [button("Search Resources", "stu:search")],
    [button("My Purchases", "stu:mine:0")],
    [button("Help", "stu:help")],
  ]);
  return messageId ? edit(env, chatId, messageId, text, kb) : send(env, chatId, text, kb);
}
async function subjectsMenu(env, chatId, messageId = null) {
  const db = await getDb(env), subjects = studentSubjects(db);
  const rows = subjects.map(s => [button(s.name, `stu:sub:${s.id}`)]);
  rows.push(mainRow());
  const text = subjects.length ? "<b>Choose a subject</b>\nSubjects without published resources are hidden." : "No resources are available yet. Please check again later.";
  return messageId ? edit(env, chatId, messageId, text, markup(rows)) : send(env, chatId, text, markup(rows));
}
async function papersMenu(env, chatId, messageId, subjectId) {
  const db = await getDb(env), s = findSubject(db, subjectId);
  if (!s) return subjectsMenu(env, chatId, messageId);
  const papers = s.papers.filter(p => db.resources.some(r => r.subjectId === s.id && r.paperId === p.id));
  const rows = papers.map(p => [button(p.name, `stu:paper:${s.id}:${p.id}`)]);
  rows.push(backRow("stu:subjects"));
  return edit(env, chatId, messageId, `<b>${esc(s.name)}</b>\nChoose a paper.`, markup(rows));
}
async function typesMenu(env, chatId, messageId, subjectId, paperId) {
  const db = await getDb(env), s = findSubject(db, subjectId), p = findPaper(s, paperId);
  if (!s || !p) return subjectsMenu(env, chatId, messageId);
  const rows = RESOURCE_TYPES.filter(([t]) => listResources(db, subjectId, paperId, t).length)
    .map(([t, label]) => [button(`${label} (${listResources(db, subjectId, paperId, t).length})`, `stu:type:${subjectId}:${paperId}:${t}:0`)]);
  rows.push(backRow(`stu:sub:${subjectId}`));
  return edit(env, chatId, messageId, `<b>${esc(s.name)} — ${esc(p.name)}</b>\nChoose a resource type.`, markup(rows));
}
async function resourcesMenu(env, chatId, messageId, userId, subjectId, paperId, type, page = 0) {
  const db = await getDb(env), owned = await ownedChecker(env, userId);
  const list = sortResources(listResources(db, subjectId, paperId, type));
  const rows = paged(list, page, r => button(resLabel(owned, r), `stu:res:${r.id}`), n => `stu:type:${subjectId}:${paperId}:${type}:${n}`);
  rows.push(backRow(`stu:paper:${subjectId}:${paperId}`));
  return edit(env, chatId, messageId, `<b>${esc(typeLabel(type))}</b>\n⭐ = ${esc(stars(env))} Stars to unlock · ✅ = yours`, markup(rows));
}
async function purchasesMenu(env, chatId, messageId, userId, page = 0) {
  const db = await getDb(env), buys = await getBuys(env, userId);
  const list = sortResources(db.resources.filter(r => buys.items[r.id]));
  const rows = paged(list, page, r => button(`✅ ${r.title}`, `stu:res:${r.id}`), n => `stu:mine:${n}`);
  rows.push(mainRow());
  const text = list.length ? "<b>My Purchases</b>\nTap a resource to receive it again." : "You have not purchased anything yet.";
  return messageId ? edit(env, chatId, messageId, text, markup(rows)) : send(env, chatId, text, markup(rows));
}

/* ───────────── Purchase and delivery ───────────── */

async function openResource(env, chatId, userId, resourceId) {
  const db = await getDb(env), r = db.resources.find(x => x.id === resourceId);
  if (!r) return send(env, chatId, "This resource is no longer available.", markup([[button("Browse Subjects", "stu:subjects")], mainRow()]));
  if (await hasAccess(env, userId, r.id)) return deliverResource(env, chatId, r.id, !isAdmin(env, userId));
  const s = findSubject(db, r.subjectId), p = findPaper(s, r.paperId);
  return send(env, chatId,
    `<b>${esc(r.title)}</b>\n${esc(s?.name || "")} • ${esc(p?.name || "")} • ${esc(typeLabel(r.type))}${r.year ? ` • ${esc(r.year)}` : ""}\nFiles: ${r.files.length}\n\nPrice: ${priceText(env)}\nPay once, download any time.`,
    markup([[button(`Pay ⭐ ${stars(env)}`, `stu:buy:${r.id}`)], mainRow()]));
}

async function sendInvoice(env, chatId, userId, resourceId) {
  const db = await getDb(env), r = db.resources.find(x => x.id === resourceId);
  if (!r) return send(env, chatId, "This resource is no longer available.", markup([mainRow()]));
  if (await hasAccess(env, userId, r.id)) return deliverResource(env, chatId, r.id, !isAdmin(env, userId));
  return telegram(env, "sendInvoice", {
    chat_id: chatId,
    title: r.title.slice(0, 32),
    description: `${r.title} — delivered in this chat right after payment.`.slice(0, 255),
    payload: `buy:${r.id}`,
    currency: "XTR", // Telegram Stars: no provider_token needed
    prices: [{ label: "KCSE resource", amount: stars(env) }],
  });
}

// Telegram requires an answer within 10 seconds or the payment fails.
async function handlePreCheckout(env, q) {
  let ok = false, error = "Payment could not be verified. Please try again.";
  try {
    const rid = String(q.invoice_payload || "").replace(/^buy:/, "");
    const db = await getDb(env), r = db.resources.find(x => x.id === rid);
    if (!r) error = "This resource is no longer available.";
    else if (q.currency !== "XTR" || q.total_amount !== stars(env)) error = "The price has changed. Please open the resource again.";
    else if (await hasAccess(env, q.from.id, rid)) error = "You already own this resource.";
    else ok = true;
  } catch (e) { console.error("Pre-checkout failed:", e?.message); }
  await telegram(env, "answerPreCheckoutQuery", { pre_checkout_query_id: q.id, ok, ...(ok ? {} : { error_message: error }) });
}

async function handlePayment(env, m) {
  const pay = m.successful_payment, userId = m.from.id;
  const rid = String(pay.invoice_payload || "").replace(/^buy:/, "");
  try {
    const buys = await getBuys(env, userId);
    if (!buys.items[rid]) {
      buys.items[rid] = { chargeId: pay.telegram_payment_charge_id, stars: pay.total_amount, at: new Date().toISOString() };
      await saveBuys(env, userId, buys);
    }
  } catch (e) { console.error("Could not record purchase:", e?.message); }
  // Tell the admin every sale (also a backup of the charge ID needed for refunds).
  try {
    await send(env, env.ADMIN_ID, `<b>New sale</b>\nUser: <code>${userId}</code>\nResource: <code>${esc(rid)}</code>\nStars: ${esc(pay.total_amount)}\nCharge: <code>${esc(pay.telegram_payment_charge_id)}</code>`);
  } catch (e) { console.error("Admin notice failed:", e?.message); }
  await send(env, m.chat.id, "Payment received. Thank you! Sending your resource now.");
  return deliverResource(env, m.chat.id, rid, true);
}

async function deliverResource(env, chatId, resourceId, protect = true) {
  const db = await getDb(env), r = db.resources.find(x => x.id === resourceId);
  if (!r) return send(env, chatId, "This resource is no longer available.", markup([[button("Browse Subjects", "stu:subjects")], mainRow()]));
  const s = findSubject(db, r.subjectId), p = findPaper(s, r.paperId);
  await send(env, chatId, `<b>${esc(r.title)}</b>\n${esc(s?.name || "")} • ${esc(p?.name || "")} • ${esc(typeLabel(r.type))}`);
  const flags = protect ? { protect_content: true } : {}; // blocks forwarding/saving inside Telegram
  try {
    const docs = r.files.filter(f => f.kind === "document"), photos = r.files.filter(f => f.kind === "photo");
    for (const f of docs) await telegram(env, "sendDocument", { chat_id: chatId, document: f.fileId, ...flags });
    for (let i = 0; i < photos.length; i += 10) {
      const batch = photos.slice(i, i + 10);
      if (batch.length === 1) await telegram(env, "sendPhoto", { chat_id: chatId, photo: batch[0].fileId, ...flags });
      else await telegram(env, "sendMediaGroup", { chat_id: chatId, media: batch.map(f => ({ type: "photo", media: f.fileId })), ...flags });
    }
  } catch (error) {
    console.error("Delivery failed:", error.message);
    await send(env, chatId, "Sorry, Telegram could not deliver this resource. Open <b>My Purchases</b> to try again — you will not be charged twice.", markup([[button("My Purchases", "stu:mine:0")]]));
  }
}

/* ───────────── Admin menus ───────────── */

async function adminHome(env, chatId, messageId = null) {
  const text = "<b>ADMINISTRATION</b>\nKCSE Papers Library\n\nChoose a task.";
  const kb = markup([
    [button("Upload Resources", "adm:upload")],
    [button("Manage Library", "adm:resources")],
    [button("Manage Subjects & Papers", "adm:subjects")],
    [button("Export Catalogue", "adm:export")],
    [button("Main Menu", "stu:home")],
  ]);
  return messageId ? edit(env, chatId, messageId, text, kb) : send(env, chatId, text, kb);
}
async function adminSubjects(env, chatId, messageId) {
  const db = await getDb(env), rows = db.subjects.map(s => [button(s.name, `adm:subject:${s.id}`)]);
  rows.push([button("Add Subject", "adm:addsubject")], [button("Admin Home", "adm:home")]);
  return edit(env, chatId, messageId, "<b>Manage Subjects</b>\nChoose a subject to edit.", markup(rows));
}
async function adminSubject(env, chatId, messageId, subjectId) {
  const db = await getDb(env), s = findSubject(db, subjectId);
  if (!s) return adminSubjects(env, chatId, messageId);
  return edit(env, chatId, messageId, `<b>${esc(s.name)}</b>`, markup([
    [button("Rename Subject", `adm:renamesub:${s.id}`)],
    [button("Manage Papers", `adm:papers:${s.id}`)],
    [button("Delete Subject", `adm:delsub:${s.id}`)],
    [button("Back", "adm:subjects")],
  ]));
}
async function adminPapers(env, chatId, messageId, subjectId) {
  const db = await getDb(env), s = findSubject(db, subjectId);
  if (!s) return adminSubjects(env, chatId, messageId);
  const rows = s.papers.map(p => [button(p.name, `adm:paper:${s.id}:${p.id}`)]);
  rows.push([button("Add Paper", `adm:addpaper:${s.id}`)], [button("Back", `adm:subject:${s.id}`)]);
  return edit(env, chatId, messageId, `<b>${esc(s.name)} — Papers</b>`, markup(rows));
}
async function adminPaper(env, chatId, messageId, subjectId, paperId) {
  const db = await getDb(env), s = findSubject(db, subjectId), p = findPaper(s, paperId);
  if (!s || !p) return adminPapers(env, chatId, messageId, subjectId);
  return edit(env, chatId, messageId, `<b>${esc(s.name)} — ${esc(p.name)}</b>`, markup([
    [button("Rename Paper", `adm:renamepaper:${s.id}:${p.id}`)],
    [button("Delete Paper", `adm:delpaper:${s.id}:${p.id}`)],
    [button("Back", `adm:papers:${s.id}`)],
  ]));
}
async function adminResources(env, chatId, messageId, page = 0) {
  const db = await getDb(env);
  const list = [...db.resources].reverse(); // newest first
  const rows = paged(list, page, r => button(r.title, `adm:resource:${r.id}`), n => `adm:resources:${n}`);
  rows.push([button("Admin Home", "adm:home")]);
  return edit(env, chatId, messageId, list.length ? `<b>Manage Library</b>\n${list.length} resource(s), newest first:` : "No resources published yet.", markup(rows));
}
async function adminResource(env, chatId, messageId, resourceId) {
  const db = await getDb(env), r = db.resources.find(x => x.id === resourceId);
  if (!r) return edit(env, chatId, messageId, "Resource not found.", markup([[button("Back", "adm:resources")]]));
  const s = findSubject(db, r.subjectId), p = findPaper(s, r.paperId);
  return edit(env, chatId, messageId, `<b>${esc(r.title)}</b>\n${esc(s?.name || "")} — ${esc(p?.name || "")}\n${esc(typeLabel(r.type))}${r.year ? ` • ${esc(r.year)}` : ""}\nFiles: ${r.files.length}`, markup([
    [button("Rename", `adm:renameres:${r.id}`)], [button("Replace Files", `adm:replace:${r.id}`)],
    [button("Delete", `adm:delres:${r.id}`)], [button("Back", "adm:resources")],
  ]));
}

/* ───────────── Upload flow: subject → paper → type → year → files → confirm ───────────── */

async function startUpload(env, chatId, userId) {
  const db = await getDb(env), rows = db.subjects.map(s => [button(s.name, `up:sub:${s.id}`)]);
  rows.push([button("Cancel", "up:cancel")]);
  await setSession(env, userId, { mode: "upload_subject" });
  return send(env, chatId, "<b>Upload Resource</b>\nChoose a subject.", markup(rows));
}
async function uploadPaper(env, chatId, userId, subjectId) {
  const db = await getDb(env), s = findSubject(db, subjectId);
  if (!s) return send(env, chatId, "Subject not found.");
  await setSession(env, userId, { mode: "upload_paper", subjectId });
  return send(env, chatId, `<b>${esc(s.name)}</b>\nChoose a paper.`, markup([...s.papers.map(p => [button(p.name, `up:paper:${s.id}:${p.id}`)]), [button("Cancel", "up:cancel")]]));
}
async function uploadType(env, chatId, userId, subjectId, paperId) {
  await setSession(env, userId, { mode: "upload_type", subjectId, paperId });
  return send(env, chatId, "Choose the resource type.", markup([...RESOURCE_TYPES.map(([t, label]) => [button(label, `up:type:${subjectId}:${paperId}:${t}`)]), [button("Cancel", "up:cancel")]]));
}
async function uploadYear(env, chatId, userId, subjectId, paperId, type) {
  await setSession(env, userId, { mode: "upload_year", subjectId, paperId, type });
  return send(env, chatId, "Send the exam year (e.g. 2023), or tap Skip.", markup([[button("Skip Year", "up:skipyear")], [button("Cancel", "up:cancel")]]));
}
async function uploadFiles(env, chatId, userId, subjectId, paperId, type, year = "", replaceId = null) {
  await setSession(env, userId, { mode: "upload_files", subjectId, paperId, type, year, replaceId, files: [] });
  return send(env, chatId, "Send one PDF (recommended) or up to 20 images. For images, send them one at a time so none are lost. Do not mix PDFs and images. When done, tap <b>Finish Upload</b>.", markup([[button("Finish Upload", "up:finish")], [button("Cancel Upload", "up:cancel")]]));
}
async function finishUpload(env, chatId, userId) {
  const session = await getSession(env, userId);
  if (session.mode !== "upload_files" || !session.files?.length) return send(env, chatId, "No files received yet. Send a PDF or images first.");
  const db = await getDb(env), s = findSubject(db, session.subjectId), p = findPaper(s, session.paperId);
  if (!s || !p) { await clearSession(env, userId); return send(env, chatId, "Subject or paper not found. Please start again."); }
  const old = session.replaceId ? db.resources.find(r => r.id === session.replaceId) : null;
  session.title = old?.title || defaultTitle(db, s, p, session.type, session.year);
  session.mode = "confirm_upload";
  await setSession(env, userId, session);
  return send(env, chatId, `<b>Confirm Resource</b>\nTitle: ${esc(session.title)}\nSubject: ${esc(s.name)}\nPaper: ${esc(p.name)}\nType: ${esc(typeLabel(session.type))}${session.year ? `\nYear: ${esc(session.year)}` : ""}\nFiles: ${session.files.length}\nPrice: ${priceText(env)}\n\nPublish this resource?`, markup([[button("Publish", "up:publish"), button("Cancel", "up:cancel")], [button("Rename Before Publishing", "up:rename")]]));
}
async function publishUpload(env, chatId, userId) {
  const session = await getSession(env, userId);
  if (session.mode !== "confirm_upload" || !session.files?.length) return send(env, chatId, "No finished upload is awaiting publication.");
  const db = await getDb(env), s = findSubject(db, session.subjectId), p = findPaper(s, session.paperId);
  if (!s || !p) { await clearSession(env, userId); return send(env, chatId, "Subject or paper no longer exists. Upload cancelled."); }
  const resource = {
    id: session.replaceId || makeId(), subjectId: s.id, paperId: p.id,
    type: session.type, year: session.year || "", title: session.title, files: session.files,
    updatedAt: new Date().toISOString(),
  };
  const index = session.replaceId ? db.resources.findIndex(r => r.id === session.replaceId) : -1;
  if (index >= 0) db.resources[index] = { ...db.resources[index], ...resource };
  else db.resources.push({ ...resource, createdAt: resource.updatedAt });
  await saveDb(env, db); await clearSession(env, userId);
  return send(env, chatId, `Published successfully:\n<b>${esc(resource.title)}</b>\nFiles: ${resource.files.length}`, markup([[button("Admin Home", "adm:home")], [button("Upload Another", "adm:upload")]]));
}

/* ───────────── Message handling ───────────── */

async function handleText(env, message) {
  const chatId = message.chat.id, userId = message.from.id, text = String(message.text || "").trim();
  const session = await getSession(env, userId), admin = isAdmin(env, userId);

  if (text === "/start" || text.startsWith("/start ")) { await clearSession(env, userId); return home(env, chatId); }
  if (text === "/paysupport") {
    return send(env, chatId, `<b>Payment support</b>\nIf a payment failed or a file did not arrive, first check <b>My Purchases</b>. Otherwise contact the administrator${env.SUPPORT_CONTACT ? ` at ${esc(env.SUPPORT_CONTACT)}` : ""} and quote your Telegram ID: <code>${userId}</code>.\nRefunds are issued by the administrator in Telegram Stars.`, markup([[button("My Purchases", "stu:mine:0")]]));
  }
  if (text === "/admin") return admin ? adminHome(env, chatId) : send(env, chatId, "Administrator access required.");
  if (text === "/cancel") { await clearSession(env, userId); return send(env, chatId, "Operation cancelled. Nothing pending was published.", markup([[button("Main Menu", "stu:home")]])); }
  if (text.startsWith("/refund")) {
    if (!admin) return send(env, chatId, "Administrator access required.");
    const [, uid, chargeId] = text.split(/\s+/);
    if (!uid || !chargeId) return send(env, chatId, "Usage: /refund &lt;userId&gt; &lt;chargeId&gt;");
    try {
      await telegram(env, "refundStarPayment", { user_id: Number(uid), telegram_payment_charge_id: chargeId });
      const buys = await getBuys(env, uid);
      for (const [rid, rec] of Object.entries(buys.items)) if (rec.chargeId === chargeId) delete buys.items[rid];
      await saveBuys(env, uid, buys);
      return send(env, chatId, "Refund issued and access removed.");
    } catch (e) { return send(env, chatId, `Refund failed: ${esc(e.message)}`); }
  }

  if (session.mode === "search") {
    const db = await getDb(env), owned = await ownedChecker(env, userId);
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    const found = sortResources(db.resources.filter(r => {
      const s = findSubject(db, r.subjectId), p = findPaper(s, r.paperId);
      const hay = [r.title, s?.name, p?.name, typeLabel(r.type), r.year].join(" ").toLowerCase();
      return tokens.length && tokens.every(t => hay.includes(t));
    })).slice(0, 30);
    await clearSession(env, userId);
    if (!found.length) return send(env, chatId, "No matching resources found.", markup([[button("Browse Subjects", "stu:subjects")]]));
    return send(env, chatId, `<b>Search Results</b>\n${found.length} result(s).`, markup([...found.map(r => [button(resLabel(owned, r), `stu:res:${r.id}`)]), mainRow()]));
  }

  if (!admin) return send(env, chatId, "Use /start to open the library menu.");

  if (session.mode === "add_subject") {
    const db = await getDb(env);
    if (db.subjects.some(s => s.name.toLowerCase() === text.toLowerCase())) return send(env, chatId, "That subject already exists. Send another name or /cancel.");
    db.subjects.push({ id: makeId(), name: text.slice(0, 80), papers: [] }); await saveDb(env, db); await clearSession(env, userId);
    return send(env, chatId, "Subject added. Now add its paper options.", markup([[button("Manage Subjects", "adm:subjects")]]));
  }
  if (session.mode === "rename_subject") {
    const db = await getDb(env), s = findSubject(db, session.subjectId);
    if (!s) return send(env, chatId, "Subject not found.");
    s.name = text.slice(0, 80); await saveDb(env, db); await clearSession(env, userId);
    return send(env, chatId, "Subject renamed.", markup([[button("Manage Subjects", "adm:subjects")]]));
  }
  if (session.mode === "add_paper") {
    const db = await getDb(env), s = findSubject(db, session.subjectId);
    if (!s) return send(env, chatId, "Subject not found.");
    if (s.papers.some(p => p.name.toLowerCase() === text.toLowerCase())) return send(env, chatId, "That paper already exists. Send another name or /cancel.");
    s.papers.push({ id: makeId(), name: text.slice(0, 80) }); await saveDb(env, db); await clearSession(env, userId);
    return send(env, chatId, "Paper added.", markup([[button("Manage Papers", `adm:papers:${s.id}`)]]));
  }
  if (session.mode === "rename_paper") {
    const db = await getDb(env), s = findSubject(db, session.subjectId), p = findPaper(s, session.paperId);
    if (!p) return send(env, chatId, "Paper not found.");
    p.name = text.slice(0, 80); await saveDb(env, db); await clearSession(env, userId);
    return send(env, chatId, "Paper renamed.", markup([[button("Manage Papers", `adm:papers:${s.id}`)]]));
  }
  if (session.mode === "rename_resource") {
    const db = await getDb(env), r = db.resources.find(x => x.id === session.resourceId);
    if (!r) return send(env, chatId, "Resource not found.");
    r.title = text.slice(0, 100); await saveDb(env, db); await clearSession(env, userId);
    return send(env, chatId, "Resource renamed.", markup([[button("Manage Library", "adm:resources")]]));
  }
  if (session.mode === "rename_upload") {
    session.title = text.slice(0, 100); session.mode = "confirm_upload"; await setSession(env, userId, session);
    return send(env, chatId, `<b>Confirm Resource</b>\nTitle: ${esc(session.title)}\nFiles: ${session.files.length}`, markup([[button("Publish", "up:publish"), button("Cancel", "up:cancel")]]));
  }
  if (session.mode === "upload_year") {
    if (!/^(19|20)\d{2}$/.test(text)) return send(env, chatId, "Send a 4-digit year such as 2023, tap Skip, or /cancel.", markup([[button("Skip Year", "up:skipyear")]]));
    return uploadFiles(env, chatId, userId, session.subjectId, session.paperId, session.type, text);
  }
  if (session.mode === "upload_files") {
    if (message.document) {
      if (session.files.length) return send(env, chatId, "Do not mix PDFs and images. Finish or cancel this upload first.");
      const doc = message.document;
      if (doc.mime_type !== "application/pdf" && !String(doc.file_name || "").toLowerCase().endsWith(".pdf")) return send(env, chatId, "Please send a PDF document or image pages.");
      session.files.push({ kind: "document", fileId: doc.file_id, fileName: doc.file_name || "resource.pdf" });
      await setSession(env, userId, session);
      return send(env, chatId, "PDF received. Tap Finish Upload when ready.", markup([[button("Finish Upload", "up:finish")], [button("Cancel Upload", "up:cancel")]]));
    }
    if (message.photo?.length) {
      if (session.files.some(f => f.kind === "document")) return send(env, chatId, "Do not mix a PDF with images in one resource.");
      if (session.files.length >= MAX_IMAGES) return send(env, chatId, `Limit reached: ${MAX_IMAGES} images per resource.`);
      const photo = message.photo[message.photo.length - 1];
      session.files.push({ kind: "photo", fileId: photo.file_id }); await setSession(env, userId, session);
      return send(env, chatId, `Image received (${session.files.length}/${MAX_IMAGES}). Send more or finish.`, markup([[button("Finish Upload", "up:finish")], [button("Cancel Upload", "up:cancel")]]));
    }
  }
  return send(env, chatId, "Use the menu buttons, or send /start to return to the main menu.");
}

async function handleCallback(env, query) {
  const data = query.data || "", chatId = query.message.chat.id, messageId = query.message.message_id, userId = query.from.id;
  await answerCallback(env, query.id);
  if (data === "noop") return;
  const admin = isAdmin(env, userId);
  if ((data.startsWith("adm:") || data.startsWith("up:")) && !admin) return send(env, chatId, "Administrator access required.");

  // Student
  if (data === "stu:home") return home(env, chatId, messageId);
  if (data === "stu:subjects") return subjectsMenu(env, chatId, messageId);
  if (data === "stu:search") { await setSession(env, userId, { mode: "search" }); return send(env, chatId, "Send a word or phrase to search, e.g. <i>chemistry paper 2 2022</i>.", markup([[button("Cancel", "stu:home")]])); }
  if (data === "stu:help") return edit(env, chatId, messageId, `<b>How to use the library</b>\n1. Choose a subject, paper and type.\n2. Tap a resource marked ⭐.\n3. Pay ${priceText(env)} with Telegram Stars.\n4. The file is sent here instantly and saved in <b>My Purchases</b>.\n\nProblems? Send /paysupport.`, markup([mainRow()]));
  if (data.startsWith("stu:mine:")) return purchasesMenu(env, chatId, messageId, userId, Number(data.split(":")[2]) || 0);
  if (data.startsWith("stu:sub:")) return papersMenu(env, chatId, messageId, data.split(":")[2]);
  if (data.startsWith("stu:paper:")) { const [, , s, p] = data.split(":"); return typesMenu(env, chatId, messageId, s, p); }
  if (data.startsWith("stu:type:")) { const [, , s, p, t, pg] = data.split(":"); return resourcesMenu(env, chatId, messageId, userId, s, p, t, Number(pg) || 0); }
  if (data.startsWith("stu:res:")) return openResource(env, chatId, userId, data.split(":")[2]);
  if (data.startsWith("stu:buy:")) return sendInvoice(env, chatId, userId, data.split(":")[2]);

  // Admin
  if (data === "adm:home") return adminHome(env, chatId, messageId);
  if (data === "adm:upload") return startUpload(env, chatId, userId);
  if (data === "adm:subjects") return adminSubjects(env, chatId, messageId);
  if (data === "adm:resources") return adminResources(env, chatId, messageId, 0);
  if (data.startsWith("adm:resources:")) return adminResources(env, chatId, messageId, Number(data.split(":")[2]) || 0);
  if (data === "adm:export") {
    const db = await getDb(env), file = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...db }, null, 2)], { type: "application/json" });
    const form = new FormData(); form.append("chat_id", String(chatId)); form.append("document", file, "kcse-catalogue-backup.json");
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
    const result = await res.json(); if (!result.ok) throw new Error(result.description || "Export failed"); return;
  }
  if (data === "adm:addsubject") { await setSession(env, userId, { mode: "add_subject" }); return send(env, chatId, "Send the new subject name, or /cancel."); }
  if (data.startsWith("adm:subject:")) return adminSubject(env, chatId, messageId, data.split(":")[2]);
  if (data.startsWith("adm:renamesub:")) { await setSession(env, userId, { mode: "rename_subject", subjectId: data.split(":")[2] }); return send(env, chatId, "Send the new subject name, or /cancel."); }
  if (data.startsWith("adm:papers:")) return adminPapers(env, chatId, messageId, data.split(":")[2]);
  if (data.startsWith("adm:addpaper:")) { await setSession(env, userId, { mode: "add_paper", subjectId: data.split(":")[2] }); return send(env, chatId, "Send the paper name, e.g. Paper 1, or /cancel."); }
  if (data.startsWith("adm:paper:")) { const [, , s, p] = data.split(":"); return adminPaper(env, chatId, messageId, s, p); }
  if (data.startsWith("adm:renamepaper:")) { const [, , s, p] = data.split(":"); await setSession(env, userId, { mode: "rename_paper", subjectId: s, paperId: p }); return send(env, chatId, "Send the new paper name, or /cancel."); }
  if (data.startsWith("adm:delpaper:")) { const [, , s, p] = data.split(":"); return send(env, chatId, "Delete this paper and its resources?", markup([[button("Confirm Delete", `adm:delpaperok:${s}:${p}`)], [button("Cancel", `adm:papers:${s}`)]])); }
  if (data.startsWith("adm:delpaperok:")) { const [, , sId, pId] = data.split(":"); const db = await getDb(env), s = findSubject(db, sId); if (s) s.papers = s.papers.filter(p => p.id !== pId); db.resources = db.resources.filter(r => !(r.subjectId === sId && r.paperId === pId)); await saveDb(env, db); return send(env, chatId, "Paper and its resources deleted.", markup([[button("Manage Papers", `adm:papers:${sId}`)]])); }
  if (data.startsWith("adm:delsub:")) { const s = data.split(":")[2]; return send(env, chatId, "Delete this subject, its papers and resources?", markup([[button("Confirm Delete", `adm:delsubok:${s}`)], [button("Cancel", `adm:subject:${s}`)]])); }
  if (data.startsWith("adm:delsubok:")) { const sId = data.split(":")[2], db = await getDb(env); db.subjects = db.subjects.filter(s => s.id !== sId); db.resources = db.resources.filter(r => r.subjectId !== sId); await saveDb(env, db); return send(env, chatId, "Subject and its resources deleted.", markup([[button("Manage Subjects", "adm:subjects")]])); }
  if (data.startsWith("adm:resource:")) return adminResource(env, chatId, messageId, data.split(":")[2]);
  if (data.startsWith("adm:renameres:")) { await setSession(env, userId, { mode: "rename_resource", resourceId: data.split(":")[2] }); return send(env, chatId, "Send the new resource title, or /cancel."); }
  if (data.startsWith("adm:replace:")) { const r = (await getDb(env)).resources.find(x => x.id === data.split(":")[2]); if (!r) return send(env, chatId, "Resource not found."); return uploadFiles(env, chatId, userId, r.subjectId, r.paperId, r.type, r.year || "", r.id); }
  if (data.startsWith("adm:delres:")) { const r = data.split(":")[2]; return send(env, chatId, "Delete this resource permanently? Buyers will lose access to it.", markup([[button("Confirm Delete", `adm:delresok:${r}`)], [button("Cancel", `adm:resource:${r}`)]])); }
  if (data.startsWith("adm:delresok:")) { const rId = data.split(":")[2], db = await getDb(env); db.resources = db.resources.filter(r => r.id !== rId); await saveDb(env, db); return send(env, chatId, "Resource deleted.", markup([[button("Manage Library", "adm:resources")]])); }

  // Upload flow
  if (data.startsWith("up:sub:")) return uploadPaper(env, chatId, userId, data.split(":")[2]);
  if (data.startsWith("up:paper:")) { const [, , s, p] = data.split(":"); return uploadType(env, chatId, userId, s, p); }
  if (data.startsWith("up:type:")) { const [, , s, p, t] = data.split(":"); return uploadYear(env, chatId, userId, s, p, t); }
  if (data === "up:skipyear") { const s = await getSession(env, userId); if (s.mode !== "upload_year") return send(env, chatId, "No upload is waiting for a year."); return uploadFiles(env, chatId, userId, s.subjectId, s.paperId, s.type, ""); }
  if (data === "up:finish") return finishUpload(env, chatId, userId);
  if (data === "up:publish") return publishUpload(env, chatId, userId);
  if (data === "up:rename") { const s = await getSession(env, userId); if (s.mode !== "confirm_upload") return send(env, chatId, "No upload is awaiting a title."); s.mode = "rename_upload"; await setSession(env, userId, s); return send(env, chatId, "Send the resource title, or /cancel."); }
  if (data === "up:cancel") { await clearSession(env, userId); return send(env, chatId, "Pending upload cancelled. Nothing was published.", markup([[button("Admin Home", "adm:home")]])); }
}

async function handleUpdate(env, update) {
  if (update.pre_checkout_query) return handlePreCheckout(env, update.pre_checkout_query);
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const m = update.message;
  if (!m?.from || !m.chat || m.from.is_bot) return;
  if (m.successful_payment) return handlePayment(env, m);
  if (m.chat.type !== "private") return send(env, m.chat.id, "Please use this bot in a private chat.");
  const userId = m.from.id, session = await getSession(env, userId);
  if (m.text) return handleText(env, m);
  if (isAdmin(env, userId) && session.mode === "upload_files") return handleText(env, m);
  if (isAdmin(env, userId)) return send(env, m.chat.id, "Open Admin → Upload Resources before sending a file.");
  return send(env, m.chat.id, "Use /start to open the library menu.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("KCSE Papers Bot is running.", { status: 200 });
    if (request.method !== "POST" || url.pathname !== "/telegram") return new Response("Not found", { status: 404 });
    if (!env.BOT_TOKEN || !env.ADMIN_ID || !env.BOT_KV || !env.WEBHOOK_SECRET) return new Response("Missing BOT_TOKEN, ADMIN_ID, WEBHOOK_SECRET or BOT_KV configuration.", { status: 500 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
    try { await handleUpdate(env, await request.json()); }
    catch (error) { console.error("Update handling failed:", error?.stack || error); }
    // Always acknowledge so Telegram does not retry; check Worker logs for errors.
    return new Response("OK", { status: 200 });
  },
};

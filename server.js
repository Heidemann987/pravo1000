// =============================================================
//  PRAVO 1000 — backend (Crypto Pay + Telegram WebApp)
//  Node.js 18+
// =============================================================

'use strict';

const express = require('express');
const crypto  = require('crypto');
const pino    = require('pino');
const rateLimit = require('express-rate-limit');
const Database  = require('better-sqlite3');

// =============================================================
//  CONFIG
// =============================================================
const CRYPTO_PAY_TOKEN  = process.env.CRYPTO_PAY_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!CRYPTO_PAY_TOKEN || !TELEGRAM_BOT_TOKEN) {
  console.error('❌ Не заданы CRYPTO_PAY_TOKEN или TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const CRYPTO_PAY_API   = 'https://pay.crypt.bot/api';
const TELEGRAM_API     = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const PORT             = process.env.PORT || 3000;
const ALLOWED_ORIGIN   = 'https://heidemann987.github.io';
const DB_FILE          = process.env.DB_FILE || './pravo.db';

// Единая цена — 2 USDT для всех тарифов
const PRICE_USDT = '2';

const PRICES = {
  single:    { amount: PRICE_USDT, currency: 'USDT', title: 'PRAVO 1000 — 1 документ'  },
  pack5:     { amount: PRICE_USDT, currency: 'USDT', title: 'PRAVO 1000 — 5 документов' },
  pack10:    { amount: PRICE_USDT, currency: 'USDT', title: 'PRAVO 1000 — 10 документов' },
  unlimited: { amount: PRICE_USDT, currency: 'USDT', title: 'PRAVO 1000 — Безлимит'      }
};

// =============================================================
//  LOGGER
// =============================================================
const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true } }
});

// =============================================================
//  DATABASE (SQLite)
// =============================================================
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    invoice_id   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    plan         TEXT    NOT NULL,
    amount       TEXT    NOT NULL,
    asset        TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'active',
    paid_at      TEXT,
    delivered_at TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
`);

const stmtInsertInvoice = db.prepare(`
  INSERT OR IGNORE INTO invoices (invoice_id, user_id, plan, amount, asset, status)
  VALUES (@invoice_id, @user_id, @plan, @amount, @asset, 'active')
`);

const stmtMarkPaid = db.prepare(`
  UPDATE invoices
     SET status = 'paid', paid_at = @paid_at
   WHERE invoice_id = @invoice_id AND status != 'paid'
`);

const stmtMarkDelivered = db.prepare(`
  UPDATE invoices SET delivered_at = @delivered_at WHERE invoice_id = @invoice_id
`);

const stmtMarkExpired = db.prepare(`
  UPDATE invoices SET status = 'expired' WHERE invoice_id = @invoice_id AND status = 'active'
`);

const stmtGetInvoice = db.prepare(`
  SELECT * FROM invoices WHERE invoice_id = ?
`);

// =============================================================
//  APP
// =============================================================
const app = express();
app.set('trust proxy', 1); // для Render / прокси

// CORS — только для GitHub Pages
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Init-Data');
  res.header('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// JSON body c «сырым» телом для проверки подписи вебхука
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

// Rate limit на /api/*
app.use('/api/', rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
}));

// =============================================================
//  HELPERS
// =============================================================
async function cryptoPay(method, params = {}) {
  const res = await fetch(`${CRYPTO_PAY_API}/${method}`, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': CRYPTO_PAY_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error?.message || 'Crypto Pay error');
  return data.result;
}

async function tgApi(method, params = {}) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return res.json();
}

/**
 * Проверка initData из Telegram WebApp.
 * Возвращает объект user или null.
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') return null;

  let params;
  try { params = new URLSearchParams(initData); }
  catch { return null; }

  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  // Порядок: сортировка по ключу (не по значению!)
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check  = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  // timingSafeEqual — защита от timing-атак
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Свежесть: не старше 24 часов
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  try { return JSON.parse(params.get('user') || 'null'); }
  catch { return null; }
}

function isValidPlan(plan) {
  return typeof plan === 'string'
      && Object.prototype.hasOwnProperty.call(PRICES, plan);
}

// =============================================================
//  ROUTES
// =============================================================

// --- Health check ---
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'PRAVO 1000 backend',
    crypto_token: !!CRYPTO_PAY_TOKEN,
    bot_token: !!TELEGRAM_BOT_TOKEN,
    time: new Date().toISOString()
  });
});

// --- Создать счёт ---
app.post('/api/invoice', async (req, res) => {
  try {
    const { plan = 'single', initData } = req.body || {};

    if (!isValidPlan(plan)) {
      return res.status(400).json({ ok: false, error: 'Unknown plan' });
    }

    const user = validateInitData(initData, TELEGRAM_BOT_TOKEN);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid initData' });
    }

    const price = PRICES[plan];

    const invoice = await cryptoPay('createInvoice', {
      currency_type: 'crypto',
      asset: price.currency,
      amount: String(price.amount),
      description: price.title,
      payload: JSON.stringify({ plan, userId: user.id }),
      expires_in: 3600
    });

    // Сохраняем у себя
    stmtInsertInvoice.run({
      invoice_id: String(invoice.invoice_id),
      user_id:    user.id,
      plan,
      amount:     String(invoice.amount),
      asset:      invoice.asset
    });

    log.info({ invoice_id: invoice.invoice_id, user_id: user.id, plan }, 'invoice created');

    res.json({
      ok: true,
      invoice_id: invoice.invoice_id,
      pay_url:    invoice.bot_invoice_url,
      amount:     invoice.amount,
      currency:   invoice.asset
    });
  } catch (e) {
    log.error({ err: e }, 'invoice error');
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// --- Проверить статус (только владелец) ---
app.get('/api/invoice/:id/status', async (req, res) => {
  try {
    const user = validateInitData(req.headers['x-init-data'], TELEGRAM_BOT_TOKEN);
    if (!user) return res.status(401).json({ ok: false });

    const invoiceId = String(req.params.id);

    // Сначала смотрим в БД — быстро и без запроса в Crypto Pay
    const local = stmtGetInvoice.get(invoiceId);
    if (local) {
      if (local.user_id !== user.id) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }
      // Если уже оплачен — Crypto Pay не трогаем
      if (local.status === 'paid') {
        return res.json({ ok: true, status: 'paid', paid_at: local.paid_at });
      }
    }

    // Иначе спрашиваем Crypto Pay
    const data = await cryptoPay('getInvoices', { invoice_ids: invoiceId });
    const inv  = data.items?.[0];
    if (!inv) return res.status(404).json({ ok: false });

    let payload = {};
    try { payload = JSON.parse(inv.payload || '{}'); } catch {}

    if (payload.userId !== user.id) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    res.json({ ok: true, status: inv.status, paid_at: inv.paid_at || null });
  } catch (e) {
    log.error({ err: e }, 'status error');
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// --- Вебхук от Crypto Pay ---
app.post('/api/webhook', async (req, res) => {
  try {
    // 1. Проверка подписи (используем сырое тело)
    const signature = req.headers['crypto-pay-api-signature'];
    const secret    = crypto.createHash('sha256').update(CRYPTO_PAY_TOKEN).digest();
    const check     = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');

    const a = Buffer.from(check, 'hex');
    const b = Buffer.from(String(signature || ''), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      log.warn('❌ Invalid webhook signature');
      return res.sendStatus(403);
    }

    const update = req.body || {};
    const inv    = update.payload || {};

    if (!inv.invoice_id) {
      log.warn({ update_type: update.update_type }, 'webhook without invoice_id');
      return res.sendStatus(200);
    }

    log.info({ type: update.update_type, invoice_id: inv.invoice_id }, 'webhook');

    // 2. Оплата
    if (update.update_type === 'invoice_paid') {
      const local = stmtGetInvoice.get(String(inv.invoice_id));
      if (local?.status === 'paid') {
        log.info({ invoice_id: inv.invoice_id }, 'duplicate paid webhook, skip');
        return res.sendStatus(200);
      }

      let payload = {};
      try { payload = JSON.parse(inv.payload || '{}'); } catch {}

      stmtMarkPaid.run({
        invoice_id: String(inv.invoice_id),
        paid_at:    inv.paid_at || new Date().toISOString()
      });

      log.info({
        invoice_id: inv.invoice_id,
        amount: inv.amount,
        asset:  inv.asset,
        plan:   payload.plan,
        userId: payload.userId
      }, '✅ invoice paid');

      // TODO: здесь сгенерировать PDF и приложить ссылку / file_id
      // const pdfUrl = await generateDocument(payload);

      if (payload.userId) {
        try {
          await tgApi('sendMessage', {
            chat_id: payload.userId,
            text:
              `✅ <b>Оплата получена</b>\n\n` +
              `Тариф: <b>${payload.plan}</b>\n` +
              `Сумма: <b>${inv.amount} ${inv.asset}</b>\n\n` +
              `📄 Документ доступен — откройте PRAVO 1000 и нажмите «Скачать».`,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });

          stmtMarkDelivered.run({
            invoice_id: String(inv.invoice_id),
            delivered_at: new Date().toISOString()
          });
        } catch (e) {
          log.error({ err: e }, 'sendMessage error');
        }
      }
    }

    // 3. Просрочен
    if (update.update_type === 'invoice_expired') {
      stmtMarkExpired.run({ invoice_id: String(inv.invoice_id) });
      log.info({ invoice_id: inv.invoice_id }, '⏰ invoice expired');
    }

    // 4. Удалён
    if (update.update_type === 'invoice_deleted') {
      stmtMarkExpired.run({ invoice_id: String(inv.invoice_id) });
      log.info({ invoice_id: inv.invoice_id }, '🗑️ invoice deleted');
    }

    res.sendStatus(200);
  } catch (e) {
    log.error({ err: e }, 'webhook error');
    // Всегда возвращаем 200, чтобы Crypto Pay не ретраил бесконечно
    // (иначе он будет долбить нас при наших ошибках)
    res.sendStatus(200);
  }
});

// =============================================================
//  START
// =============================================================
app.listen(PORT, () => {
  log.info(`🚀 PRAVO 1000 backend на порту ${PORT}`);
  log.info(`   CRYPTO_PAY_TOKEN:  ${CRYPTO_PAY_TOKEN  ? '✅' : '❌'}`);
  log.info(`   TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
  log.info(`   DB: ${DB_FILE}`);
});

// graceful shutdown
process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });

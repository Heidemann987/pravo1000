// server.js — PRAVO 1000 backend (Crypto Pay + Telegram)
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// ============ CONFIG ============
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRYPTO_PAY_API = 'https://pay.crypt.bot/api';
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = 'https://heidemann987.github.io';

// Тарифы (в USDT)
const PRICES = {
  single:    { amount: 2,   currency: 'USDT', title: 'PRAVO 1000 — 1 документ' },
  pack5:     { amount: 8,   currency: 'USDT', title: 'PRAVO 1000 — 5 документов' },
  pack10:    { amount: 15,  currency: 'USDT', title: 'PRAVO 1000 — 10 документов' },
  unlimited: { amount: 100, currency: 'USDT', title: 'PRAVO 1000 — Безлимит' }
};

// ============ CORS ============
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============ Crypto Pay API ============
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

// ============ Telegram Bot API ============
async function tgApi(method, params = {}) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return res.json();
}

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'PRAVO 1000 backend',
    crypto_token: !!CRYPTO_PAY_TOKEN,
    bot_token: !!TELEGRAM_BOT_TOKEN,
    time: new Date().toISOString()
  });
});

// ============ СОЗДАТЬ СЧЁТ ============
app.post('/api/invoice', async (req, res) => {
  try {
    const { plan = 'single', userId } = req.body || {};
    const price = PRICES[plan];
    if (!price) return res.status(400).json({ error: 'Unknown plan' });

    const invoice = await cryptoPay('createInvoice', {
      currency_type: 'crypto',
      asset: price.currency,
      amount: String(price.amount),
      description: price.title,
      payload: JSON.stringify({ plan, userId: userId || null }),
      expires_in: 3600
    });

    res.json({
      ok: true,
      invoice_id: invoice.invoice_id,
      pay_url: invoice.bot_invoice_url,
      amount: invoice.amount,
      currency: invoice.asset
    });
  } catch (e) {
    console.error('invoice error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ ПРОВЕРИТЬ СТАТУС ============
app.get('/api/invoice/:id', async (req, res) => {
  try {
    const invoices = await cryptoPay('getInvoices', { invoice_ids: req.params.id });
    if (!invoices.items?.length) return res.status(404).json({ ok: false });
    const inv = invoices.items[0];
    res.json({ ok: true, status: inv.status, paid_at: inv.paid_at || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ ВЕБХУК ОТ CRYPTO PAY ============
app.post('/api/webhook', async (req, res) => {
  // Проверка подписи
  const signature = req.headers['crypto-pay-api-signature'];
  const secret = crypto.createHash('sha256').update(CRYPTO_PAY_TOKEN).digest();
  const body = JSON.stringify(req.body);
  const check = crypto.createHmac('sha256', secret).update(body).digest('hex');

  if (signature !== check) {
    console.warn('❌ Invalid webhook signature');
    return res.sendStatus(403);
  }

  const update = req.body;
  console.log('📨 Webhook:', update.update_type);

  if (update.update_type === 'invoice_paid') {
    const inv = update.payload;
    let payload = {};
    try { payload = JSON.parse(inv.payload || '{}'); } catch (e) {}

    console.log('✅ ОПЛАЧЕНО:', {
      invoice_id: inv.invoice_id,
      amount: inv.amount,
      asset: inv.asset,
      plan: payload.plan,
      userId: payload.userId
    });

    // Отправляем пользователю уведомление (если знаем его ID)
    if (payload.userId) {
      try {
        await tgApi('sendMessage', {
          chat_id: payload.userId,
          text: `✅ Оплата получена!\n\nТариф: ${payload.plan}\nСумма: ${inv.amount} ${inv.asset}\n\n📄 Ваш документ готов. Нажмите /start и выберите «Открыть PRAVO 1000», чтобы скачать.`,
          parse_mode: 'HTML'
        });
      } catch (e) {
        console.error('sendMessage error:', e);
      }
    }
  }

  res.sendStatus(200);
});

// ============ START ============
app.listen(PORT, () => {
  console.log(`🚀 PRAVO 1000 backend на порту ${PORT}`);
  console.log(`   CRYPTO_PAY_TOKEN: ${CRYPTO_PAY_TOKEN ? '✅' : '❌'}`);
  console.log(`   TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
});

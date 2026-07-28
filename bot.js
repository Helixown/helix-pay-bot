require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first'); // evita 502/504 intermitentes de Telegram por resolucion IPv6 en Railway
const TelegramBot = require('node-telegram-bot-api');
const express    = require('express');
const axios      = require('axios');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const Stripe     = require('stripe');

const BOT_TOKEN             = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID         = parseInt(process.env.ADMIN_CHAT_ID || '8237372777');
const PADDLE_API_KEY        = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PUBLIC_URL            = process.env.PUBLIC_URL || 'https://helix-pay-bot-production.up.railway.app';
const APP_BASE_URL          = process.env.APP_BASE_URL || 'https://helix-pay-bot-production.up.railway.app';
const CHANNEL_ID            = process.env.CHANNEL_ID || '@Cuentasonlyfans23k';
const PORT                  = process.env.PORT || 3000;

const bot    = new TelegramBot(BOT_TOKEN, { polling: true });
const app    = express();
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

bot.setMyCommands([{ command: 'start', description: 'Iniciar' }]).catch(() => {});

let cachedBotUsername = null;
async function getBotUsername() {
    if (cachedBotUsername) return cachedBotUsername;
    const me = await bot.getMe();
    cachedBotUsername = me.username;
    return cachedBotUsername;
}

// Navegación por botones: un solo panel fijo que se va editando en su lugar
async function editOrSend(chatId, messageId, text, options = {}) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options })
        .catch(() => bot.sendMessage(chatId, text, options));
}

// Tras escribir texto (Promocionar, actualizar datos bancarios): borra el aviso viejo y manda la confirmación nueva abajo
async function replacePanel(chatId, oldMessageId, text, options = {}) {
    const sent = await bot.sendMessage(chatId, text, options);
    if (oldMessageId) bot.deleteMessage(chatId, oldMessageId).catch(() => {});
    return sent;
}

// ── Operadores ────────────────────────────────────────────────────────────────
const OPERATORS_FILE = process.env.OPERATORS_FILE || path.join(__dirname, 'operators.json');
function loadOperadores() {
    try { return new Set(JSON.parse(fs.readFileSync(OPERATORS_FILE, 'utf8'))); }
    catch { return new Set(); }
}
const operadores = loadOperadores();
operadores.add(ADMIN_CHAT_ID);
function saveOperadores() { fs.writeFileSync(OPERATORS_FILE, JSON.stringify([...operadores])); }
function isAllowed(chatId) { return operadores.has(chatId); }

// ── Clientes conocidos (para avisar al admin solo de clientes nuevos) ─────────
const CUSTOMERS_FILE = process.env.CUSTOMERS_FILE || path.join(__dirname, 'customers.json');
function loadCustomers() {
    try { return new Set(JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8'))); }
    catch { return new Set(); }
}
const knownCustomers = loadCustomers();
function saveCustomers() { fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify([...knownCustomers])); }

// ── Canales donde el bot es admin (para el broadcast de "Promocionar") ────────
const CHANNELS_FILE = process.env.CHANNELS_FILE || path.join(__dirname, 'channels.json');
function loadChannels() {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')))); }
    catch { return new Map(); }
}
const knownChannels = loadChannels(); // chatId (string) -> { title }
function saveChannels() { fs.writeFileSync(CHANNELS_FILE, JSON.stringify(Object.fromEntries(knownChannels))); }

// ── Catálogo de productos ─────────────────────────────────────────────────────
const PRODUCTS_FILE = process.env.PRODUCTS_FILE || path.join(__dirname, 'products.json');
function loadCatalog() {
    try { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); }
    catch { return { nextId: 1, items: {} }; }
}
const catalog = loadCatalog();
function saveCatalog() { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(catalog, null, 2)); }

// ── Historial de ventas ───────────────────────────────────────────────────────
const SALES_FILE = process.env.SALES_FILE || path.join(__dirname, 'sales.json');
function loadSales() {
    try { return JSON.parse(fs.readFileSync(SALES_FILE, 'utf8')); }
    catch { return []; }
}
const sales = loadSales();
function recordSale(sale) {
    sales.push(sale);
    fs.writeFileSync(SALES_FILE, JSON.stringify(sales, null, 2));
}

// ── Métodos de pago manuales (transferencia MXN, Binance ID, AirTM, Remitly) ──
const PAYMENT_METHODS = {
    mxn:     { label: '🏧 Transferencia MXN', title: 'Transferencia MXN', file: process.env.BANK_FILE    || path.join(__dirname, 'bank.json'),    mxn: true },
    binance: { label: '🟡 Binance ID',        title: 'Binance',           file: process.env.BINANCE_FILE || path.join(__dirname, 'binance.json'), mxn: false },
    airtm:   { label: '🔵 AirTM',             title: 'AirTM',             file: process.env.AIRTM_FILE   || path.join(__dirname, 'airtm.json'),   mxn: false },
    remitly: { label: '🟣 Remitly',           title: 'Remitly',           file: process.env.REMITLY_FILE || path.join(__dirname, 'remitly.json'), mxn: false }
};

function loadMethodDetails(key) {
    try { return JSON.parse(fs.readFileSync(PAYMENT_METHODS[key].file, 'utf8')).text || null; }
    catch { return null; }
}
function saveMethodDetails(key, text) { fs.writeFileSync(PAYMENT_METHODS[key].file, JSON.stringify({ text })); }
function formatDetailLines(text) {
    const esc = (s) => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    return text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (trimmed.includes(':')) return esc(trimmed);
        return `<code>${esc(trimmed)}</code>`;
    }).join('\n');
}

// Metadatos de cada checkout generado (a qué cliente/operador entregar cuando llegue el webhook)
// Persistido en disco para sobrevivir a reinicios entre que el cliente paga y el webhook confirma
const CHECKOUT_META_FILE = process.env.CHECKOUT_META_FILE || path.join(__dirname, 'checkout_meta.json');
const CHECKOUT_META_TTL_MS = 24 * 60 * 60 * 1000;

function loadCheckoutMeta() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(CHECKOUT_META_FILE, 'utf8')); }
    catch { return new Map(); }
    const map = new Map();
    const now = Date.now();
    for (const [txId, entry] of Object.entries(raw)) {
        if (entry.createdAt && now - entry.createdAt < CHECKOUT_META_TTL_MS) map.set(txId, entry);
    }
    return map;
}
const checkoutMeta = loadCheckoutMeta();
function persistCheckoutMeta() { fs.writeFileSync(CHECKOUT_META_FILE, JSON.stringify(Object.fromEntries(checkoutMeta))); }

function saveCheckoutMeta(txId, meta) {
    checkoutMeta.set(txId, { ...meta, createdAt: Date.now() });
    persistCheckoutMeta();
    setTimeout(() => { checkoutMeta.delete(txId); persistCheckoutMeta(); }, CHECKOUT_META_TTL_MS);
}

// Reprograma el borrado de lo que ya estaba en disco al arrancar
for (const [txId, entry] of checkoutMeta) {
    const remaining = CHECKOUT_META_TTL_MS - (Date.now() - entry.createdAt);
    setTimeout(() => { checkoutMeta.delete(txId); persistCheckoutMeta(); }, Math.max(remaining, 0));
}

// Aviso de pago confirmado: al admin con detalle completo, a los demás operadores sin el correo del cliente
function notifyPaymentReceived(adminText, operatorText) {
    bot.sendMessage(ADMIN_CHAT_ID, adminText, { parse_mode: 'HTML' }).catch(() => {});
    for (const opId of operadores) {
        if (opId === ADMIN_CHAT_ID) continue;
        bot.sendMessage(opId, operatorText, { parse_mode: 'HTML' }).catch(() => {});
    }
}

// Avisa a todos los operadores (menos los excluidos), para que cualquiera pueda cubrir una transferencia MXN
function notifyAllOperators(text, options = {}, exclude = []) {
    for (const opId of operadores) {
        if (exclude.includes(opId)) continue;
        bot.sendMessage(opId, text, options).catch(() => {});
    }
}

// Tras confirmarse un pago (Stripe/Paddle), pide la cuenta a entregar a TODOS los operadores (cualquiera puede entregar)
function triggerDelivery(txId, description) {
    const meta = checkoutMeta.get(txId);
    if (!meta || !meta.customerChatId) return;
    const { customerChatId } = meta;
    for (const opId of operadores) {
        awaitingDelivery.set(opId, { customerChatId, description });
    }
    persistTransfersState();
    setTimeout(() => {
        for (const opId of operadores) {
            const cur = awaitingDelivery.get(opId);
            if (cur && cur.customerChatId === customerChatId) awaitingDelivery.delete(opId);
        }
        persistTransfersState();
    }, 30 * 60 * 1000);
    notifyAllOperators('✏️ Pago confirmado — escribe la cuenta a entregar (formato correo:contraseña).', {}, []);
}

// ── Pending payments (in-memory) ─────────────────────────────────────────────
const pendingPayments = new Map();
function savePending(amount, description, targetChatId, operatorChatId) {
    const id = crypto.randomBytes(4).toString('hex');
    pendingPayments.set(id, { amount, description, targetChatId, operatorChatId });
    setTimeout(() => pendingPayments.delete(id), 30 * 60 * 1000); // expira en 30 min
    return id;
}

function metodoPagoPanel(pendingId, amount, description, showCatalogoBack) {
    const row1 = [];
    if (stripe) row1.push({ text: '💳 Tarjeta (Stripe)', callback_data: `pay_s_${pendingId}` });
    row1.push({ text: '🏦 PayPal (Paddle)', callback_data: `pay_p_${pendingId}` });
    const keyboard = [
        row1,
        [{ text: '🏧 Transferencia MXN', callback_data: `pay_m_mxn_${pendingId}` }],
        [{ text: '🟡 Binance ID', callback_data: `pay_m_binance_${pendingId}` }, { text: '🔵 AirTM', callback_data: `pay_m_airtm_${pendingId}` }],
        [{ text: '🟣 Remitly', callback_data: `pay_m_remitly_${pendingId}` }]
    ];
    if (showCatalogoBack) keyboard.push([{ text: '⬅️ Volver al catálogo', callback_data: 'back_tienda' }]);
    return { text: `💰 <b>$${parseFloat(amount).toFixed(2)} USD</b> — ${description}\nSelecciona método de pago:`, keyboard };
}

const awaitingCanalPost = new Map(); // chatId del operador -> message_id del panel a editar, mientras espera el texto para el canal

// ── Transferencias manuales (MXN, Binance, AirTM) ─────────────────────────────
// Persistido en disco para sobrevivir a reinicios entre que se manda el cobro y se confirma/entrega
const awaitingMethodUpdate = new Map(); // chatId del operador -> { key, messageId } mientras espera el texto para actualizar un método de pago

const TRANSFERS_FILE = process.env.TRANSFERS_FILE || path.join(__dirname, 'transfers.json');
function loadTransfersState() {
    try {
        const raw = JSON.parse(fs.readFileSync(TRANSFERS_FILE, 'utf8'));
        return {
            pendingTransfers:   new Map(Object.entries(raw.pendingTransfers || {})),
            transferByCustomer: new Map(Object.entries(raw.transferByCustomer || {}).map(([k, v]) => [Number(k), v])),
            awaitingDelivery:   new Map(Object.entries(raw.awaitingDelivery || {}).map(([k, v]) => [Number(k), v])),
            transferMessages:   new Map(Object.entries(raw.transferMessages || {}))
        };
    } catch {
        return { pendingTransfers: new Map(), transferByCustomer: new Map(), awaitingDelivery: new Map(), transferMessages: new Map() };
    }
}
const _transfersState    = loadTransfersState();
const pendingTransfers   = _transfersState.pendingTransfers;   // transferId -> { customerChatId, amount, description, operatorChatId }
const transferByCustomer = _transfersState.transferByCustomer; // customerChatId -> { transferId, operatorChatId }
const awaitingDelivery   = _transfersState.awaitingDelivery;   // chatId del operador -> { customerChatId, description }
const transferMessages   = _transfersState.transferMessages;   // `${operatorChatId}:${messageId}` -> transferId (para responder con reply y confirmar+entregar)

function persistTransfersState() {
    fs.writeFileSync(TRANSFERS_FILE, JSON.stringify({
        pendingTransfers:   Object.fromEntries(pendingTransfers),
        transferByCustomer: Object.fromEntries(transferByCustomer),
        awaitingDelivery:   Object.fromEntries(awaitingDelivery),
        transferMessages:   Object.fromEntries(transferMessages)
    }));
}

const DELIVERY_RECOMMENDATIONS =
`⚠️ <b>Recomendaciones</b>
━━━━━━━━━━━━━━
🚫 No usar el navegador <b>Aloha</b>
🔒 No cambiar la información de la cuenta
🌎 VPN recomendada: <b>Canadá 🇨🇦 · Japón 🇯🇵 · México 🇲🇽 · Colombia 🇨🇴</b>
🌐 Navegadores recomendados: <b>Chrome · DuckDuckGo · Firefox</b>`;

// Si el texto es "correo:contraseña", arma el mensaje de entrega con el formato pedido (correo / contraseña / número de la descripción, ej. "Cuenta de 200" -> 200)
function formatDelivery(text, description) {
    const sep = text.indexOf(':');
    if (sep === -1) return null;
    const email    = text.slice(0, sep).trim();
    const password = text.slice(sep + 1).trim();
    const esc = (s) => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const match = String(description).match(/\d+(\.\d+)?/);
    const value = match ? `💰 $${match[0]}` : description;
    return `🎉 <b>¡Gracias por tu compra!</b>\n\n📧 Email: <code>${esc(email)}</code>\n\n🔑 Pass: <code>${esc(password)}</code>\n\n${value}\n\n${DELIVERY_RECOMMENDATIONS}`;
}

// ── Payment landing pages (mini app) ─────────────────────────────────────────
const paymentLinks = new Map();
function saveLink(data) {
    const id = crypto.randomBytes(4).toString('hex');
    paymentLinks.set(id, data);
    setTimeout(() => paymentLinks.delete(id), 30 * 60 * 1000); // expira en 30 min
    return id;
}

const STRIPE_LOGO_SVG = `<svg viewBox="0 0 468 222" xmlns="http://www.w3.org/2000/svg" fill="#635BFF"><path d="M414 113.4c0-25.6-12.4-45.8-36.1-45.8-23.8 0-38.2 20.2-38.2 45.6 0 30.1 17 45.3 41.4 45.3 11.9 0 20.9-2.7 27.7-6.5v-20c-6.8 3.4-14.6 5.5-24.5 5.5-9.7 0-18.3-3.4-19.4-15.2h48.9c0-1.3.2-6.5.2-8.9zm-49.4-9.5c0-11.3 6.9-16 13.2-16 6.1 0 12.6 4.7 12.6 16h-25.8zM301.1 67.6c-9.8 0-16.1 4.6-19.6 7.8l-1.3-6.2h-22v116.6l25-5.3.1-28.3c3.6 2.6 8.9 6.3 17.7 6.3 17.9 0 34.2-14.4 34.2-46.1-.1-29-16.6-44.8-34.1-44.8zm-6 68.9c-5.9 0-9.4-2.1-11.8-4.7l-.1-37.1c2.6-2.9 6.2-4.9 11.9-4.9 9.1 0 15.4 10.2 15.4 23.3 0 13.4-6.2 23.4-15.4 23.4zM223.8 61.7l25.1-5.4V36l-25.1 5.3zM223.8 69.3h25.1v88.3h-25.1zM196.9 76.7l-1.6-7.4h-21.6v88.3h25V97.5c5.9-7.7 15.9-6.3 19-5.2v-23c-3.2-1.2-14.9-3.4-20.8 7.4zM146.9 47.6l-24.4 5.2-.1 80.1c0 14.8 11.1 25.7 25.9 25.7 8.2 0 14.2-1.5 17.5-3.3v-20.3c-3.2 1.3-19 5.9-19-8.9V90.6h19V69.3h-19l.1-21.7zM79.3 95.5c0-3.9 3.2-5.4 8.5-5.4 7.6 0 17.2 2.3 24.8 6.4V72.2c-8.3-3.3-16.5-4.6-24.8-4.6C67.5 67.6 54 78.2 54 95.9c0 27.6 38 23.2 38 35.1 0 4.6-4 6.1-9.6 6.1-8.3 0-18.9-3.4-27.3-8v24.3c9.3 4 18.7 5.7 27.3 5.7 20.8 0 35.1-10.3 35.1-28.2-.1-29.8-38.2-24.5-38.2-35.4z"/></svg>`;
const PADDLE_LOGO_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#1A1A1A"><circle cx="12" cy="12" r="11" fill="none" stroke="#1A1A1A" stroke-width="2"/><path d="M12 6a6 6 0 1 0 6 6h-2a4 4 0 1 1-4-4V6z"/></svg>`;

function renderPayPage({ amount, description, method, url }) {
    const methodLabel = method === 'stripe' ? 'Stripe' : 'Paddle';
    const logoSvg = method === 'stripe' ? STRIPE_LOGO_SVG : PADDLE_LOGO_SVG;
    const safeDesc = String(description).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pago seguro</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 20px 32px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--tg-theme-bg-color, #ffffff);
    color: var(--tg-theme-text-color, #111111);
    display: flex; flex-direction: column; min-height: 100vh;
  }
  .lock { text-align: center; font-size: 48px; margin: 12px 0 4px; }
  h1 { text-align: center; font-size: 20px; margin: 0 0 4px; }
  .sub { text-align: center; font-size: 14px; opacity: .7; margin-bottom: 24px; }
  .card {
    background: var(--tg-theme-secondary-bg-color, #f2f2f7);
    border-radius: 14px; padding: 18px; margin-bottom: 16px;
  }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 15px; }
  .row span:first-child { opacity: .65; }
  .badges { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 8px 0 24px; }
  .badge {
    display: flex; align-items: center; gap: 6px;
    background: var(--tg-theme-secondary-bg-color, #f2f2f7);
    border-radius: 20px; padding: 8px 14px; font-size: 13px;
  }
  .badge svg { height: 14px; width: auto; }
  .logo-row { display: flex; justify-content: center; margin: 4px 0 20px; }
  .logo-row svg { height: 24px; width: auto; }
  .spacer { flex: 1; }
  button {
    width: 100%; padding: 16px; border: none; border-radius: 12px;
    background: var(--tg-theme-button-color, #2ea6ff);
    color: var(--tg-theme-button-text-color, #ffffff);
    font-size: 16px; font-weight: 600; cursor: pointer;
  }
  .foot { text-align: center; font-size: 12px; opacity: .55; margin-top: 14px; }
</style>
</head>
<body>
  <div class="lock">🔒</div>
  <h1>Pago protegido</h1>
  <div class="sub">Procesado por ${methodLabel}, no almacenamos tus datos de tarjeta</div>

  <div class="logo-row">${logoSvg}</div>

  <div class="card">
    <div class="row"><span>Monto</span><b>$${parseFloat(amount).toFixed(2)} USD</b></div>
    <div class="row"><span>Descripción</span><b>${safeDesc}</b></div>
    <div class="row"><span>Procesador</span><b>${methodLabel}</b></div>
  </div>

  <div class="badges">
    <div class="badge">🔐 Cifrado SSL</div>
    <div class="badge">✅ PCI DSS</div>
    <div class="badge">${logoSvg} Verificado</div>
  </div>

  <div class="spacer"></div>
  <button id="go">Continuar al pago seguro</button>
  <div class="foot">Serás redirigido al checkout oficial de ${methodLabel}</div>

<script>
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  document.getElementById('go').addEventListener('click', () => {
    const url = ${JSON.stringify(url)};
    window.location.href = url;
  });
</script>
</body>
</html>`;
}

// ── Paddle API ────────────────────────────────────────────────────────────────
const paddle = axios.create({
    baseURL: 'https://api.paddle.com',
    headers: { Authorization: `Bearer ${PADDLE_API_KEY}`, 'Content-Type': 'application/json' }
});

let _productId = process.env.PADDLE_PRODUCT_ID || null;

async function ensureProduct() {
    if (_productId) return _productId;
    const res = await paddle.post('/products', { name: 'Pedido personalizado', tax_category: 'standard' });
    _productId = res.data.data.id;
    bot.sendMessage(ADMIN_CHAT_ID,
        `⚙️ Producto Paddle creado.\nAgrega a Railway:\n<code>PADDLE_PRODUCT_ID=${_productId}</code>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
    return _productId;
}

async function createPaddleCheckout(amount, description) {
    const productId   = await ensureProduct();
    const amountCents = Math.round(parseFloat(amount) * 100).toString();
    const res = await paddle.post('/transactions', {
        items: [{ price: { description: description || 'Pedido personalizado', product_id: productId, unit_price: { amount: amountCents, currency_code: 'USD' } }, quantity: 1 }]
    });
    return res.data.data;
}

async function createStripeCheckout(amount, description) {
    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
            price_data: {
                currency: 'usd',
                product_data: { name: description || 'Pedido personalizado' },
                unit_amount: Math.round(parseFloat(amount) * 100)
            },
            quantity: 1
        }],
        mode: 'payment',
        success_url: `${PUBLIC_URL}/success`,
        cancel_url:  `${PUBLIC_URL}/cancel`
    });
    return session;
}

// ── Tipo de cambio USD -> MXN ─────────────────────────────────────────────────
const MXN_RATE_FALLBACK = parseFloat(process.env.MXN_RATE_FALLBACK || '18.50');
const MXN_RATE_TTL_MS   = 6 * 60 * 60 * 1000; // 6 horas
let mxnRateCache = { rate: MXN_RATE_FALLBACK, fetchedAt: 0 };

async function getMxnRate() {
    if (Date.now() - mxnRateCache.fetchedAt < MXN_RATE_TTL_MS) return mxnRateCache.rate;
    try {
        const res  = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
        const rate = res.data?.rates?.MXN;
        if (rate) mxnRateCache = { rate, fetchedAt: Date.now() };
    } catch {
        // si falla, seguimos usando la tasa cacheada (o el respaldo fijo) sin bloquear el flujo
    }
    return mxnRateCache.rate;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function sendPaymentLink(chatId, url, amount, description, method, txId) {
    const methodLabel = method === 'stripe' ? '💳 Stripe (tarjeta)' : '🏦 Paddle (PayPal)';
    await bot.sendMessage(chatId,
`💳 <b>Link de pago</b>
━━━━━━━━━━━━━━
${methodLabel}
💰 <b>Monto:</b> $${parseFloat(amount).toFixed(2)} USD
📝 ${description}

🔗 ${url}`,
        { parse_mode: 'HTML', disable_web_page_preview: true }
    );
}

// ── Comandos ──────────────────────────────────────────────────────────────────
bot.onText(/\/addoperador(?:\s+(\d+))?/, (msg, match) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;
    const id = parseInt(match[1]);
    if (!id) return bot.sendMessage(msg.chat.id, '❌ Uso: /addoperador <chatId>');
    operadores.add(id);
    saveOperadores();
    bot.sendMessage(msg.chat.id, `✅ Operador <code>${id}</code> agregado.`, { parse_mode: 'HTML' });
});

bot.onText(/\/removeoperador(?:\s+(\d+))?/, (msg, match) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;
    const id = parseInt(match[1]);
    if (!id) return bot.sendMessage(msg.chat.id, '❌ Uso: /removeoperador <chatId>');
    if (id === ADMIN_CHAT_ID) return bot.sendMessage(msg.chat.id, '❌ No puedes removerte a ti mismo.');
    operadores.delete(id);
    saveOperadores();
    bot.sendMessage(msg.chat.id, `✅ Operador <code>${id}</code> removido.`, { parse_mode: 'HTML' });
});

bot.onText(/\/operadores/, (msg) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;
    const lista = [...operadores].map(id => `• <code>${id}</code>${id === ADMIN_CHAT_ID ? ' (admin)' : ''}`).join('\n');
    bot.sendMessage(msg.chat.id, `👥 <b>Operadores activos:</b>\n${lista}`, { parse_mode: 'HTML' });
});

bot.onText(/\/datosbancarios(?:\s+([\s\S]+))?/, async (msg, match) => {
    if (!isAllowed(msg.chat.id)) return;
    const chatId = msg.chat.id;
    const inline = match[1] ? match[1].trim() : null;

    if (inline) {
        saveMethodDetails('mxn', inline);
        return bot.sendMessage(chatId, `✅ Datos bancarios actualizados.\n\n${formatDetailLines(inline)}`, { parse_mode: 'HTML' });
    }

    const current = loadMethodDetails('mxn');
    const sent = await bot.sendMessage(chatId,
        (current ? `🏦 <b>Datos bancarios actuales:</b>\n\n${formatDetailLines(current)}\n\n` : '🏦 Aún no hay datos bancarios configurados.\n\n') +
        'Envía en un solo mensaje los nuevos datos (CLABE, banco, titular) para actualizarlos.',
        { parse_mode: 'HTML' }
    );
    awaitingMethodUpdate.set(chatId, { key: 'mxn', messageId: sent.message_id });
    setTimeout(() => awaitingMethodUpdate.delete(chatId), 30 * 60 * 1000);
});

bot.onText(/\/addproducto(?:\s+(.+))?/, (msg, match) => {
    if (!isAllowed(msg.chat.id)) return;
    const args  = (match[1] || '').trim().split(/\s+/);
    const price = parseFloat(args[0]);
    const name  = args.slice(1).join(' ');
    if (!price || isNaN(price) || price <= 0 || !name) {
        return bot.sendMessage(msg.chat.id, '❌ Uso: /addproducto <precio> <nombre>\nEjemplo: /addproducto 15 Cuenta Premium 1 mes');
    }
    const id = String(catalog.nextId++);
    catalog.items[id] = { name, price };
    saveCatalog();
    bot.sendMessage(msg.chat.id, `✅ Producto agregado.\n🆔 <code>${id}</code>\n📦 ${name}\n💰 $${price.toFixed(2)} USD`, { parse_mode: 'HTML' });
});

bot.onText(/\/delproducto(?:\s+(\d+))?/, (msg, match) => {
    if (!isAllowed(msg.chat.id)) return;
    const id = match[1];
    if (!id || !catalog.items[id]) return bot.sendMessage(msg.chat.id, '❌ Uso: /delproducto <id>\nUsa /listproductos para ver los IDs.');
    const name = catalog.items[id].name;
    delete catalog.items[id];
    saveCatalog();
    bot.sendMessage(msg.chat.id, `✅ Producto <code>${id}</code> (${name}) eliminado.`, { parse_mode: 'HTML' });
});

bot.onText(/\/listproductos/, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    const ids = Object.keys(catalog.items);
    if (!ids.length) return bot.sendMessage(msg.chat.id, '📦 Catálogo vacío. Usa /addproducto <precio> <nombre>.');
    const lista = ids.map(id => `• <code>${id}</code> — ${catalog.items[id].name} — $${catalog.items[id].price.toFixed(2)}`).join('\n');
    bot.sendMessage(msg.chat.id, `📦 <b>Catálogo</b>\n${lista}`, { parse_mode: 'HTML' });
});

function tiendaPanel() {
    const ids = Object.keys(catalog.items);
    if (!ids.length) return { text: '🛒 No hay productos disponibles por el momento.', keyboard: [] };
    const buttons = ids.map(id => ([{ text: `${catalog.items[id].name} — $${catalog.items[id].price.toFixed(2)}`, callback_data: `buy_${id}` }]));
    return { text: '🛒 <b>JH STORE</b>\nElige un producto:', keyboard: buttons };
}

function sendTienda(chatId) {
    const panel = tiendaPanel();
    bot.sendMessage(chatId, panel.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: panel.keyboard } });
}

function editTienda(chatId, messageId) {
    const panel = tiendaPanel();
    return editOrSend(chatId, messageId, panel.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: panel.keyboard } });
}

bot.onText(/\/tienda/, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    sendTienda(msg.chat.id);
});

// Detecta cuando agregan/quitan al bot como admin de un canal, para el broadcast automático
bot.on('my_chat_member', (update) => {
    const chat = update.chat;
    if (chat.type !== 'channel') return;
    const status  = update.new_chat_member.status;
    const canPost = update.new_chat_member.can_post_messages;
    const key     = String(chat.id);
    const title   = chat.title || chat.username || key;

    if (status === 'administrator' && canPost !== false) {
        if (!knownChannels.has(key)) {
            knownChannels.set(key, { title, username: chat.username || null });
            saveChannels();
            bot.sendMessage(ADMIN_CHAT_ID, `📡 El bot ahora es admin en "${title}" — se agregó a la lista de difusión de "📢 Promocionar".`).catch(() => {});
        }
    } else if (knownChannels.has(key)) {
        knownChannels.delete(key);
        saveChannels();
        bot.sendMessage(ADMIN_CHAT_ID, `📡 El bot ya no es admin en "${title}" — se quitó de la lista de difusión.`).catch(() => {});
    }
});

function channelTargets() {
    if (knownChannels.size) return [...knownChannels.entries()];
    const fallbackUsername = CHANNEL_ID.startsWith('@') ? CHANNEL_ID.slice(1) : null;
    return [[CHANNEL_ID, { title: CHANNEL_ID, username: fallbackUsername }]]; // respaldo: canal fijo original
}

// Link para ver la publicación: usa el @usuario si es público, o el formato interno t.me/c/... si es privado
function channelViewUrl(chId, info, messageId) {
    if (info.username) return `https://t.me/${info.username}/${messageId}`;
    const idStr = String(chId);
    if (idStr.startsWith('-100')) return `https://t.me/c/${idStr.slice(4)}/${messageId}`;
    return null;
}

async function postToChannel(fromChatId, text, editTarget) {
    const finalText = text.trim() || '🛒 Descubre nuestros productos y paga 100% seguro. Toca el botón para ir a la tienda.';
    const menuButton = { text: '⬅️ Menú', callback_data: 'panel_home' };
    const username = await getBotUsername().catch(() => null);
    const targets = channelTargets();

    const results = [];
    for (const [chId, info] of targets) {
        try {
            const sent = await bot.sendMessage(chId, finalText, {
                reply_markup: { inline_keyboard: [[{ text: '🛒 Ir a la tienda', url: `https://t.me/${username}?start=tienda` }]] }
            });
            results.push({ chId, info, messageId: sent.message_id, ok: true });
        } catch (err) {
            results.push({ chId, info, error: err.message, ok: false });
        }
    }

    const okResults   = results.filter(r => r.ok);
    const failResults = results.filter(r => !r.ok);

    let confirmText = okResults.length
        ? `✅ Publicado en ${okResults.length} canal${okResults.length > 1 ? 'es' : ''}:\n` + okResults.map(r => `• ${r.info.title}`).join('\n')
        : '❌ No se pudo publicar en ningún canal.';
    if (failResults.length) confirmText += `\n\n⚠️ Falló en: ${failResults.map(r => r.info.title).join(', ')}`;

    const confirmKeyboard = okResults.map(r => {
        const row = [];
        const viewUrl = channelViewUrl(r.chId, r.info, r.messageId);
        if (viewUrl) row.push({ text: `👀 Ver en ${r.info.title}`, url: viewUrl });
        row.push({ text: `🗑️ Borrar en ${r.info.title}`, callback_data: `del_canal_${r.chId}:${r.messageId}` });
        return row;
    });
    confirmKeyboard.push([menuButton]);

    if (editTarget) {
        await replacePanel(editTarget.chatId, editTarget.messageId, confirmText, { reply_markup: { inline_keyboard: confirmKeyboard } });
    } else {
        bot.sendMessage(fromChatId, confirmText, { reply_markup: { inline_keyboard: confirmKeyboard } });
    }
}

bot.onText(/\/promocanal(?:\s+([\s\S]+))?/, (msg, match) => {
    if (!isAllowed(msg.chat.id)) return;
    postToChannel(msg.chat.id, match[1] || '');
});

bot.onText(/\/canales/, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    if (!knownChannels.size) {
        return bot.sendMessage(msg.chat.id, `📡 No hay canales detectados automáticamente todavía.\nAgrega el bot como admin (con permiso de publicar) a un canal y aparecerá aquí solo.\n\nRespaldo actual: ${CHANNEL_ID}`);
    }
    const lista = [...knownChannels.values()].map(c => `• ${c.title}`).join('\n');
    bot.sendMessage(msg.chat.id, `📡 <b>Canales conectados</b>\n${lista}`, { parse_mode: 'HTML' });
});

bot.onText(/\/borrarcanal(?:\s+(\S+))?(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAllowed(msg.chat.id)) return;
    let target = match[1];
    let messageId = match[2];
    if (target && !messageId && /^\d+$/.test(target)) {
        // uso viejo: /borrarcanal <id_del_mensaje> (usa el canal de respaldo)
        messageId = target;
        target = CHANNEL_ID;
    }
    if (!target || !messageId) {
        return bot.sendMessage(msg.chat.id, '❌ Uso: /borrarcanal [@canal o chatId] <id_del_mensaje>\nSin especificar canal, usa /canales para ver los conectados y el botón "🗑️ Borrar en..." de cada publicación.');
    }
    try {
        await bot.deleteMessage(target, messageId);
        bot.sendMessage(msg.chat.id, `🗑️ Publicación <code>${messageId}</code> borrada de ${target}.`, { parse_mode: 'HTML' });
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ No se pudo borrar: ${err.message}`);
    }
});

function ventasPanel() {
    if (!sales.length) return { text: '📊 Aún no hay ventas registradas.', keyboard: [] };
    const total = sales.reduce((sum, s) => sum + s.amount, 0);
    const text =
`📊 <b>Ventas</b>
━━━━━━━━━━━━━━
🧾 Vendidas: <b>${sales.length}</b>
💰 Total generado: <b>$${total.toFixed(2)} USD</b>`;
    return { text, keyboard: [
        [{ text: '🧾 Ver / borrar una venta', callback_data: 'panel_ventas_lista' }],
        [{ text: '🗑️ Reiniciar contador', callback_data: 'reset_ventas_ask' }]
    ] };
}

function ventasListaPanel() {
    if (!sales.length) return { text: '📊 No hay ventas registradas.', keyboard: [] };
    const recent = sales.map((s, idx) => ({ ...s, idx })).slice(-10).reverse();
    const keyboard = recent.map(s => {
        const desc = String(s.description).slice(0, 20);
        return [{ text: `🗑️ ${s.date.slice(0, 10)} — $${s.amount.toFixed(2)} — ${desc}`, callback_data: `del_venta_${s.idx}` }];
    });
    return { text: '📊 <b>Últimas ventas</b>\n━━━━━━━━━━━━━━\nToca una para borrarla (uso: testing/corrección):', keyboard };
}

function sendVentas(chatId) {
    const panel = ventasPanel();
    bot.sendMessage(chatId, panel.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: panel.keyboard } });
}

// ── Panel de operador ─────────────────────────────────────────────────────────
function catalogoAdminPanel() {
    const ids = Object.keys(catalog.items);
    const lista = ids.length
        ? ids.map(id => `• <code>${id}</code> — ${catalog.items[id].name} — $${catalog.items[id].price.toFixed(2)}`).join('\n')
        : 'Catálogo vacío.';
    const text =
`🛒 <b>Catálogo</b>
━━━━━━━━━━━━━━
${lista}

<b>Comandos:</b>
/addproducto <code>&lt;precio&gt; &lt;nombre&gt;</code>
/delproducto <code>&lt;id&gt;</code>
/tienda — vista del cliente`;
    return { text, keyboard: [] };
}

function cobrarPanel() {
    const text =
`💰 <b>Cobrar</b>
━━━━━━━━━━━━━━
/cobrar <code>&lt;monto&gt; [descripción] [chatId]</code>

<b>Ejemplos:</b>
<code>/cobrar 50</code>
<code>/cobrar 50 10 cuentas premium</code>
<code>/cobrar 50 10 cuentas 123456789</code>`;
    return { text, keyboard: [] };
}

function metodosPanel() {
    const rows = Object.entries(PAYMENT_METHODS).map(([key, cfg]) => [{ text: cfg.label, callback_data: `panel_metodo_${key}` }]);
    return { text: '💳 <b>Métodos de pago manuales</b>\n━━━━━━━━━━━━━━\nElige uno para ver o actualizar sus datos:', keyboard: rows };
}

function metodoDetallePanel(key) {
    const cfg = PAYMENT_METHODS[key];
    const current = loadMethodDetails(key);
    const text = current
        ? `${cfg.label}\n━━━━━━━━━━━━━━\n${formatDetailLines(current)}`
        : `${cfg.label}\n━━━━━━━━━━━━━━\n⚠️ Aún no configurado.`;
    return { text, keyboard: [[{ text: '✏️ Actualizar', callback_data: `panel_metodo_edit_${key}` }]] };
}

function operadoresPanel() {
    const lista = [...operadores].map(id => `• <code>${id}</code>${id === ADMIN_CHAT_ID ? ' (admin)' : ''}`).join('\n');
    const text =
`👥 <b>Operadores</b>
━━━━━━━━━━━━━━
${lista}

<b>Comandos:</b>
/addoperador <code>&lt;chatId&gt;</code>
/removeoperador <code>&lt;chatId&gt;</code>`;
    return { text, keyboard: [] };
}

function comandosPanel(isAdmin) {
    const text =
`📖 <b>Todos los comandos</b>
━━━━━━━━━━━━━━
${stripe ? '✅' : '❌'} Stripe (tarjeta)

<b>Cobros:</b>
/cobrar <code>&lt;monto&gt; [descripción] [chatId]</code>

<b>Métodos de pago manuales:</b>
/datosbancarios <code>[CLABE / banco / titular]</code>
(Binance ID y AirTM se configuran desde el botón "💳 Métodos de pago" del menú)

<b>Catálogo (tienda pública /tienda):</b>
/addproducto <code>&lt;precio&gt; &lt;nombre&gt;</code>
/listproductos
/delproducto <code>&lt;id&gt;</code>

<b>Promoción:</b>
/promocanal <code>[texto]</code> — publica en todos los canales conectados
/canales — ver canales donde el bot es admin (se detectan solos)
/borrarcanal <code>[@canal] &lt;id_del_mensaje&gt;</code> — borra una publicación vieja

<b>Ventas:</b>
/ventas
${isAdmin ? `
<b>Operadores:</b>
/addoperador <code>&lt;chatId&gt;</code>
/removeoperador <code>&lt;chatId&gt;</code>
/operadores` : ''}`;
    return { text, keyboard: [] };
}

function operatorHomePanel(isAdmin) {
    const text =
`💳 <b>Pay Bot</b> — Panel de operador
━━━━━━━━━━━━━━
${stripe ? '✅' : '❌'} Stripe (tarjeta)

Elige una opción:`;
    const keyboard = [
        [{ text: '🛒 Catálogo', callback_data: 'panel_catalogo' }, { text: '📊 Ventas', callback_data: 'panel_ventas' }],
        [{ text: '💰 Cobrar', callback_data: 'panel_cobrar' }, { text: '💳 Métodos de pago', callback_data: 'panel_metodos' }],
        [{ text: '📢 Promocionar', callback_data: 'panel_promocionar' }]
    ];
    if (isAdmin) keyboard.push([{ text: '👥 Operadores', callback_data: 'panel_operadores' }]);
    keyboard.push([{ text: '📖 Todos los comandos', callback_data: 'panel_comandos' }]);
    return { text, keyboard };
}

function withBack(keyboard) {
    return [...keyboard, [{ text: '⬅️ Menú', callback_data: 'panel_home' }]];
}

function editPanel(chatId, messageId, panel) {
    const keyboard = withBack(panel.keyboard);
    return editOrSend(chatId, messageId, panel.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

bot.onText(/\/ventas/, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    sendVentas(msg.chat.id);
});

bot.onText(/\/start(?:\s+(\S+))?/, (msg, match) => {
    const chatId  = msg.chat.id;
    const payload = match[1];

    if (!isAllowed(chatId)) {
        if (!knownCustomers.has(chatId)) {
            knownCustomers.add(chatId);
            saveCustomers();
            const who = msg.from?.username ? '@' + msg.from.username : (msg.from?.first_name || 'Sin nombre');
            bot.sendMessage(ADMIN_CHAT_ID, `🆕 <b>Nuevo cliente inició el bot</b>\n👤 ${who} (<code>${chatId}</code>)`, { parse_mode: 'HTML' }).catch(() => {});
        }

        if (payload === 'tienda') return sendTienda(chatId);
        return bot.sendMessage(chatId,
`👋 <b>¡Bienvenido a JH STORE!</b>
━━━━━━━━━━━━━━
Productos y servicios digitales, con pago 100% seguro (Stripe / PayPal).

Toca el botón de abajo para ver el catálogo.`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🛒 Ver catálogo', callback_data: 'open_tienda' }]] } }
        );
    }

    const isAdmin = msg.chat.id === ADMIN_CHAT_ID;
    const panel = operatorHomePanel(isAdmin);
    bot.sendMessage(msg.chat.id, panel.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: panel.keyboard } });
});

bot.onText(/\/cobrar(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAllowed(chatId)) return;

    const args = (match[1] || '').trim().split(/\s+/);
    const amount = args[0];

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return bot.sendMessage(chatId, '❌ Uso: /cobrar <monto> [descripción] [chatId]\nEjemplo: /cobrar 50 10 cuentas');
    }

    let targetChatId = null;
    let descParts = args.slice(1);
    const last = descParts[descParts.length - 1];
    if (last && /^\d{5,}$/.test(last)) {
        targetChatId = parseInt(last);
        descParts = descParts.slice(0, -1);
    }
    const description = descParts.join(' ') || 'Pedido personalizado';
    const pendingId   = savePending(amount, description, targetChatId, chatId);
    const panel       = metodoPagoPanel(pendingId, amount, description, false);

    await bot.sendMessage(chatId, panel.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: panel.keyboard } });
});

// ── Callbacks ─────────────────────────────────────────────────────────────────
bot.on('callback_query', async (cq) => {
    const data   = cq.data;
    const chatId = cq.message.chat.id;

    if (data === 'open_tienda') {
        bot.answerCallbackQuery(cq.id);
        return editTienda(chatId, cq.message.message_id);
    }

    if (data === 'back_tienda') {
        bot.answerCallbackQuery(cq.id);
        return editTienda(chatId, cq.message.message_id);
    }

    if (data === 'panel_home') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        const panel = operatorHomePanel(chatId === ADMIN_CHAT_ID);
        return editOrSend(chatId, cq.message.message_id, panel.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: panel.keyboard } });
    }

    if (data === 'panel_catalogo') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        return editPanel(chatId, cq.message.message_id, catalogoAdminPanel());
    }

    if (data === 'panel_ventas') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        return editPanel(chatId, cq.message.message_id, ventasPanel());
    }

    if (data === 'panel_ventas_lista') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        return editPanel(chatId, cq.message.message_id, ventasListaPanel());
    }

    if (data.startsWith('del_venta_')) {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        const idx = parseInt(data.replace('del_venta_', ''), 10);
        if (isNaN(idx) || idx < 0 || idx >= sales.length) {
            bot.answerCallbackQuery(cq.id, { text: '❌ Ya no existe.' });
            return editPanel(chatId, cq.message.message_id, ventasListaPanel());
        }
        sales.splice(idx, 1);
        fs.writeFileSync(SALES_FILE, JSON.stringify(sales, null, 2));
        bot.answerCallbackQuery(cq.id, { text: '🗑️ Venta borrada.' });
        return editPanel(chatId, cq.message.message_id, ventasListaPanel());
    }

    if (data === 'panel_cobrar') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        return editPanel(chatId, cq.message.message_id, cobrarPanel());
    }

    if (data === 'panel_metodos') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        return editPanel(chatId, cq.message.message_id, metodosPanel());
    }

    if (data.startsWith('panel_metodo_edit_')) {
        const key = data.replace('panel_metodo_edit_', '');
        if (!isAllowed(chatId) || !PAYMENT_METHODS[key]) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        const cfg = PAYMENT_METHODS[key];
        const result = await editOrSend(chatId, cq.message.message_id, `✏️ Envía en un solo mensaje los nuevos datos para ${cfg.label}.`,
            { reply_markup: { inline_keyboard: [[{ text: '⬅️ Menú', callback_data: 'panel_home' }]] } }
        );
        awaitingMethodUpdate.set(chatId, { key, messageId: result?.message_id || cq.message.message_id });
        setTimeout(() => awaitingMethodUpdate.delete(chatId), 30 * 60 * 1000);
        return;
    }

    if (data.startsWith('panel_metodo_')) {
        const key = data.replace('panel_metodo_', '');
        if (!isAllowed(chatId) || !PAYMENT_METHODS[key]) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        return editPanel(chatId, cq.message.message_id, metodoDetallePanel(key));
    }

    if (data === 'panel_promocionar') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        const chCount = knownChannels.size || 1;
        const result = await editOrSend(chatId, cq.message.message_id, `📢 Envía el texto que quieres publicar (se manda a ${chCount} canal${chCount > 1 ? 'es' : ''}).`,
            { reply_markup: { inline_keyboard: [[{ text: '⬅️ Menú', callback_data: 'panel_home' }]] } }
        );
        awaitingCanalPost.set(chatId, result?.message_id || cq.message.message_id);
        setTimeout(() => awaitingCanalPost.delete(chatId), 30 * 60 * 1000);
        return;
    }

    if (data.startsWith('del_canal_')) {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        const [canalChatId, canalMessageId] = data.replace('del_canal_', '').split(':');
        try {
            await bot.deleteMessage(canalChatId, canalMessageId);
            bot.answerCallbackQuery(cq.id, { text: '🗑️ Publicación borrada.' });
            await editOrSend(chatId, cq.message.message_id, `🗑️ Publicación borrada de ${knownChannels.get(canalChatId)?.title || canalChatId}.`,
                { reply_markup: { inline_keyboard: [[{ text: '⬅️ Menú', callback_data: 'panel_home' }]] } }
            );
        } catch (err) {
            bot.answerCallbackQuery(cq.id, { text: '❌ No se pudo borrar.' });
            await editOrSend(chatId, cq.message.message_id, `❌ No se pudo borrar la publicación: ${err.message}`,
                { reply_markup: { inline_keyboard: [[{ text: '⬅️ Menú', callback_data: 'panel_home' }]] } }
            );
        }
        return;
    }

    if (data === 'panel_operadores') {
        if (chatId !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        return editPanel(chatId, cq.message.message_id, operadoresPanel());
    }

    if (data === 'panel_comandos') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        return editPanel(chatId, cq.message.message_id, comandosPanel(chatId === ADMIN_CHAT_ID));
    }

    if (data === 'reset_ventas_ask') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        bot.answerCallbackQuery(cq.id);
        return bot.sendMessage(chatId, '⚠️ ¿Seguro que quieres reiniciar el contador de ventas a 0? Esto no se puede deshacer.', {
            reply_markup: { inline_keyboard: [[
                { text: '✅ Sí, reiniciar', callback_data: 'reset_ventas_confirm' },
                { text: '❌ Cancelar', callback_data: 'reset_ventas_cancel' }
            ]] }
        });
    }

    if (data === 'reset_ventas_confirm') {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        sales.length = 0;
        fs.writeFileSync(SALES_FILE, JSON.stringify(sales, null, 2));
        bot.answerCallbackQuery(cq.id, { text: '✅ Contador reiniciado.' });
        return editOrSend(chatId, cq.message.message_id, '✅ Contador de ventas reiniciado a 0.',
            { reply_markup: { inline_keyboard: [[{ text: '⬅️ Menú', callback_data: 'panel_home' }]] } }
        );
    }

    if (data === 'reset_ventas_cancel') {
        bot.answerCallbackQuery(cq.id, { text: 'Cancelado.' });
        return editOrSend(chatId, cq.message.message_id, '❌ Reinicio cancelado, el contador sigue igual.',
            { reply_markup: { inline_keyboard: [[{ text: '⬅️ Menú', callback_data: 'panel_home' }]] } }
        );
    }

    if (data.startsWith('buy_')) {
        const productId = data.replace('buy_', '');
        const product    = catalog.items[productId];
        if (!product) return bot.answerCallbackQuery(cq.id, { text: '❌ Producto no disponible.' });

        bot.answerCallbackQuery(cq.id);
        const pendingId = savePending(product.price, product.name, null, chatId);
        const panel     = metodoPagoPanel(pendingId, product.price, product.name, true);

        return editOrSend(chatId, cq.message.message_id, panel.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: panel.keyboard } });
    }

    if (data.startsWith('pay_m_')) {
        const match = data.match(/^pay_m_(mxn|binance|airtm|remitly)_(.+)$/);
        if (!match) return bot.answerCallbackQuery(cq.id);
        const [, methodKey, pendingId] = match;
        const methodCfg = PAYMENT_METHODS[methodKey];
        const pending   = pendingPayments.get(pendingId);

        if (!pending) {
            bot.answerCallbackQuery(cq.id, { text: '❌ Solicitud expirada.' });
            return editOrSend(chatId, cq.message.message_id, '❌ Solicitud expirada.', {});
        }

        const { amount, description, targetChatId, operatorChatId } = pending;
        const replyChatId    = operatorChatId || ADMIN_CHAT_ID;
        const fromOperator    = isAllowed(replyChatId);
        const customerChatId  = fromOperator ? targetChatId : replyChatId;
        const askChatId       = fromOperator ? replyChatId : ADMIN_CHAT_ID;

        const methodText = loadMethodDetails(methodKey);
        if (!methodText) {
            bot.answerCallbackQuery(cq.id, { text: '❌ Método no configurado.' });
            await bot.sendMessage(askChatId, `⚠️ Un cliente quiere pagar por ${methodCfg.title} pero no hay datos configurados. Ve a "💳 Métodos de pago" en el menú para configurarlos.`).catch(() => {});
            return;
        }

        bot.answerCallbackQuery(cq.id);

        const transferId = crypto.randomBytes(4).toString('hex');
        pendingTransfers.set(transferId, { customerChatId, amount, description, operatorChatId: askChatId, method: methodKey });
        setTimeout(() => { pendingTransfers.delete(transferId); persistTransfersState(); }, 24 * 60 * 60 * 1000);
        if (customerChatId) {
            transferByCustomer.set(customerChatId, { transferId, operatorChatId: askChatId });
            setTimeout(() => { transferByCustomer.delete(customerChatId); persistTransfersState(); }, 24 * 60 * 60 * 1000);
        }
        persistTransfersState();

        let amountLine = `💰 $${parseFloat(amount).toFixed(2)} USD — ${description}`;
        if (methodCfg.mxn) {
            const mxnRate   = await getMxnRate();
            const mxnAmount = (parseFloat(amount) * mxnRate).toFixed(2);
            amountLine = `💰 $${parseFloat(amount).toFixed(2)} USD ≈ <b>$${mxnAmount} MXN</b> — ${description}`;
        }
        const payMsg =
`${methodCfg.label} <b>Datos para tu pago</b>
━━━━━━━━━━━━━━
${amountLine}

${formatDetailLines(methodText)}

Envía la foto de tu comprobante aquí una vez hecho el pago.`;

        if (!customerChatId || chatId === customerChatId) {
            // no hay un chat de cliente distinto vinculado (o el que clickeó es el cliente): mostrar los datos aquí mismo
            await editOrSend(chatId, cq.message.message_id, payMsg, { parse_mode: 'HTML' });
        } else {
            await editOrSend(chatId, cq.message.message_id, '✅ Datos enviados al cliente. Te aviso cuando mande el comprobante.', {});
            await bot.sendMessage(customerChatId, payMsg, { parse_mode: 'HTML' }).catch(() => {});
        }

        notifyAllOperators(
            `${methodCfg.label} solicitado — $${parseFloat(amount).toFixed(2)} USD — ${description}.\nDatos enviados al cliente, esperando comprobante.`,
            {},
            [chatId, customerChatId].filter(Boolean)
        );
        return;
    }

    if (data.startsWith('confirm_transfer_')) {
        if (!isAllowed(chatId)) return bot.answerCallbackQuery(cq.id);
        const transferId = data.replace('confirm_transfer_', '');
        const transfer   = pendingTransfers.get(transferId);
        if (!transfer) return bot.answerCallbackQuery(cq.id, { text: '❌ Ya no disponible.' });

        pendingTransfers.delete(transferId);
        if (transfer.customerChatId) transferByCustomer.delete(transfer.customerChatId);
        persistTransfersState();
        const methodLabel = PAYMENT_METHODS[transfer.method]?.label || '🏧 Transferencia MXN';
        recordSale({ date: new Date().toISOString(), method: transfer.method || 'transferencia', amount: parseFloat(transfer.amount), currency: 'USD', description: transfer.description, txId: transferId });

        bot.answerCallbackQuery(cq.id, { text: '✅ Venta confirmada.' });
        await editOrSend(chatId, cq.message.message_id,
            `✅ <b>Pago confirmado</b>\n💰 $${parseFloat(transfer.amount).toFixed(2)} USD — ${transfer.description}`,
            { parse_mode: 'HTML' }
        );
        notifyAllOperators(
            `✅ ${methodLabel} confirmada por otro operador — $${parseFloat(transfer.amount).toFixed(2)} USD — ${transfer.description}`,
            {},
            [chatId]
        );

        if (transfer.customerChatId) {
            awaitingDelivery.set(chatId, { customerChatId: transfer.customerChatId, description: transfer.description });
            persistTransfersState();
            setTimeout(() => { awaitingDelivery.delete(chatId); persistTransfersState(); }, 30 * 60 * 1000);
            await bot.sendMessage(chatId, '✏️ Escribe la cuenta a entregar (formato correo:contraseña).');
        } else {
            await bot.sendMessage(chatId, 'ℹ️ No hay un chat de cliente vinculado — entrégale la cuenta manualmente.');
        }
        return;
    }

    if (data.startsWith('pay_back_')) {
        const pendingId = data.replace('pay_back_', '');
        const pending   = pendingPayments.get(pendingId);

        if (!pending) {
            bot.answerCallbackQuery(cq.id, { text: '❌ Solicitud expirada.' });
            return editOrSend(chatId, cq.message.message_id, '❌ Solicitud expirada.', {});
        }

        bot.answerCallbackQuery(cq.id);
        const { amount, description, operatorChatId } = pending;
        const replyChatId       = operatorChatId || ADMIN_CHAT_ID;
        const showCatalogoBack  = !isAllowed(replyChatId);
        const panel = metodoPagoPanel(pendingId, amount, description, showCatalogoBack);

        return editOrSend(chatId, cq.message.message_id, panel.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: panel.keyboard } });
    }

    if (data.startsWith('pay_s_') || data.startsWith('pay_p_')) {
        const method    = data.startsWith('pay_s_') ? 'stripe' : 'paddle';
        const pendingId = data.replace(/^pay_[sp]_/, '');
        const pending   = pendingPayments.get(pendingId);

        if (!pending) {
            bot.answerCallbackQuery(cq.id, { text: '❌ Solicitud expirada. Usa /cobrar de nuevo.' });
            return editOrSend(chatId, cq.message.message_id, '❌ Solicitud expirada. Usa /cobrar de nuevo.', {});
        }

        bot.answerCallbackQuery(cq.id, { text: '⏳ Generando link...' });

        const { amount, description, targetChatId, operatorChatId } = pending;
        const replyChatId    = operatorChatId || ADMIN_CHAT_ID;
        const fromOperator    = isAllowed(replyChatId);
        const customerChatId  = fromOperator ? targetChatId : replyChatId;
        const askChatId       = fromOperator ? replyChatId : ADMIN_CHAT_ID;

        try {
            let url, txId;
            if (method === 'stripe') {
                const session = await createStripeCheckout(amount, description);
                url  = session.url;
                txId = session.id;
            } else {
                const tx = await createPaddleCheckout(amount, description);
                url  = tx.checkout?.url || `https://pay.paddle.com/checkout/${tx.id}`;
                txId = tx.id;
            }

            saveCheckoutMeta(txId, { description, customerChatId, askChatId });
            const linkId      = saveLink({ amount, description, method, url });
            const payPageUrl  = `${APP_BASE_URL}/pay/${linkId}`;
            const secureButton = { inline_keyboard: [
                [{ text: 'Pagar', web_app: { url: payPageUrl } }],
                [{ text: '⬅️ Volver', callback_data: `pay_back_${pendingId}` }]
            ] };
            const panelText = `💰 <b>$${parseFloat(amount).toFixed(2)} USD</b> — ${description}`;

            await editOrSend(replyChatId, cq.message.message_id, panelText, { parse_mode: 'HTML', reply_markup: secureButton });

            // La notificación al admin se manda desde el webhook, una vez que el pago se confirma de verdad (ver más abajo).

            if (targetChatId && targetChatId !== replyChatId) {
                await bot.sendMessage(targetChatId,
                    `💰 <b>$${parseFloat(amount).toFixed(2)} USD</b> — ${description}`,
                    { parse_mode: 'HTML', reply_markup: secureButton }
                ).catch(() => bot.sendMessage(replyChatId, `⚠️ No se pudo enviar al cliente (${targetChatId}). Reenvía tú el link.`));
            }
        } catch (err) {
            const detail = err.response?.data?.error?.detail || err.message;
            await editOrSend(replyChatId, cq.message.message_id, `❌ Error: ${detail}`, {});
        }
    }
});

// ── Captura de datos bancarios (transferencia MXN) ────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    // Responder (reply) al comprobante con la cuenta = confirmar + entregar en un solo paso
    if (msg.reply_to_message) {
        const transferId = transferMessages.get(`${chatId}:${msg.reply_to_message.message_id}`);
        if (transferId) {
            const transfer = pendingTransfers.get(transferId);
            if (!transfer) {
                bot.sendMessage(chatId, '❌ Esta transferencia ya no está pendiente (expiró o ya se confirmó).');
                return;
            }
            pendingTransfers.delete(transferId);
            if (transfer.customerChatId) transferByCustomer.delete(transfer.customerChatId);
            persistTransfersState();
            const methodLabel = PAYMENT_METHODS[transfer.method]?.label || '🏧 Transferencia MXN';
            recordSale({ date: new Date().toISOString(), method: transfer.method || 'transferencia', amount: parseFloat(transfer.amount), currency: 'USD', description: transfer.description, txId: transferId });
            notifyAllOperators(
                `✅ ${methodLabel} confirmada y entregada por otro operador — $${parseFloat(transfer.amount).toFixed(2)} USD — ${transfer.description}`,
                {},
                [chatId]
            );

            if (transfer.customerChatId) {
                const formatted = msg.text ? formatDelivery(msg.text, transfer.description) : null;
                const sendToCustomer = formatted
                    ? bot.sendMessage(transfer.customerChatId, formatted, { parse_mode: 'HTML' })
                    : bot.copyMessage(transfer.customerChatId, chatId, msg.message_id)
                        .then(() => bot.sendMessage(transfer.customerChatId, '🎉 ¡Gracias por tu compra!'));

                sendToCustomer
                    .then(() => bot.sendMessage(chatId, '✅ Confirmado y entregado al cliente.'))
                    .catch(() => bot.sendMessage(chatId, '⚠️ Pago confirmado, pero no se pudo entregar al cliente automáticamente.'));
            } else {
                bot.sendMessage(chatId, '✅ Pago confirmado (no hay chat de cliente vinculado para entregar automáticamente).');
            }
            return;
        }
    }

    // Entrega de la cuenta/producto tras confirmar el pago -> mandar al cliente
    const delivery = awaitingDelivery.get(chatId);
    if (delivery && !(msg.text && msg.text.startsWith('/'))) {
        awaitingDelivery.delete(chatId);
        // Limpia el aviso en los demás operadores para que no intenten entregar la misma cuenta dos veces
        for (const opId of operadores) {
            if (opId === chatId) continue;
            const other = awaitingDelivery.get(opId);
            if (other && other.customerChatId === delivery.customerChatId) {
                awaitingDelivery.delete(opId);
                bot.sendMessage(opId, 'ℹ️ Esta cuenta ya fue entregada por otro operador.').catch(() => {});
            }
        }
        persistTransfersState();
        const formatted = msg.text ? formatDelivery(msg.text, delivery.description) : null;
        const sendToCustomer = formatted
            ? bot.sendMessage(delivery.customerChatId, formatted, { parse_mode: 'HTML' })
            : bot.copyMessage(delivery.customerChatId, chatId, msg.message_id)
                .then(() => bot.sendMessage(delivery.customerChatId, '🎉 ¡Gracias por tu compra!'));

        sendToCustomer
            .then(() => bot.sendMessage(chatId, '✅ Entregado al cliente.'))
            .catch(() => bot.sendMessage(chatId, '⚠️ No se pudo entregar al cliente, envíaselo tú manualmente.'));
        return;
    }

    // Comprobante (foto/documento/texto) del cliente -> reenviar a TODOS los operadores para que cualquiera confirme y entregue
    const awaitingProof = transferByCustomer.get(chatId);
    if (awaitingProof && !(msg.text && msg.text.startsWith('/'))) {
        for (const opId of operadores) {
            bot.copyMessage(opId, chatId, msg.message_id)
                .then((sent) => {
                    transferMessages.set(`${opId}:${sent.message_id}`, awaitingProof.transferId);
                    persistTransfersState();
                    setTimeout(() => { transferMessages.delete(`${opId}:${sent.message_id}`); persistTransfersState(); }, 24 * 60 * 60 * 1000);
                    return bot.sendMessage(opId,
                        '📎 Comprobante recibido del cliente (arriba 👆). Responde a este mensaje con la cuenta para confirmar y entregársela junto con el agradecimiento, o usa el botón para solo confirmar.', {
                            reply_markup: { inline_keyboard: [[{ text: '✅ Confirmar pago recibido', callback_data: `confirm_transfer_${awaitingProof.transferId}` }]] }
                        });
                })
                .then((sent2) => {
                    if (sent2) {
                        transferMessages.set(`${opId}:${sent2.message_id}`, awaitingProof.transferId);
                        persistTransfersState();
                        setTimeout(() => { transferMessages.delete(`${opId}:${sent2.message_id}`); persistTransfersState(); }, 24 * 60 * 60 * 1000);
                    }
                })
                .catch(() => {});
        }
        return;
    }

    if (!msg.text || msg.text.startsWith('/')) return;

    // Texto para publicar en el canal (tras el botón "📢 Promocionar")
    if (awaitingCanalPost.has(chatId)) {
        const messageId = awaitingCanalPost.get(chatId);
        awaitingCanalPost.delete(chatId);
        await postToChannel(chatId, msg.text, { chatId, messageId });
        return;
    }

    // Texto para actualizar un método de pago (tras /datosbancarios o el botón "✏️ Actualizar")
    if (awaitingMethodUpdate.has(chatId)) {
        const { key, messageId } = awaitingMethodUpdate.get(chatId);
        awaitingMethodUpdate.delete(chatId);
        saveMethodDetails(key, msg.text);
        await replacePanel(chatId, messageId, `✅ ${PAYMENT_METHODS[key].label} actualizado.\n\n${formatDetailLines(msg.text)}`, { parse_mode: 'HTML' });
        return;
    }
});

// ── Webhook Paddle ────────────────────────────────────────────────────────────
app.use('/webhook/paddle', express.raw({ type: 'application/json' }));
app.post('/webhook/paddle', (req, res) => {
    console.log('[webhook/paddle] recibido');
    if (PADDLE_WEBHOOK_SECRET) {
        const sig = req.headers['paddle-signature'] || '';
        const [tsPart, h1Part] = sig.split(';');
        const ts = tsPart?.replace('ts=', '');
        const h1 = h1Part?.replace('h1=', '');
        const expected = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(`${ts}:${req.body}`).digest('hex');
        if (expected !== h1) {
            console.log('[webhook/paddle] firma invalida');
            return res.status(401).send('Invalid signature');
        }
    }
    let event;
    try { event = JSON.parse(req.body); } catch { return res.status(400).send('Bad JSON'); }
    console.log(`[webhook/paddle] event_type=${event.event_type}`);

    if (event.event_type === 'transaction.completed') {
        const tx          = event.data;
        const total       = tx.details?.totals?.total;
        const amount      = total ? parseInt(total) / 100 : null;
        const currency    = tx.currency_code || 'USD';
        const description = tx.items?.[0]?.price?.description || 'Pedido';
        notifyPaymentReceived(
`💰 <b>¡Pago recibido! (Paddle)</b>
━━━━━━━━━━━━━━
✅ <b>Monto:</b> $${amount ? amount.toFixed(2) : '?'} ${currency}
📝 ${description}
👤 ${tx.customer?.email || 'N/A'}
🔖 <code>${tx.id}</code>`,
`💰 <b>¡Pago recibido! (Paddle)</b>
━━━━━━━━━━━━━━
✅ <b>Monto:</b> $${amount ? amount.toFixed(2) : '?'} ${currency}
📝 ${description}
🔖 <code>${tx.id}</code>`
        );
        if (amount) recordSale({ date: new Date().toISOString(), method: 'paddle', amount, currency, description, txId: tx.id });
        triggerDelivery(tx.id, description);
    }
    res.status(200).send('OK');
});

// ── Webhook Stripe ────────────────────────────────────────────────────────────
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.post('/webhook/stripe', (req, res) => {
    console.log('[webhook/stripe] recibido');
    if (!stripe) return res.status(400).send('Stripe not configured');
    let event;
    if (STRIPE_WEBHOOK_SECRET) {
        try {
            event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            console.log(`[webhook/stripe] firma invalida: ${err.message}`);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }
    } else {
        try { event = JSON.parse(req.body); } catch { return res.status(400).send('Bad JSON'); }
    }
    console.log(`[webhook/stripe] type=${event.type}`);

    if (event.type === 'checkout.session.completed') {
        const session     = event.data.object;
        const amount      = session.amount_total ? session.amount_total / 100 : null;
        const currency    = (session.currency || 'usd').toUpperCase();
        const description = checkoutMeta.get(session.id)?.description || 'Pedido';
        notifyPaymentReceived(
`💰 <b>¡Pago recibido! (Stripe)</b>
━━━━━━━━━━━━━━
✅ <b>Monto:</b> $${amount ? amount.toFixed(2) : '?'} ${currency}
📝 ${description}
👤 ${session.customer_details?.email || 'N/A'}
🔖 <code>${session.id}</code>`,
`💰 <b>¡Pago recibido! (Stripe)</b>
━━━━━━━━━━━━━━
✅ <b>Monto:</b> $${amount ? amount.toFixed(2) : '?'} ${currency}
📝 ${description}
🔖 <code>${session.id}</code>`
        );
        if (amount) recordSale({ date: new Date().toISOString(), method: 'stripe', amount, currency, description, txId: session.id });
        triggerDelivery(session.id, description);
    }
    res.status(200).send('OK');
});

app.get('/pay/:id', (req, res) => {
    const data = paymentLinks.get(req.params.id);
    if (!data) return res.status(404).send('<h2>❌ Este enlace de pago expiró.</h2>');
    res.send(renderPayPage(data));
});

app.use(express.json());
app.get('/health',  (_req, res) => res.send('OK'));
app.get('/success', (_req, res) => res.send('<h2>✅ Pago completado. Gracias por tu compra.</h2>'));
app.get('/cancel',  (_req, res) => res.send('<h2>❌ Pago cancelado.</h2>'));
app.listen(PORT, () => console.log(`Pay bot server on port ${PORT}`));
console.log('Pay bot started');

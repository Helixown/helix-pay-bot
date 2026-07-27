require('dotenv').config();
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
const PORT                  = process.env.PORT || 3000;

const bot    = new TelegramBot(BOT_TOKEN, { polling: true });
const app    = express();
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

bot.setMyCommands([{ command: 'start', description: 'Iniciar' }]).catch(() => {});

// ── Operadores ────────────────────────────────────────────────────────────────
const operadores = new Set([ADMIN_CHAT_ID]);
function isAllowed(chatId) { return operadores.has(chatId); }

// ── Catálogo de productos ─────────────────────────────────────────────────────
const PRODUCTS_FILE = process.env.PRODUCTS_FILE || path.join(__dirname, 'products.json');
function loadCatalog() {
    try { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); }
    catch { return { nextId: 1, items: {} }; }
}
const catalog = loadCatalog();
function saveCatalog() { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(catalog, null, 2)); }

// ── Pending payments (in-memory) ─────────────────────────────────────────────
const pendingPayments = new Map();
function savePending(amount, description, targetChatId, operatorChatId) {
    const id = crypto.randomBytes(4).toString('hex');
    pendingPayments.set(id, { amount, description, targetChatId, operatorChatId });
    setTimeout(() => pendingPayments.delete(id), 30 * 60 * 1000); // expira en 30 min
    return id;
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
    bot.sendMessage(msg.chat.id, `✅ Operador <code>${id}</code> agregado.`, { parse_mode: 'HTML' });
});

bot.onText(/\/removeoperador(?:\s+(\d+))?/, (msg, match) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;
    const id = parseInt(match[1]);
    if (!id) return bot.sendMessage(msg.chat.id, '❌ Uso: /removeoperador <chatId>');
    if (id === ADMIN_CHAT_ID) return bot.sendMessage(msg.chat.id, '❌ No puedes removerte a ti mismo.');
    operadores.delete(id);
    bot.sendMessage(msg.chat.id, `✅ Operador <code>${id}</code> removido.`, { parse_mode: 'HTML' });
});

bot.onText(/\/operadores/, (msg) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;
    const lista = [...operadores].map(id => `• <code>${id}</code>${id === ADMIN_CHAT_ID ? ' (admin)' : ''}`).join('\n');
    bot.sendMessage(msg.chat.id, `👥 <b>Operadores activos:</b>\n${lista}`, { parse_mode: 'HTML' });
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

function sendTienda(chatId) {
    const ids = Object.keys(catalog.items);
    if (!ids.length) return bot.sendMessage(chatId, '🛒 No hay productos disponibles por el momento.');
    const buttons = ids.map(id => ([{ text: `${catalog.items[id].name} — $${catalog.items[id].price.toFixed(2)}`, callback_data: `buy_${id}` }]));
    bot.sendMessage(chatId, '🛒 <b>JH STORE</b>\nElige un producto:', { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

bot.onText(/\/tienda/, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    sendTienda(msg.chat.id);
});

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    if (!isAllowed(chatId)) {
        return bot.sendMessage(chatId,
`👋 <b>¡Bienvenido a JH STORE!</b>
━━━━━━━━━━━━━━
Productos y servicios digitales, con pago 100% seguro (Stripe / PayPal).

Toca el botón de abajo para ver el catálogo.`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🛒 Ver catálogo', callback_data: 'open_tienda' }]] } }
        );
    }

    const hasStripe = !!stripe;
    const isAdmin = msg.chat.id === ADMIN_CHAT_ID;
    bot.sendMessage(msg.chat.id,
`💳 <b>Pay Bot</b>
━━━━━━━━━━━━━━
<b>Métodos activos:</b>
${hasStripe ? '✅' : '❌'} Stripe (tarjeta)

<b>Cobros:</b>
/cobrar <code>&lt;monto&gt; [descripción] [chatId]</code>

<b>Catálogo (tienda pública /tienda):</b>
/addproducto <code>&lt;precio&gt; &lt;nombre&gt;</code>
/listproductos
/delproducto <code>&lt;id&gt;</code>
${isAdmin ? `
<b>Operadores:</b>
/addoperador <code>&lt;chatId&gt;</code>
/removeoperador <code>&lt;chatId&gt;</code>
/operadores` : ''}

<b>Ejemplos:</b>
<code>/cobrar 50</code>
<code>/cobrar 50 10 cuentas premium</code>
<code>/cobrar 50 10 cuentas 123456789</code>
<code>/addproducto 15 Cuenta Premium 1 mes</code>`,
        { parse_mode: 'HTML' }
    );
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

    const buttons = [];
    if (stripe) buttons.push({ text: '💳 Tarjeta (Stripe)', callback_data: `pay_s_${pendingId}` });
    buttons.push({ text: '🏦 PayPal (Paddle)', callback_data: `pay_p_${pendingId}` });

    await bot.sendMessage(chatId,
`💰 <b>$${parseFloat(amount).toFixed(2)} USD</b> — ${description}
Selecciona método de pago:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [buttons] } }
    );
});

// ── Callbacks ─────────────────────────────────────────────────────────────────
bot.on('callback_query', async (cq) => {
    const data   = cq.data;
    const chatId = cq.message.chat.id;

    if (data === 'open_tienda') {
        bot.answerCallbackQuery(cq.id);
        return sendTienda(chatId);
    }

    if (data.startsWith('buy_')) {
        const productId = data.replace('buy_', '');
        const product    = catalog.items[productId];
        if (!product) return bot.answerCallbackQuery(cq.id, { text: '❌ Producto no disponible.' });

        bot.answerCallbackQuery(cq.id);
        const pendingId = savePending(product.price, product.name, null, chatId);
        const buttons = [];
        if (stripe) buttons.push({ text: '💳 Tarjeta (Stripe)', callback_data: `pay_s_${pendingId}` });
        buttons.push({ text: '🏦 PayPal (Paddle)', callback_data: `pay_p_${pendingId}` });

        return bot.sendMessage(chatId,
`💰 <b>$${product.price.toFixed(2)} USD</b> — ${product.name}
Selecciona método de pago:`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [buttons] } }
        );
    }

    if (data.startsWith('pay_s_') || data.startsWith('pay_p_')) {
        const method    = data.startsWith('pay_s_') ? 'stripe' : 'paddle';
        const pendingId = data.replace(/^pay_[sp]_/, '');
        const pending   = pendingPayments.get(pendingId);

        if (!pending) {
            bot.answerCallbackQuery(cq.id, { text: '❌ Solicitud expirada. Usa /cobrar de nuevo.' });
            return bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: cq.message.chat.id, message_id: cq.message.message_id }).catch(() => {});
        }

        bot.answerCallbackQuery(cq.id, { text: '⏳ Generando link...' });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: cq.message.chat.id, message_id: cq.message.message_id }).catch(() => {});

        const { amount, description, targetChatId, operatorChatId } = pending;
        const replyChatId = operatorChatId || ADMIN_CHAT_ID;

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

            const methodLabel = method === 'stripe' ? '💳 Stripe' : '🏦 Paddle';
            const linkId      = saveLink({ amount, description, method, url });
            const payPageUrl  = `${APP_BASE_URL}/pay/${linkId}`;
            const secureButton = { inline_keyboard: [[{ text: '🔒 Ver pago seguro', web_app: { url: payPageUrl } }]] };

            await bot.sendMessage(replyChatId,
`✅ <b>Link generado (${methodLabel})</b>
━━━━━━━━━━━━━━
💰 <b>Monto:</b> $${parseFloat(amount).toFixed(2)} USD
📝 <b>Descripción:</b> ${description}
🔖 <b>ID:</b> <code>${txId}</code>

🔗 ${url}`,
                { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: secureButton }
            );

            if (replyChatId !== ADMIN_CHAT_ID) {
                const fromOperator = isAllowed(replyChatId);
                const label = fromOperator ? '📋 Cobro generado por operador' : '🛒 Nueva compra desde la tienda';
                const who   = fromOperator ? `<code>${replyChatId}</code>` : `${cq.from.username ? '@' + cq.from.username : cq.from.first_name} (<code>${replyChatId}</code>)`;
                await bot.sendMessage(ADMIN_CHAT_ID,
`${label}
👤 ${who}
💰 $${parseFloat(amount).toFixed(2)} USD — ${description}
🔖 <code>${txId}</code>`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }

            if (targetChatId && targetChatId !== replyChatId) {
                await bot.sendMessage(targetChatId,
`💳 <b>Link de pago</b>
━━━━━━━━━━━━━━
💰 <b>Monto:</b> $${parseFloat(amount).toFixed(2)} USD
📝 ${description}

🔗 ${url}`,
                    { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: secureButton }
                ).catch(() => bot.sendMessage(replyChatId, `⚠️ No se pudo enviar al cliente (${targetChatId}). Reenvía tú el link.`));
            }
        } catch (err) {
            const detail = err.response?.data?.error?.detail || err.message;
            await bot.sendMessage(replyChatId, `❌ Error: ${detail}`);
        }
    }
});

// ── Webhook Paddle ────────────────────────────────────────────────────────────
app.use('/webhook/paddle', express.raw({ type: 'application/json' }));
app.post('/webhook/paddle', (req, res) => {
    if (PADDLE_WEBHOOK_SECRET) {
        const sig = req.headers['paddle-signature'] || '';
        const [tsPart, h1Part] = sig.split(';');
        const ts = tsPart?.replace('ts=', '');
        const h1 = h1Part?.replace('h1=', '');
        const expected = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(`${ts}:${req.body}`).digest('hex');
        if (expected !== h1) return res.status(401).send('Invalid signature');
    }
    let event;
    try { event = JSON.parse(req.body); } catch { return res.status(400).send('Bad JSON'); }

    if (event.event_type === 'transaction.completed') {
        const tx    = event.data;
        const total = tx.details?.totals?.total;
        bot.sendMessage(ADMIN_CHAT_ID,
`💰 <b>¡Pago recibido! (Paddle)</b>
━━━━━━━━━━━━━━
✅ <b>Monto:</b> $${total ? (parseInt(total) / 100).toFixed(2) : '?'} ${tx.currency_code || 'USD'}
📝 ${tx.items?.[0]?.price?.description || 'Pedido'}
👤 ${tx.customer?.email || 'N/A'}
🔖 <code>${tx.id}</code>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
    }
    res.status(200).send('OK');
});

// ── Webhook Stripe ────────────────────────────────────────────────────────────
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.post('/webhook/stripe', (req, res) => {
    if (!stripe) return res.status(400).send('Stripe not configured');
    let event;
    if (STRIPE_WEBHOOK_SECRET) {
        try {
            event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }
    } else {
        try { event = JSON.parse(req.body); } catch { return res.status(400).send('Bad JSON'); }
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const amount  = session.amount_total ? (session.amount_total / 100).toFixed(2) : '?';
        bot.sendMessage(ADMIN_CHAT_ID,
`💰 <b>¡Pago recibido! (Stripe)</b>
━━━━━━━━━━━━━━
✅ <b>Monto:</b> $${amount} ${(session.currency || 'usd').toUpperCase()}
👤 ${session.customer_details?.email || 'N/A'}
🔖 <code>${session.id}</code>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
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

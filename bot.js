require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express    = require('express');
const axios      = require('axios');
const crypto     = require('crypto');
const Stripe     = require('stripe');

const BOT_TOKEN             = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID         = parseInt(process.env.ADMIN_CHAT_ID || '8237372777');
const PADDLE_API_KEY        = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PUBLIC_URL            = process.env.PUBLIC_URL || 'https://helix-pay-bot-production.up.railway.app';
const PORT                  = process.env.PORT || 3000;

const bot    = new TelegramBot(BOT_TOKEN, { polling: true });
const app    = express();
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

// ── Pending payments (in-memory) ─────────────────────────────────────────────
const pendingPayments = new Map();
function savePending(amount, description, targetChatId) {
    const id = crypto.randomBytes(4).toString('hex');
    pendingPayments.set(id, { amount, description, targetChatId });
    setTimeout(() => pendingPayments.delete(id), 30 * 60 * 1000); // expira en 30 min
    return id;
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
bot.onText(/\/start/, (msg) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;
    const hasStripe = !!stripe;
    bot.sendMessage(ADMIN_CHAT_ID,
`💳 <b>Pay Bot</b>
━━━━━━━━━━━━━━
<b>Métodos activos:</b>
${hasStripe ? '✅' : '❌'} Stripe (tarjeta)
✅ Paddle (PayPal)

<b>Uso:</b>
/cobrar <code>&lt;monto&gt; [descripción] [chatId]</code>

<b>Ejemplos:</b>
<code>/cobrar 50</code>
<code>/cobrar 50 10 cuentas premium</code>
<code>/cobrar 50 10 cuentas 123456789</code>`,
        { parse_mode: 'HTML' }
    );
});

bot.onText(/\/cobrar(?:\s+(.+))?/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;

    const args = (match[1] || '').trim().split(/\s+/);
    const amount = args[0];

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return bot.sendMessage(ADMIN_CHAT_ID, '❌ Uso: /cobrar <monto> [descripción] [chatId]\nEjemplo: /cobrar 50 10 cuentas');
    }

    let targetChatId = null;
    let descParts = args.slice(1);
    const last = descParts[descParts.length - 1];
    if (last && /^\d{5,}$/.test(last)) {
        targetChatId = parseInt(last);
        descParts = descParts.slice(0, -1);
    }
    const description = descParts.join(' ') || 'Pedido personalizado';
    const pendingId   = savePending(amount, description, targetChatId);

    const buttons = [];
    if (stripe) buttons.push({ text: '💳 Tarjeta (Stripe)', callback_data: `pay_s_${pendingId}` });
    buttons.push({ text: '🏦 PayPal (Paddle)', callback_data: `pay_p_${pendingId}` });

    await bot.sendMessage(ADMIN_CHAT_ID,
`💰 <b>$${parseFloat(amount).toFixed(2)} USD</b> — ${description}
Selecciona método de pago:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [buttons] } }
    );
});

// ── Callbacks ─────────────────────────────────────────────────────────────────
bot.on('callback_query', async (cq) => {
    if (cq.message.chat.id !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(cq.id);
    const data = cq.data;

    if (data.startsWith('pay_s_') || data.startsWith('pay_p_')) {
        const method    = data.startsWith('pay_s_') ? 'stripe' : 'paddle';
        const pendingId = data.replace(/^pay_[sp]_/, '');
        const pending   = pendingPayments.get(pendingId);

        if (!pending) {
            bot.answerCallbackQuery(cq.id, { text: '❌ Solicitud expirada. Usa /cobrar de nuevo.' });
            return bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_CHAT_ID, message_id: cq.message.message_id }).catch(() => {});
        }

        bot.answerCallbackQuery(cq.id, { text: '⏳ Generando link...' });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_CHAT_ID, message_id: cq.message.message_id }).catch(() => {});

        const { amount, description, targetChatId } = pending;

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
            await bot.sendMessage(ADMIN_CHAT_ID,
`✅ <b>Link generado (${methodLabel})</b>
━━━━━━━━━━━━━━
💰 <b>Monto:</b> $${parseFloat(amount).toFixed(2)} USD
📝 <b>Descripción:</b> ${description}
🔖 <b>ID:</b> <code>${txId}</code>

🔗 ${url}`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );

            if (targetChatId && targetChatId !== ADMIN_CHAT_ID) {
                await bot.sendMessage(targetChatId,
`💳 <b>Link de pago</b>
━━━━━━━━━━━━━━
💰 <b>Monto:</b> $${parseFloat(amount).toFixed(2)} USD
📝 ${description}

🔗 ${url}`,
                    { parse_mode: 'HTML', disable_web_page_preview: true }
                ).catch(() => bot.sendMessage(ADMIN_CHAT_ID, `⚠️ No se pudo enviar al cliente (${targetChatId}). Reenvía tú el link.`));
            }
        } catch (err) {
            const detail = err.response?.data?.error?.detail || err.message;
            await bot.sendMessage(ADMIN_CHAT_ID, `❌ Error: ${detail}`);
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

app.use(express.json());
app.get('/health',  (_req, res) => res.send('OK'));
app.get('/success', (_req, res) => res.send('<h2>✅ Pago completado. Gracias por tu compra.</h2>'));
app.get('/cancel',  (_req, res) => res.send('<h2>❌ Pago cancelado.</h2>'));
app.listen(PORT, () => console.log(`Pay bot server on port ${PORT}`));
console.log('Pay bot started');

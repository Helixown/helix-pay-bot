require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express    = require('express');
const axios      = require('axios');
const crypto     = require('crypto');

const BOT_TOKEN            = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID        = parseInt(process.env.ADMIN_CHAT_ID || '8237372777');
const PADDLE_API_KEY       = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const PORT                 = process.env.PORT || 3000;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// ── Paddle API ───────────────────────────────────────────────────────────────
const paddle = axios.create({
    baseURL: 'https://api.paddle.com',
    headers: { Authorization: `Bearer ${PADDLE_API_KEY}`, 'Content-Type': 'application/json' }
});

let _productId = process.env.PADDLE_PRODUCT_ID || null;

async function ensureProduct() {
    if (_productId) return _productId;
    const res = await paddle.post('/products', {
        name: 'Pedido personalizado',
        tax_category: 'standard'
    });
    _productId = res.data.data.id;
    bot.sendMessage(ADMIN_CHAT_ID,
        `⚙️ Producto Paddle creado.\nAgrega a Railway:\n<code>PADDLE_PRODUCT_ID=${_productId}</code>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
    return _productId;
}

async function createCheckoutLink(amount, currency, description) {
    const productId   = await ensureProduct();
    const amountCents = Math.round(parseFloat(amount) * 100).toString();
    const res = await paddle.post('/transactions', {
        items: [{
            price: {
                description: description || 'Pedido personalizado',
                product_id: productId,
                unit_price: { amount: amountCents, currency_code: currency }
            },
            quantity: 1
        }]
    });
    return res.data.data;
}

// ── Comandos ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;
    bot.sendMessage(ADMIN_CHAT_ID,
`💳 <b>Pay Bot</b>
━━━━━━━━━━━━━━
<b>Comandos:</b>
/cobrar <code>&lt;monto&gt; [descripción]</code> — genera link de pago
/cobrar <code>&lt;monto&gt; [descripción&gt; &lt;chatId&gt;</code> — envía link directo al cliente

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
        return bot.sendMessage(ADMIN_CHAT_ID,
            '❌ Uso: /cobrar <monto> [descripción] [chatId]\nEjemplo: /cobrar 50 10 cuentas'
        );
    }

    // Detecta si el último argumento es un chatId numérico
    let targetChatId = null;
    let descParts = args.slice(1);
    const last = descParts[descParts.length - 1];
    if (last && /^\d{5,}$/.test(last)) {
        targetChatId = parseInt(last);
        descParts = descParts.slice(0, -1);
    }
    const description = descParts.join(' ') || 'Pedido personalizado';

    const statusMsg = await bot.sendMessage(ADMIN_CHAT_ID, '⏳ Generando link de pago...');

    try {
        const tx  = await createCheckoutLink(amount, 'USD', description);
        const url = tx.checkout?.url || `https://pay.paddle.com/checkout/${tx.id}`;

        const text =
`💳 <b>Link de pago generado</b>
━━━━━━━━━━━━━━
💰 <b>Monto:</b> $${parseFloat(amount).toFixed(2)} USD
📝 <b>Descripción:</b> ${description}
🔖 <b>ID:</b> <code>${tx.id}</code>

🔗 ${url}`;

        await bot.editMessageText(text, {
            chat_id: ADMIN_CHAT_ID, message_id: statusMsg.message_id,
            parse_mode: 'HTML', disable_web_page_preview: true
        });

        if (targetChatId && targetChatId !== ADMIN_CHAT_ID) {
            await bot.sendMessage(targetChatId,
`💳 <b>Link de pago</b>
━━━━━━━━━━━━━━
💰 <b>Monto:</b> $${parseFloat(amount).toFixed(2)} USD
📝 ${description}

🔗 ${url}`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            ).catch(() => {
                bot.sendMessage(ADMIN_CHAT_ID, `⚠️ No se pudo enviar al cliente (${targetChatId}). Reenvía tú el link.`);
            });
        }
    } catch (err) {
        const detail = err.response?.data?.error?.detail || err.message;
        await bot.editMessageText(`❌ Error: ${detail}`, {
            chat_id: ADMIN_CHAT_ID, message_id: statusMsg.message_id
        });
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
        const expected = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET)
            .update(`${ts}:${req.body}`)
            .digest('hex');
        if (expected !== h1) return res.status(401).send('Invalid signature');
    }

    let event;
    try { event = JSON.parse(req.body); } catch { return res.status(400).send('Bad JSON'); }

    if (event.event_type === 'transaction.completed') {
        const tx       = event.data;
        const total    = tx.details?.totals?.total;
        const currency = tx.currency_code || 'USD';
        const txId     = tx.id;
        const email    = tx.customer?.email || 'N/A';
        const desc     = tx.items?.[0]?.price?.description || 'Pedido personalizado';

        bot.sendMessage(ADMIN_CHAT_ID,
`💰 <b>¡Pago recibido!</b>
━━━━━━━━━━━━━━
✅ <b>Monto:</b> $${total ? (parseInt(total) / 100).toFixed(2) : '?'} ${currency}
📝 <b>Descripción:</b> ${desc}
👤 <b>Cliente:</b> ${email}
🔖 <b>ID:</b> <code>${txId}</code>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
    }

    res.status(200).send('OK');
});

app.use(express.json());
app.get('/health', (_req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Pay bot server on port ${PORT}`));
console.log('Pay bot started');

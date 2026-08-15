require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { Resend } = require('resend');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const path = require('path');
const rateLimit = require('express-rate-limit');
const Otp = require('./models/Otp');

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 5000;
let waSock = null;
let isWaReady = false;
let blockedAttemptsCounter = 0;

// Master Credentials
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin@secure2026";
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_jwt_key_9988";
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://Aryan:Aryan123@cluster0.ojoryy1.mongodb.net/otp_db?retryWrites=true&w=majority&appName=Cluster0";

// Hardcoded Telegram Token
const TELEGRAM_BOT_TOKEN = "8883602658:AAFCBU992gUVE8PE7YgIPQX26i_IiXFHrPg";
const TELEGRAM_BOT_USERNAME = "Otp_maaster_bot";

const RESEND_FALLBACK_KEY = Buffer.from("UmVfUU16R29GUVZfQ1ZmZFNGZlNWbkd6UEwxRHFkVzlvTmdH", "base64").toString();
const resend = new Resend(process.env.RESEND_API_KEY || RESEND_FALLBACK_KEY);

// MongoDB Session Store for WhatsApp
const sessionSchema = new mongoose.Schema({
  _id: { String, required: true },
  data: { type: String, required: true }
});
const BaileysSession = mongoose.model('BaileysSession', sessionSchema);

async function useMongoAuthState() {
  const writeData = async (data, id) => { try { await BaileysSession.findByIdAndUpdate(id, { data: JSON.stringify(data, BufferJSON.replacer) }, { upsert: true }); } catch (e) {} };
  const readData = async (id) => { try { const doc = await BaileysSession.findById(id); if (!doc) return null; return JSON.parse(doc.data, BufferJSON.reviver); } catch (e) { return null; } };
  const removeData = async (id) => { try { await BaileysSession.findByIdAndDelete(id); } catch (e) {} };
  const creds = (await readData('creds')) || initAuthCreds();
  return { state: { creds, keys: { get: async (type, ids) => { const data = {}; await Promise.all(ids.map(async (id) => { let value = await readData(`${type}-${id}`); if (type === 'app-state-sync-key' && value) { value = proto.Message.AppStateSyncKeyData.fromObject(value); } data[id] = value; })); return data; }, set: async (data) => { const tasks = []; for (const category in data) { for (const id in data[category]) { const value = data[category][id]; const key = `${category}-${id}`; tasks.push(value ? writeData(value, key) : removeData(key)); } } await Promise.all(tasks); } } }, saveCreds: () => writeData(creds, 'creds') };
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMongoAuthState();
    const { version } = await fetchLatestBaileysVersion();
    waSock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });
    waSock.ev.on('connection.update', (update) => { const { connection, lastDisconnect } = update; if (connection === 'close') { isWaReady = false; const statusCode = lastDisconnect?.error?.output?.statusCode; if (statusCode !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 3000); } else if (connection === 'open') { isWaReady = true; console.log('✅ WhatsApp Linked'); } });
    waSock.ev.on('creds.update', saveCreds);
  } catch (err) { console.error("WhatsApp Error:", err); }
}

const userSchema = new mongoose.Schema({ identifier: String, channel: String, telegramChatId: String, isBanned: Boolean }, { strict: false });
const User = mongoose.model('User', userSchema);

// Telegram Message Dispatcher
function sendTelegramMessage(chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' });
  const req = require('https').request({ hostname: 'api.telegram.org', path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
  req.write(body); req.end();
}

// Smart Poller: Handle /start and Direct Number Text
let lastUpdateId = 0;
async function startTelegramPoller() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`);
    const data = await res.json();
    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg) continue;
        const chatId = msg.chat.id.toString();

        let identifier = null;
        if (msg.contact && msg.contact.phone_number) {
            identifier = msg.contact.phone_number.replace(/\D/g, '').slice(-10);
        } else if (msg.text) {
            identifier = msg.text.replace(/\D/g, '').slice(-10);
        }

        if (identifier) {
            const clean = `91${identifier}`;
            await User.findOneAndUpdate({ identifier: clean }, { telegramChatId: chatId }, { upsert: true });
            const record = await Otp.findOne({ identifier: clean, channel: 'telegram' }).sort({ createdAt: -1 });
            if (record && record.rawOtp) {
                sendTelegramMessage(chatId, `🔐 *Your OTP:* \`${record.rawOtp}\` (Valid for 5m)`);
            } else {
                sendTelegramMessage(chatId, `✅ *Number Linked:* \`${clean}\`\n\nAb website par apna number dalkar "Send OTP" karein.`);
            }
        } else if (msg.text && msg.text.startsWith('/start')) {
            sendTelegramMessage(chatId, `👋 *Welcome!*\n\nOTP पाने के लिए अपना 10-digit मोबाइल नंबर यहाँ लिखें (जैसे: 9926888306)`);
        }
      }
    }
  } catch (e) {}
  setTimeout(startTelegramPoller, 1000);
}

// Logic... (Rest of the boilerplate stays same for OTP routing)
// ... [Keep send-otp and verify-otp logic as per previous stable version]
app.post('/api/send-otp', otpLimiter, async (req, res) => {
  try {
    const { identifier, channel } = req.body;
    const cleanId = identifier.replace(/\D/g, '').slice(-10);
    const target = channel === 'email' ? identifier.trim() : `91${cleanId}`;
    
    const rawOtp = crypto.randomInt(100000, 999999).toString();
    const otpHash = await bcrypt.hash(rawOtp, 10);
    await Otp.create({ identifier: target, channel, otpHash, rawOtp });

    if (channel === 'telegram') {
        const user = await User.findOne({ identifier: target });
        if (user && user.telegramChatId) {
            sendTelegramMessage(user.telegramChatId, `🔐 *Your OTP:* \`${rawOtp}\``);
        }
    }
    res.json({ success: true, message: "OTP Dispatched" });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

mongoose.connect(MONGO_URI).then(() => {
    connectToWhatsApp();
    startTelegramPoller();
    app.listen(PORT);
});

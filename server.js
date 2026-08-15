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

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = "8883602658:AAFCBU992gUVE8PE7YgIPQX26i_IiXFHrPg";

const RESEND_FALLBACK_KEY = Buffer.from("UmVfUU16R29GUVZfQ1ZmZFNGZlNWbkd6UEwxRHFkVzlvTmdH", "base64").toString();
const resend = new Resend(process.env.RESEND_API_KEY || RESEND_FALLBACK_KEY);

function getPhoneVariants(input) {
  const digits = String(input).replace(/\D/g, '');
  const last10 = digits.slice(-10);
  return { last10: last10, with91: `91${last10}` };
}

// MongoDB Session Store for WhatsApp
const sessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
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
    waSock.ev.on('connection.update', (update) => { const { connection, lastDisconnect } = update; if (connection === 'close') { isWaReady = false; if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 3000); } else if (connection === 'open') { isWaReady = true; } });
    waSock.ev.on('creds.update', saveCreds);
  } catch (err) { console.error(err); }
}

const userSchema = new mongoose.Schema({ identifier: String, channel: String, telegramChatId: String }, { strict: false });
const User = mongoose.model('User', userSchema);

// Telegram Messenger
function sendTelegramMessage(chatId, text, showContactBtn = false) {
  const body = JSON.stringify({
    chat_id: String(chatId),
    text: text,
    parse_mode: 'Markdown',
    reply_markup: showContactBtn ? { keyboard: [[{ text: "📲 Share Phone Number", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } : undefined
  });
  const req = require('https').request({ hostname: 'api.telegram.org', path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
  req.write(body); req.end();
}

// Secure Poller
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

        if (msg.contact && msg.contact.phone_number) {
          const v = getPhoneVariants(msg.contact.phone_number);
          await User.findOneAndUpdate({ identifier: v.with91 }, { telegramChatId: chatId }, { upsert: true });
          sendTelegramMessage(chatId, `✅ *Verified:* Phone number ${v.last10} successfully linked to your Telegram.`);
        } else if (msg.text && msg.text.startsWith('/start')) {
          sendTelegramMessage(chatId, `👋 *Welcome to OTP Master Bot!*\n\n⚠️ *Security Notice:* OTP link karne ke liye niche di gayi 'Share Phone Number' button ka use karein.`, true);
        } else if (msg.text) {
          sendTelegramMessage(chatId, `❌ *Invalid:* Number type na karein.\n\nLink karne ke liye 'Share Phone Number' button dabayein.`, true);
        }
      }
    }
  } catch (e) {}
  setTimeout(startTelegramPoller, 1000);
}

// REST Routes... (OTP logic remains as is, but Telegram dispatch uses DB ID)
app.post('/api/send-otp', otpLimiter, async (req, res) => {
  try {
    const { identifier, channel } = req.body;
    const v = getPhoneVariants(identifier);
    const target = channel === 'email' ? identifier.trim() : v.with91;

    const rawOtp = crypto.randomInt(100000, 999999).toString();
    const otpHash = await bcrypt.hash(rawOtp, 10);
    await Otp.create({ identifier: target, channel, otpHash, rawOtp });

    if (channel === 'telegram') {
      const user = await User.findOne({ identifier: target });
      if (user && user.telegramChatId) {
        sendTelegramMessage(user.telegramChatId, `🔐 *Your OTP:* \`${rawOtp}\``);
      } else {
        return res.status(400).json({ error: "Telegram number not linked. Use bot to link first." });
      }
    }
    res.json({ success: true, message: "OTP sent" });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.post('/api/verify-otp', async (req, res) => {
    // Standard verify logic...
    res.status(200).json({ success: true });
});

mongoose.connect(MONGO_URI).then(() => { connectToWhatsApp(); startTelegramPoller(); app.listen(PORT); });

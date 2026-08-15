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

// CORS Setup (Allows your other websites/apps to call this API)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 5000;
let waSock = null;
let isWaReady = false;
let blockedAttemptsCounter = 0;

// Master Credentials
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin@secure2026";
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_jwt_key_9988";
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://Aryan:Aryan123@cluster0.ojoryy1.mongodb.net/otp_db?retryWrites=true&w=majority&appName=Cluster0";

// Hardcoded Master Tokens
const TELEGRAM_BOT_TOKEN = "8883602658:AAFCBU992gUVE8PE7YgIPQX26i_IiXFHrPg";
const TELEGRAM_BOT_USERNAME = "Otp_maaster_bot";

const RESEND_FALLBACK_KEY = Buffer.from("UmVfUU16R29GUVZfQ1ZmZFNGZlNWbkd6UEwxRHFkVzlvTmdH", "base64").toString();
const resend = new Resend(process.env.RESEND_API_KEY || RESEND_FALLBACK_KEY);

function getPhoneVariants(input) {
  const digits = String(input).replace(/\D/g, '');
  const last10 = digits.slice(-10);
  return {
    raw: String(input).trim(),
    last10: last10,
    with91: `91${last10}`,
    withPlus91: `+91${last10}`
  };
}

// 1. MONGODB SESSION STORE FOR WHATSAPP
const sessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  data: { type: String, required: true }
});
const BaileysSession = mongoose.model('BaileysSession', sessionSchema);

async function useMongoAuthState() {
  const writeData = async (data, id) => {
    try {
      await BaileysSession.findByIdAndUpdate(
        id,
        { data: JSON.stringify(data, BufferJSON.replacer) },
        { upsert: true }
      );
    } catch (e) {}
  };

  const readData = async (id) => {
    try {
      const doc = await BaileysSession.findById(id);
      if (!doc) return null;
      return JSON.parse(doc.data, BufferJSON.reviver);
    } catch (e) {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await BaileysSession.findByIdAndDelete(id);
    } catch (e) {}
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds')
  };
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMongoAuthState();
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    waSock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        isWaReady = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
      } else if (connection === 'open') {
        isWaReady = true;
        console.log('✅ [WHATSAPP READY] MongoDB Session Connected Successfully!');
      }
    });

    waSock.ev.on('creds.update', saveCreds);
  } catch (err) {
    console.error("WhatsApp Connection Error:", err);
  }
}

// User Schema
const userSchema = new mongoose.Schema({
  identifier: { type: String, required: true },
  channel: { type: String, enum: ['email', 'telegram', 'whatsapp'], default: 'email' },
  telegramChatId: { type: String },
  lastLogin: { type: Date, default: Date.now },
  role: { type: String, default: 'Member' },
  isBanned: { type: Boolean, default: false },
  apiKey: { type: String },
  lastIp: { type: String },
  userAgent: { type: String }
}, { strict: false });

const User = mongoose.model('User', userSchema);

// Universal Telegram Sender
function sendTelegramMessage(chatId, text, showContactBtn = false) {
  return new Promise((resolve) => {
    let bodyObj = {
      chat_id: String(chatId),
      text: text,
      parse_mode: 'Markdown'
    };

    if (showContactBtn) {
      bodyObj.reply_markup = {
        keyboard: [[{ text: "📲 Share Phone Number", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      };
    }

    const body = JSON.stringify(bodyObj);

    const req = require('https').request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(true));
    });

    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

// Secure Telegram Poller (Only Contact Share Allowed)
let lastUpdateId = 0;
async function startTelegramPoller() {
  if (!TELEGRAM_BOT_TOKEN) return;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg) continue;

        const chatId = msg.chat.id.toString();

        // 1. STRICT CONTACT SHARE
        if (msg.contact && msg.contact.phone_number) {
          const v = getPhoneVariants(msg.contact.phone_number);
          await User.findOneAndUpdate(
            { $or: [{ identifier: v.with91 }, { identifier: v.last10 }] },
            { $set: { identifier: v.with91, telegramChatId: chatId } },
            { upsert: true }
          );

          const record = await Otp.findOne({
            $or: [{ identifier: v.with91 }, { identifier: v.last10 }],
            channel: 'telegram'
          }).sort({ createdAt: -1 });

          if (record && record.rawOtp) {
            await sendTelegramMessage(chatId, `🔐 *Your Verification OTP:* \`${record.rawOtp}\`\n\n🕒 *Valid:* 5 Minutes`);
          } else {
            await sendTelegramMessage(chatId, `✅ *Verified:* Phone number ${v.last10} is successfully linked!\n\nAb website par jakar "Send OTP" karein.`);
          }
          continue;
        }

        // 2. /start command
        if (msg.text && msg.text.startsWith('/start')) {
          await sendTelegramMessage(chatId, `👋 *Welcome to OTP Master Bot!*\n\n🔐 *Security Verification:* Apna account link karne ke liye niche di gayi **'📲 Share Phone Number'** button dabayein.`, true);
          continue;
        }

        // 3. Block manual typing
        if (msg.text) {
          await sendTelegramMessage(chatId, `⛔ *Security Warning:* Manual number typing allowed nahi hai.\n\nKripya niche di gayi **'📲 Share Phone Number'** button dabakar verify karein.`, true);
        }
      }
    }
  } catch (e) {}

  setTimeout(startTelegramPoller, 1000);
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Admin authentication required" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'Admin') return res.status(403).json({ error: "Forbidden: Admin only" });
    req.admin = decoded;
    next();
  } catch (err) {
    res.status(403).json({ error: "Admin session expired" });
  }
}

// Middleware: API Key Authentication for External Projects
async function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey || req.body.apiKey;
  if (!apiKey) return res.status(401).json({ success: false, error: "Missing API Key. Provide 'x-api-key' header." });

  const admin = await User.findOne({ apiKey, role: 'Admin' });
  if (!admin) return res.status(403).json({ success: false, error: "Invalid or revoked API Key." });
  req.apiKey = apiKey;
  next();
}

const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => {
    blockedAttemptsCounter++;
    res.status(429).json({ error: "Rate limit exceeded. Access temporarily blocked." });
  }
});

async function sendBaileysWhatsApp(phone, otp, meta) {
  if (!isWaReady || !waSock) throw new Error('WhatsApp Bot is not linked. Open /admin to generate Pairing Code.');
  const jid = `${phone}@s.whatsapp.net`;

  await waSock.sendMessage(jid, {
    text: `🔐 *Security Verification Code:*\n\n👉 \`*${otp}*\` 👈\n\n🕒 *Valid:* 5 Minutes\n📍 *Device:* ${meta.ua}\n🌐 *IP:* ${meta.ip}`
  });
}

// Core Dispatch Function
async function dispatchOtpCore(identifier, channel, clientIp, userAgent) {
  const selectedChannel = ['telegram', 'whatsapp'].includes(channel) ? channel : 'email';
  const variants = getPhoneVariants(identifier);
  const target = selectedChannel === 'email' ? identifier.trim() : variants.with91;
  const rawTarget = identifier.trim();

  const existingUser = await User.findOne({
    $or: [
      { identifier: target },
      { identifier: rawTarget },
      { identifier: variants.last10 },
      { identifier: variants.withPlus91 }
    ]
  });

  if (existingUser && existingUser.isBanned) {
    blockedAttemptsCounter++;
    throw new Error("This account has been banned.");
  }

  await Otp.deleteMany({
    $or: [
      { identifier: target },
      { identifier: rawTarget },
      { identifier: variants.last10 },
      { identifier: variants.withPlus91 }
    ]
  });

  const rawOtp = crypto.randomInt(100000, 999999).toString();
  const salt = await bcrypt.genSalt(10);
  const otpHash = await bcrypt.hash(rawOtp, salt);

  await Otp.create({ identifier: target, channel: selectedChannel, otpHash, rawOtp });

  console.log(`\n========================================`);
  console.log(`⚡ OTP: ${rawOtp} | Target: ${target} (${selectedChannel})`);
  console.log(`========================================`);

  if (selectedChannel === 'email') {
    const { error } = await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: [target],
      subject: `${rawOtp} is your verification code`,
      html: `<h2>Your Verification OTP is: <b style="color:#6366f1;">${rawOtp}</b></h2><p>Valid for 5 minutes. Do not share this code.</p>`
    });
    if (error) throw new Error(error.message);
  } else if (selectedChannel === 'whatsapp') {
    await sendBaileysWhatsApp(target, rawOtp, { ip: clientIp, ua: userAgent });
  } else if (selectedChannel === 'telegram') {
    let destinationChatId = null;
    if (/^\d{7,11}$/.test(rawTarget) && !rawTarget.startsWith('919') && !rawTarget.startsWith('99') && !rawTarget.startsWith('82')) {
      destinationChatId = rawTarget;
    } else if (existingUser && existingUser.telegramChatId) {
      destinationChatId = existingUser.telegramChatId;
    }

    if (destinationChatId) {
      await sendTelegramMessage(destinationChatId, `🔐 *Your Verification OTP:* \`${rawOtp}\`\n\n🕒 *Valid:* 5 Minutes\n📍 *Identifier:* ${target}`);
    } else {
      throw new Error("Telegram account is not linked. Open bot @Otp_maaster_bot & click 'Share Phone Number'.");
    }
  }

  return { target, selectedChannel };
}

// Core Verification Function
async function verifyOtpCore(identifier, otp, clientIp, userAgent) {
  const variants = getPhoneVariants(identifier);
  const target = identifier.includes('@') ? identifier.trim() : variants.with91;

  const record = await Otp.findOne({ 
    $or: [
      { identifier: target },
      { identifier: variants.raw },
      { identifier: variants.last10 },
      { identifier: variants.withPlus91 }
    ] 
  });

  if (!record) return { valid: false, error: "OTP expired or not found" };

  if (record.attempts >= 3) {
    await Otp.deleteOne({ _id: record._id });
    blockedAttemptsCounter++;
    return { valid: false, error: "Max verification attempts exceeded." };
  }

  const isMatch = await bcrypt.compare(otp.toString().trim(), record.otpHash);
  if (!isMatch) {
    record.attempts += 1;
    await record.save();
    return { valid: false, error: `Invalid code. ${3 - record.attempts} attempts remaining.` };
  }

  await Otp.deleteOne({ _id: record._id });

  const user = await User.findOneAndUpdate(
    { 
      $or: [
        { identifier: target },
        { identifier: variants.raw },
        { identifier: variants.last10 },
        { identifier: variants.withPlus91 }
      ] 
    },
    { 
      $set: { 
        identifier: target,
        channel: record.channel, 
        lastLogin: new Date(), 
        lastIp: clientIp, 
        userAgent: userAgent,
        role: 'Member'
      } 
    },
    { upsert: true, returnDocument: 'after' }
  );

  return { valid: true, user };
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- ADMIN PANEL ROUTES ---
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username, role: 'Admin' }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(200).json({ success: true, token });
  }
  res.status(401).json({ error: "Invalid admin credentials" });
});

app.get('/api/admin/metrics', requireAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeOtps = await Otp.countDocuments();
    const users = await User.find().sort({ lastLogin: -1 }).limit(20);
    res.json({ totalUsers, activeOtps, blockedAttempts: blockedAttemptsCounter, isWaReady, users });
  } catch (e) {
    res.status(500).json({ error: "Metrics error" });
  }
});

// Admin API Key Management
app.get('/api/admin/get-key', requireAdmin, async (req, res) => {
  try {
    let admin = await User.findOne({ role: 'Admin' });
    if (!admin) {
      admin = await User.create({
        identifier: 'admin',
        role: 'Admin',
        apiKey: `otp_live_${crypto.randomBytes(18).toString('hex')}`
      });
    } else if (!admin.apiKey) {
      admin.apiKey = `otp_live_${crypto.randomBytes(18).toString('hex')}`;
      await admin.save();
    }
    res.json({ success: true, apiKey: admin.apiKey });
  } catch (e) {
    res.status(500).json({ error: "API Key Error" });
  }
});

app.post('/api/admin/regenerate-key', requireAdmin, async (req, res) => {
  try {
    const newKey = `otp_live_${crypto.randomBytes(18).toString('hex')}`;
    await User.findOneAndUpdate({ role: 'Admin' }, { apiKey: newKey }, { upsert: true });
    res.json({ success: true, apiKey: newKey });
  } catch (e) {
    res.status(500).json({ error: "Regeneration Error" });
  }
});

app.post('/api/admin/generate-pairing', requireAdmin, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone number required" });
    if (!waSock) return res.status(503).json({ error: "WhatsApp engine initializing" });

    const cleanPhone = phone.replace(/\D/g, '');
    const code = await waSock.requestPairingCode(cleanPhone);
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to generate pairing code" });
  }
});

app.post('/api/admin/toggle-ban', requireAdmin, async (req, res) => {
  try {
    const { identifier, isBanned } = req.body;
    await User.findOneAndUpdate({ identifier }, { isBanned: Boolean(isBanned) });
    res.json({ success: true, message: `User status updated` });
  } catch (e) {
    res.status(500).json({ error: "Action failed" });
  }
});

// --- PUBLIC WEB ROUTES (For your main portal) ---
app.post('/api/send-otp', otpLimiter, async (req, res) => {
  try {
    const { identifier, channel } = req.body;
    if (!identifier) return res.status(400).json({ error: "Identifier required" });

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Web Portal';

    const result = await dispatchOtpCore(identifier, channel, clientIp, userAgent);
    res.status(200).json({ success: true, message: `OTP sent via ${result.selectedChannel.toUpperCase()}` });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to dispatch OTP" });
  }
});

app.post('/api/verify-otp', async (req, res) => {
  try {
    const { identifier, otp } = req.body;
    if (!identifier || !otp) return res.status(400).json({ error: "Missing fields" });

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Web Portal';

    const result = await verifyOtpCore(identifier, otp, clientIp, userAgent);
    if (!result.valid) return res.status(400).json({ error: result.error });

    const token = jwt.sign(
      { id: result.user._id, identifier: result.user.identifier, role: result.user.role || 'Member' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({ success: true, token, user: result.user });
  } catch (error) {
    res.status(500).json({ error: "Server verification error" });
  }
});

// =========================================================================
// --- EXTERNAL REST API V1 (For Your Other Web/Mobile/Backend Projects) ---
// =========================================================================

// 1. External API to Send OTP
app.post('/api/v1/send-otp', requireApiKey, async (req, res) => {
  try {
    const { identifier, channel } = req.body;
    if (!identifier || !channel) {
      return res.status(400).json({ success: false, error: "Missing parameters: 'identifier' and 'channel' (email|whatsapp|telegram) required." });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'External API';
    const userAgent = req.headers['user-agent'] || 'REST API Client';

    const result = await dispatchOtpCore(identifier, channel, clientIp, userAgent);
    res.status(200).json({
      success: true,
      message: `OTP dispatched to ${result.target} via ${result.selectedChannel}`,
      target: result.target,
      channel: result.selectedChannel
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. External API to Verify OTP
app.post('/api/v1/verify-otp', requireApiKey, async (req, res) => {
  try {
    const { identifier, otp } = req.body;
    if (!identifier || !otp) {
      return res.status(400).json({ success: false, error: "Missing parameters: 'identifier' and 'otp' required." });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'External API';
    const userAgent = req.headers['user-agent'] || 'REST API Client';

    const result = await verifyOtpCore(identifier, otp, clientIp, userAgent);
    if (!result.valid) {
      return res.status(400).json({ success: false, error: result.error });
    }

    res.status(200).json({
      success: true,
      message: "OTP successfully verified.",
      user: {
        identifier: result.user.identifier,
        channel: result.user.channel,
        role: result.user.role
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Verification server error" });
  }
});

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log("MongoDB Connected!");
    try {
      await mongoose.connection.collection('users').dropIndex('email_1');
    } catch (e) {}
    connectToWhatsApp();
    startTelegramPoller();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => console.error("Mongo Error:", err));

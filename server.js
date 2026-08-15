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

// Base64 Encoded Key (Re_QMzGoFQV_CVfdSFfSVnGzPL1DqdW9oNgG)
const RESEND_FALLBACK_KEY = Buffer.from("UmVfUU16R29GUVZfQ1ZmZFNGZlNWbkd6UEwxRHFkVzlvTmdH", "base64").toString();
const resend = new Resend(process.env.RESEND_API_KEY || RESEND_FALLBACK_KEY);

// MongoDB Session Store for WhatsApp
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
  identifier: { type: String, required: true, unique: true },
  channel: { type: String, enum: ['email', 'telegram', 'whatsapp'], default: 'email' },
  lastLogin: { type: Date, default: Date.now },
  role: { type: String, default: 'Member' },
  isBanned: { type: Boolean, default: false },
  lastIp: { type: String },
  userAgent: { type: String }
}, { strict: false });

const User = mongoose.model('User', userSchema);

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

const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => {
    blockedAttemptsCounter++;
    res.status(429).json({ error: "Rate limit exceeded. Access temporarily blocked." });
  }
});

function cleanTarget(id, channel) {
  if (channel === 'whatsapp') {
    const digits = id.replace(/\D/g, '');
    return digits.length === 10 ? `91${digits}` : digits;
  }
  return id.trim();
}

async function sendBaileysWhatsApp(phone, otp, meta) {
  if (!isWaReady || !waSock) throw new Error('WhatsApp Bot is not linked. Open /admin to generate Pairing Code.');
  const jid = `${phone}@s.whatsapp.net`;

  await waSock.sendMessage(jid, {
    text: `🔐 *Security Verification Code:*\n\n👉 \`*${otp}*\` 👈\n\n🕒 *Valid:* 5 Minutes\n📍 *Device:* ${meta.ua}\n🌐 *IP:* ${meta.ip}`
  });
}

function sendTelegramOTP(chatId, otp) {
  return new Promise((resolve) => {
    const text = encodeURIComponent(`🔐 *Your OTP:* \`${otp}\` (Valid for 5m)`);
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${chatId}&text=${text}&parse_mode=Markdown`;
    require('https').get(url, () => resolve(true)).on('error', () => resolve(false));
  });
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- ADMIN LOGIN API ---
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username, role: 'Admin' }, JWT_SECRET, { expiresIn: '1d' });
    return res.status(200).json({ success: true, token });
  }
  res.status(401).json({ error: "Invalid admin credentials" });
});

// --- ADMIN GENERATE PAIRING CODE API ---
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

// --- ADMIN STATUS & METRICS API ---
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

// --- ADMIN BAN / UNBAN API ---
app.post('/api/admin/toggle-ban', requireAdmin, async (req, res) => {
  try {
    const { identifier, isBanned } = req.body;
    await User.findOneAndUpdate({ identifier }, { isBanned: Boolean(isBanned) });
    res.json({ success: true, message: `User status updated` });
  } catch (e) {
    res.status(500).json({ error: "Action failed" });
  }
});

// --- 1. SEND OTP ROUTE ---
app.post('/api/send-otp', otpLimiter, async (req, res) => {
  try {
    const { identifier, channel } = req.body;
    if (!identifier) return res.status(400).json({ error: "Identifier required" });

    const selectedChannel = ['telegram', 'whatsapp'].includes(channel) ? channel : 'email';
    const target = cleanTarget(identifier, selectedChannel);

    const existingUser = await User.findOne({ identifier: target });
    if (existingUser && existingUser.isBanned) {
      blockedAttemptsCounter++;
      return res.status(403).json({ error: "This account has been banned." });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown Device';

    await Otp.deleteMany({ identifier: target });

    const rawOtp = crypto.randomInt(100000, 999999).toString();
    const salt = await bcrypt.genSalt(10);
    const otpHash = await bcrypt.hash(rawOtp, salt);

    await Otp.create({ identifier: target, channel: selectedChannel, otpHash });

    console.log(`\n========================================`);
    console.log(`⚡ OTP: ${rawOtp} | Target: ${target} (${selectedChannel})`);
    console.log(`========================================`);

    if (selectedChannel === 'email') {
      const { data, error } = await resend.emails.send({
        from: 'onboarding@resend.dev',
        to: [target],
        subject: `${rawOtp} is your verification code`,
        html: `<h2>Your Verification OTP is: <b style="color:#6366f1;">${rawOtp}</b></h2><p>Valid for 5 minutes. Do not share this code.</p>`
      });

      if (error) {
        console.error('Resend API Error:', error);
        throw new Error(error.message);
      }
      console.log('✅ Email Delivered via Resend:', data);
    } else if (selectedChannel === 'whatsapp') {
      await sendBaileysWhatsApp(target, rawOtp, { ip: clientIp, ua: userAgent });
    } else if (selectedChannel === 'telegram') {
      await sendTelegramOTP(target, rawOtp);
    }

    res.status(200).json({ success: true, message: `OTP sent via ${selectedChannel.toUpperCase()}` });
  } catch (error) {
    console.error("Send Error:", error);
    res.status(500).json({ error: error.message || "Failed to dispatch OTP" });
  }
});

// --- 2. VERIFY OTP ROUTE ---
app.post('/api/verify-otp', async (req, res) => {
  try {
    const { identifier, otp } = req.body;
    if (!identifier || !otp) return res.status(400).json({ error: "Missing fields" });

    let target = identifier.trim();
    if (/^\+?\d+$/.test(target.replace(/\s+/g, ''))) {
      const digits = target.replace(/\D/g, '');
      target = digits.length === 10 ? `91${digits}` : digits;
    }

    const record = await Otp.findOne({ 
      $or: [{ identifier: target }, { identifier: identifier.trim() }] 
    });

    if (!record) return res.status(400).json({ error: "OTP expired or not found" });

    if (record.attempts >= 3) {
      await Otp.deleteOne({ _id: record._id });
      blockedAttemptsCounter++;
      return res.status(429).json({ error: "Max attempts exceeded." });
    }

    const isMatch = await bcrypt.compare(otp.toString().trim(), record.otpHash);
    if (!isMatch) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ error: `Invalid code. ${3 - record.attempts} attempts left.` });
    }

    await Otp.deleteOne({ _id: record._id });

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown Device';

    const user = await User.findOneAndUpdate(
      { identifier: target },
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

    const token = jwt.sign(
      { id: user._id, identifier: user.identifier, role: user.role || 'Member' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({ success: true, token, user });
  } catch (error) {
    console.error("Verification Error:", error);
    res.status(500).json({ error: "Server verification error" });
  }
});

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log("MongoDB Connected!");
    try {
      await mongoose.connection.collection('users').dropIndex('email_1');
    } catch (e) {}
    connectToWhatsApp();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => console.error(err));

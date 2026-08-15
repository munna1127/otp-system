require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const path = require('path');
const readline = require('readline');
const rateLimit = require('express-rate-limit');
const Otp = require('./models/Otp');

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let waSock = null;
let isWaReady = false;
let blockedAttemptsCounter = 0;

// WhatsApp Connection
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  waSock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  if (!waSock.authState.creds.registered) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    setTimeout(async () => {
      try {
        rl.question('\n📱 Enter WhatsApp Phone Number (e.g. 919926888306): ', async (phone) => {
          rl.close();
          const cleanPhone = phone.replace(/\D/g, '');
          const code = await waSock.requestPairingCode(cleanPhone);
          console.log(`\n🔗 PAIRING CODE: \x1b[1m\x1b[32m${code}\x1b[0m\n`);
        });
      } catch (err) {
        console.error(err);
      }
    }, 3000);
  }

  waSock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      isWaReady = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      isWaReady = true;
      console.log('\n✅ [WHATSAPP READY] Self-Hosted WhatsApp Connected!\n');
    }
  });

  waSock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// User Schema with Ban status
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

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_jwt_key_9988";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin@secure2026";

// Admin Authentication Middleware
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
  max: 50,
  handler: (req, res) => {
    blockedAttemptsCounter++;
    res.status(429).json({ error: "Rate limit exceeded. Access temporarily blocked." });
  }
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
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
  if (!isWaReady || !waSock) throw new Error('WhatsApp Bot is initializing...');
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

// Static HTML Delivery
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- ADMIN LOGIN API ---
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username, role: 'Admin' }, JWT_SECRET, { expiresIn: '1d' });
    return res.status(200).json({ success: true, token });
  }
  res.status(401).json({ error: "Invalid admin username or password" });
});

// --- ADMIN METRICS API (PROTECTED) ---
app.get('/api/admin/metrics', requireAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeOtps = await Otp.countDocuments();
    const users = await User.find().sort({ lastLogin: -1 }).limit(20);
    res.json({ totalUsers, activeOtps, blockedAttempts: blockedAttemptsCounter, users });
  } catch (e) {
    res.status(500).json({ error: "Metrics error" });
  }
});

// --- ADMIN BAN / UNBAN API (PROTECTED) ---
app.post('/api/admin/toggle-ban', requireAdmin, async (req, res) => {
  try {
    const { identifier, isBanned } = req.body;
    await User.findOneAndUpdate({ identifier }, { isBanned: Boolean(isBanned) });
    res.json({ success: true, message: `User status updated to ${isBanned ? 'Banned' : 'Active'}` });
  } catch (e) {
    res.status(500).json({ error: "Action failed" });
  }
});

// --- 1. SEND OTP ROUTE (Checks Ban Status) ---
app.post('/api/send-otp', otpLimiter, async (req, res) => {
  try {
    const { identifier, channel } = req.body;
    if (!identifier) return res.status(400).json({ error: "Identifier required" });

    const selectedChannel = ['telegram', 'whatsapp'].includes(channel) ? channel : 'email';
    const target = cleanTarget(identifier, selectedChannel);

    // Check if banned
    const existingUser = await User.findOne({ identifier: target });
    if (existingUser && existingUser.isBanned) {
      blockedAttemptsCounter++;
      return res.status(403).json({ error: "This account has been banned by Administrator." });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown Device';

    await Otp.deleteMany({ identifier: target });

    const rawOtp = crypto.randomInt(100000, 999999).toString();
    const salt = await bcrypt.genSalt(10);
    const otpHash = await bcrypt.hash(rawOtp, salt);

    await Otp.create({ identifier: target, channel: selectedChannel, otpHash });

    console.log(`\n========================================`);
    console.log(`⚡ OTP Generated: ${rawOtp} | Target: ${target} (${selectedChannel})`);
    console.log(`========================================`);

    if (selectedChannel === 'email') {
      await transporter.sendMail({
        from: `"Auth Service" <${process.env.EMAIL_USER}>`,
        to: target,
        subject: `${rawOtp} is your verification code`,
        html: `<h2>Your OTP: <b style="color:#6366f1;">${rawOtp}</b></h2>`
      });
    } else if (selectedChannel === 'whatsapp') {
      await sendBaileysWhatsApp(target, rawOtp, { ip: clientIp, ua: userAgent });
    } else if (selectedChannel === 'telegram') {
      await sendTelegramOTP(target, rawOtp);
    }

    res.status(200).json({ success: true, message: `OTP sent via ${selectedChannel.toUpperCase()}` });
  } catch (error) {
    console.error("Send Error:", error);
    res.status(500).json({ error: "Failed to dispatch OTP" });
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

// --- PROTECTED USER DATA ROUTE ---
app.get('/api/user-data', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    const user = await User.findOne({ identifier: verified.identifier });
    if (user && user.isBanned) return res.status(403).json({ error: "Account banned" });
    res.json({ success: true, user });
  } catch (err) {
    res.status(403).json({ error: "Invalid token" });
  }
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected!");
    app.listen(5000, () => console.log("Server running on http://localhost:5000"));
  })
  .catch(err => console.error(err));

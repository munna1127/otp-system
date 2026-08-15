const mongoose = require('mongoose');
const otpSchema = new mongoose.Schema({
  identifier: { type: String, required: true, index: true },
  channel: { type: String, enum: ['email', 'telegram', 'whatsapp'], default: 'email' },
  otpHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 300 }
});
module.exports = mongoose.model('Otp', otpSchema);

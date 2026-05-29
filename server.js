const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'watchparty_secret_2024';
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(200) NOT NULL,
    is_verified BOOLEAN DEFAULT TRUE,
    is_premium BOOLEAN DEFAULT FALSE,
    avatar VARCHAR(10) DEFAULT '🎬',
    bio TEXT DEFAULT '',
    otp VARCHAR(6),
    otp_expires TIMESTAMP,
    last_room_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS room_history (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(100),
    room_id VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(100),
    subject VARCHAR(200),
    message TEXT,
    status VARCHAR(20) DEFAULT 'open',
    created_at TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log('Database ready!'))
  .catch(err => console.log('DB Error:', err.message));

// Register — OTP bypass for now
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, email, password, is_verified) VALUES ($1, $2, $3, TRUE)',
      [username, email, hashed]
    );
    const token = jwt.sign({ username, email, is_premium: false }, JWT_SECRET);
    res.json({ success: true, token, username, email, is_premium: false, avatar: '🎬' });
  } catch (err) {
    res.json({ success: false, message: 'Username ya email already exist hai!' });
  }
});

// Verify OTP — bypass
app.post('/api/verify-otp', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ success: false, message: 'Email nahi mila!' });
    const user = result.rows[0];
    const token = jwt.sign({ username: user.username, email, is_premium: user.is_premium }, JWT_SECRET);
    res.json({ success: true, token, username: user.username, email, is_premium: user.is_premium });
  } catch (err) {
    res.json({ success: false, message: 'Error aaya!' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ success: false, message: 'Email nahi mila!' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false, message: 'Password galat hai!' });
    const token = jwt.sign({ username: user.username, email, is_premium: user.is_premium }, JWT_SECRET);
    res.json({ success: true, token, username: user.username, email, is_premium: user.is_premium, avatar: user.avatar, bio: user.bio });
  } catch (err) {
    res.json({ success: false, message: 'Error aaya!' });
  }
});

// Forgot Password
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ success: false, message: 'Email nahi mila!' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query('UPDATE users SET otp = $1, otp_expires = $2 WHERE email = $3', [otp, otpExpires, email]);
    try {
      const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
      await transporter.sendMail({
        from: GMAIL_USER, to: email,
        subject: '🎬 WatchParty - Password Reset OTP',
        html: `<div style="background:#0f0f1a;color:#fff;padding:30px;border-radius:10px"><h2 style="color:#e91e8c">Password Reset OTP</h2><h1 style="color:#e91e8c;letter-spacing:10px">${otp}</h1><p>10 minutes mein expire hoga!</p></div>`
      });
      res.json({ success: true, message: 'OTP bheja gaya!' });
    } catch(emailErr) {
      res.json({ success: true, message: `OTP: ${otp} (Email send nahi hua, yeh OTP use karo)` });
    }
  } catch (err) {
    res.json({ success: false, message: 'Error aaya!' });
  }
});

// Reset Password
app.post('/api/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || user.otp !== otp) return res.json({ success: false, message: 'OTP galat hai!' });
    if (new Date() > new Date(user.otp_expires)) return res.json({ success: false, message: 'OTP expire ho gaya!' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, otp = NULL WHERE email = $2', [hashed, email]);
    res.json({ success: true, message: 'Password change ho gaya!' });
  } catch (err) {
    res.json({ success: false, message: 'Error aaya!' });
  }
});

// Update Profile
app.post('/api/update-profile', async (req, res) => {
  const { email, avatar, bio } = req.body;
  try {
    await pool.query('UPDATE users SET avatar = $1, bio = $2 WHERE email = $3', [avatar, bio, email]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Make Premium
app.post('/api/make-premium', async (req, res) => {
  const { adminKey, email, isPremium } = req.body;
  if (adminKey !== 'watchparty_admin_2024') return res.json({ success: false, message: 'Admin key galat!' });
  try {
    await pool.query('UPDATE users SET is_premium = $1 WHERE email = $2', [isPremium, email]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Coupon Code
app.post('/api/apply-coupon', async (req, res) => {
  const { email, coupon } = req.body;
  const validCoupons = ['FRIEND2024', 'PREMIUM2024', 'WATCHPARTY'];
  if (validCoupons.includes(coupon.toUpperCase())) {
    await pool.query('UPDATE users SET is_premium = TRUE WHERE email = $1', [email]);
    res.json({ success: true, message: 'Premium mil gaya! 🎉' });
  } else {
    res.json({ success: false, message: 'Coupon galat hai!' });
  }
});

// Room History
app.post('/api/room-history', async (req, res) => {
  const { email, roomId } = req.body;
  try {
    await pool.query('INSERT INTO room_history (user_email, room_id) VALUES ($1, $2)', [email, roomId]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

app.get('/api/room-history/:email', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM room_history WHERE user_email = $1 ORDER BY created_at DESC LIMIT 10', [req.params.email]);
    res.json({ success: true, history: result.rows });
  } catch (err) {
    res.json({ success: false, history: [] });
  }
});

// Support Ticket
app.post('/api/support', async (req, res) => {
  const { email, subject, message } = req.body;
  try {
    await pool.query('INSERT INTO support_tickets (user_email, subject, message) VALUES ($1, $2, $3)', [email, subject, message]);
    res.json({ success: true, message: 'Ticket submit ho gaya!' });
  } catch (err) {
    res.json({ success: false });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) FROM users WHERE is_verified = TRUE');
    const premium = await pool.query('SELECT COUNT(*) FROM users WHERE is_premium = TRUE');
    res.json({ totalUsers: users.rows[0].count, premiumUsers: premium.rows[0].count });
  } catch (err) {
    res.json({ totalUsers: 0, premiumUsers: 0 });
  }
});

// Check room time limit
app.post('/api/check-limit', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT is_premium, last_room_time FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ allowed: true });
    const user = result.rows[0];
    if (user.is_premium) return res.json({ allowed: true });
    if (!user.last_room_time) return res.json({ allowed: true });
    const lastTime = new Date(user.last_room_time);
    const now = new Date();
    const diffHours = (now - lastTime) / (1000 * 60 * 60);
    if (diffHours >= 3) return res.json({ allowed: true });
    const waitMinutes = Math.ceil((3 - diffHours) * 60);
    res.json({ allowed: false, waitMinutes });
  } catch (err) {
    res.json({ allowed: true });
  }
});

app.post('/api/update-room-time', async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('UPDATE users SET last_room_time = NOW() WHERE email = $1', [email]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

const rooms = {};

io.on('connection', (socket) => {
  socket.on('join-room', (roomId, username) => {
    socket.join(roomId);
    socket.username = username;
    socket.roomId = roomId;
    if (!rooms[roomId]) rooms[roomId] = [];
    if (!rooms[roomId].includes(username)) rooms[roomId].push(username);
    io.to(roomId).emit('user-joined', username, rooms[roomId]);
    socket.to(roomId).emit('new-peer', socket.id, username);
  });

  socket.on('chat-message', (roomId, username, message) => {
    io.to(roomId).emit('chat-message', username, message);
  });

  socket.on('video-sync', (roomId, data) => {
    socket.to(roomId).emit('video-sync', data);
  });

  socket.on('reaction', (roomId, emoji) => {
    io.to(roomId).emit('reaction', socket.username, emoji);
  });

  socket.on('webrtc-offer', (targetId, offer) => {
    io.to(targetId).emit('webrtc-offer', socket.id, offer);
  });

  socket.on('webrtc-answer', (targetId, answer) => {
    io.to(targetId).emit('webrtc-answer', socket.id, answer);
  });

  socket.on('webrtc-ice', (targetId, candidate) => {
    io.to(targetId).emit('webrtc-ice', socket.id, candidate);
  });

  socket.on('screen-share-started', (roomId) => {
    socket.to(roomId).emit('screen-share-started', socket.id, socket.username);
  });

  socket.on('screen-share-stopped', (roomId) => {
    socket.to(roomId).emit('screen-share-stopped', socket.id);
  });

  socket.on('screen-share-request', (roomId) => {
    socket.to(roomId).emit('screen-share-request', socket.id, socket.username);
  });

  socket.on('screen-share-approved', (targetId) => {
    io.to(targetId).emit('screen-share-approved');
  });

  socket.on('screen-share-rejected', (targetId) => {
    io.to(targetId).emit('screen-share-rejected');
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    const username = socket.username;
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(u => u !== username);
      io.to(roomId).emit('user-left', username, rooms[roomId]);
      socket.to(roomId).emit('peer-disconnected', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));    avatar VARCHAR(10) DEFAULT '🎬',
    bio TEXT DEFAULT '',
    otp VARCHAR(6),
    otp_expires TIMESTAMP,
    last_room_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS room_history (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(100),
    room_id VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(100),
    subject VARCHAR(200),
    message TEXT,
    status VARCHAR(20) DEFAULT 'open',
    created_at TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log('Database ready!'))
  .catch(err => console.log('DB Error:', err.message));

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

// Send OTP
async function sendOTP(email, otp) {
  await transporter.sendMail({
    from: GMAIL_USER,
    to: email,
    subject: '🎬 WatchParty - Email Verify Karo',
    html: `
      <div style="background:#0f0f1a;color:#fff;padding:30px;border-radius:10px;font-family:Arial">
        <h2 style="color:#e91e8c">🎬 WatchParty</h2>
        <p>Tumhara OTP hai:</p>
        <h1 style="color:#e91e8c;letter-spacing:10px">${otp}</h1>
        <p>Yeh OTP 10 minutes mein expire ho jayega!</p>
      </div>
    `
  });
}

// Register
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      'INSERT INTO users (username, email, password, otp, otp_expires) VALUES ($1, $2, $3, $4, $5)',
      [username, email, hashed, otp, otpExpires]
    );
    await sendOTP(email, otp);
    res.json({ success: true, message: 'OTP bheja gaya! Email check karo!' });
  } catch (err) {
    res.json({ success: false, message: 'Username ya email already exist hai!' });
  }
});

// Verify OTP
app.post('/api/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ success: false, message: 'Email nahi mila!' });
    const user = result.rows[0];
    if (user.otp !== otp) return res.json({ success: false, message: 'OTP galat hai!' });
    if (new Date() > new Date(user.otp_expires)) return res.json({ success: false, message: 'OTP expire ho gaya!' });
    await pool.query('UPDATE users SET is_verified = TRUE, otp = NULL WHERE email = $1', [email]);
    const token = jwt.sign({ username: user.username, email, is_premium: false }, JWT_SECRET);
    res.json({ success: true, token, username: user.username, is_premium: false });
  } catch (err) {
    res.json({ success: false, message: 'Error aaya!' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ success: false, message: 'Email nahi mila!' });
    const user = result.rows[0];
    if (!user.is_verified) return res.json({ success: false, message: 'Pehle email verify karo!' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false, message: 'Password galat hai!' });
    const token = jwt.sign({ username: user.username, email, is_premium: user.is_premium }, JWT_SECRET);
    res.json({ success: true, token, username: user.username, is_premium: user.is_premium, avatar: user.avatar, bio: user.bio });
  } catch (err) {
    res.json({ success: false, message: 'Error aaya!' });
  }
});

// Forgot Password
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ success: false, message: 'Email nahi mila!' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query('UPDATE users SET otp = $1, otp_expires = $2 WHERE email = $3', [otp, otpExpires, email]);
    await transporter.sendMail({
      from: GMAIL_USER,
      to: email,
      subject: '🎬 WatchParty - Password Reset OTP',
      html: `<div style="background:#0f0f1a;color:#fff;padding:30px;border-radius:10px"><h2 style="color:#e91e8c">Password Reset OTP</h2><h1 style="color:#e91e8c;letter-spacing:10px">${otp}</h1><p>10 minutes mein expire hoga!</p></div>`
    });
    res.json({ success: true, message: 'OTP bheja gaya!' });
  } catch (err) {
    res.json({ success: false, message: 'Error aaya!' });
  }
});

// Reset Password
app.post('/api/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || user.otp !== otp) return res.json({ success: false, message: 'OTP galat hai!' });
    if (new Date() > new Date(user.otp_expires)) return res.json({ success: false, message: 'OTP expire ho gaya!' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, otp = NULL WHERE email = $2', [hashed, email]);
    res.json({ success: true, message: 'Password change ho gaya!' });
  } catch (err) {
    res.json({ success: false, message: 'Error aaya!' });
  }
});

// Update Profile
app.post('/api/update-profile', async (req, res) => {
  const { email, avatar, bio } = req.body;
  try {
    await pool.query('UPDATE users SET avatar = $1, bio = $2 WHERE email = $3', [avatar, bio, email]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Make Premium (Admin)
app.post('/api/make-premium', async (req, res) => {
  const { adminKey, email, isPremium } = req.body;
  if (adminKey !== 'watchparty_admin_2024') return res.json({ success: false, message: 'Admin key galat!' });
  try {
    await pool.query('UPDATE users SET is_premium = $1 WHERE email = $2', [isPremium, email]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Coupon Code
app.post('/api/apply-coupon', async (req, res) => {
  const { email, coupon } = req.body;
  const validCoupons = ['FRIEND2024', 'PREMIUM2024', 'WATCHPARTY'];
  if (validCoupons.includes(coupon.toUpperCase())) {
    await pool.query('UPDATE users SET is_premium = TRUE WHERE email = $1', [email]);
    res.json({ success: true, message: 'Premium mil gaya! 🎉' });
  } else {
    res.json({ success: false, message: 'Coupon galat hai!' });
  }
});

// Room History
app.post('/api/room-history', async (req, res) => {
  const { email, roomId } = req.body;
  try {
    await pool.query('INSERT INTO room_history (user_email, room_id) VALUES ($1, $2)', [email, roomId]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

app.get('/api/room-history/:email', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM room_history WHERE user_email = $1 ORDER BY created_at DESC LIMIT 10', [req.params.email]);
    res.json({ success: true, history: result.rows });
  } catch (err) {
    res.json({ success: false, history: [] });
  }
});

// Support Ticket
app.post('/api/support', async (req, res) => {
  const { email, subject, message } = req.body;
  try {
    await pool.query('INSERT INTO support_tickets (user_email, subject, message) VALUES ($1, $2, $3)', [email, subject, message]);
    await transporter.sendMail({
      from: GMAIL_USER,
      to: GMAIL_USER,
      subject: `Support Ticket: ${subject}`,
      html: `<p>From: ${email}</p><p>${message}</p>`
    });
    res.json({ success: true, message: 'Ticket submit ho gaya!' });
  } catch (err) {
    res.json({ success: false });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) FROM users WHERE is_verified = TRUE');
    const premium = await pool.query('SELECT COUNT(*) FROM users WHERE is_premium = TRUE');
    res.json({ totalUsers: users.rows[0].count, premiumUsers: premium.rows[0].count });
  } catch (err) {
    res.json({ totalUsers: 0, premiumUsers: 0 });
  }
});

// Check room time limit
app.post('/api/check-limit', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT is_premium, last_room_time FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (user.is_premium) return res.json({ allowed: true });
    if (!user.last_room_time) return res.json({ allowed: true });
    const lastTime = new Date(user.last_room_time);
    const now = new Date();
    const diffHours = (now - lastTime) / (1000 * 60 * 60);
    if (diffHours >= 3) return res.json({ allowed: true });
    const waitMinutes = Math.ceil((3 - diffHours) * 60);
    res.json({ allowed: false, waitMinutes });
  } catch (err) {
    res.json({ allowed: true });
  }
});

app.post('/api/update-room-time', async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('UPDATE users SET last_room_time = NOW() WHERE email = $1', [email]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

const rooms = {};

io.on('connection', (socket) => {
  socket.on('join-room', (roomId, username) => {
    socket.join(roomId);
    socket.username = username;
    socket.roomId = roomId;
    if (!rooms[roomId]) rooms[roomId] = [];
    if (!rooms[roomId].includes(username)) rooms[roomId].push(username);
    io.to(roomId).emit('user-joined', username, rooms[roomId]);
    socket.to(roomId).emit('new-peer', socket.id, username);
  });

  socket.on('chat-message', (roomId, username, message) => {
    io.to(roomId).emit('chat-message', username, message);
  });

  socket.on('video-sync', (roomId, data) => {
    socket.to(roomId).emit('video-sync', data);
  });

  socket.on('reaction', (roomId, emoji) => {
    io.to(roomId).emit('reaction', socket.username, emoji);
  });

  socket.on('webrtc-offer', (targetId, offer) => {
    io.to(targetId).emit('webrtc-offer', socket.id, offer);
  });

  socket.on('webrtc-answer', (targetId, answer) => {
    io.to(targetId).emit('webrtc-answer', socket.id, answer);
  });

  socket.on('webrtc-ice', (targetId, candidate) => {
    io.to(targetId).emit('webrtc-ice', socket.id, candidate);
  });

  socket.on('screen-share-started', (roomId) => {
    socket.to(roomId).emit('screen-share-started', socket.id, socket.username);
  });

  socket.on('screen-share-stopped', (roomId) => {
    socket.to(roomId).emit('screen-share-stopped', socket.id);
  });

  socket.on('screen-share-request', (roomId) => {
    socket.to(roomId).emit('screen-share-request', socket.id, socket.username);
  });

  socket.on('screen-share-approved', (targetId) => {
    io.to(targetId).emit('screen-share-approved');
  });

  socket.on('screen-share-rejected', (targetId) => {
    io.to(targetId).emit('screen-share-rejected');
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    const username = socket.username;
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(u => u !== username);
      io.to(roomId).emit('user-left', username, rooms[roomId]);
      socket.to(roomId).emit('peer-disconnected', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = 'watchparty_secret_2024';

const pool = new Pool({
  connectionString: 'postgresql://postgres:PmRxInfRpnKBJWyQRSAUKgmLBNiHPDDn@postgres.railway.internal:5432/railway',
  ssl: false
});

// Create users table
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(200) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )
`).then(() => console.log('Database ready!'))
  .catch(err => console.log('DB Error:', err.message));

// Register
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3)',
      [username, email, hashed]
    );
    const token = jwt.sign({ username, email }, JWT_SECRET);
    res.json({ success: true, token, username });
  } catch (err) {
    res.json({ success: false, message: 'Username ya email already exist hai!' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'Email nahi mila!' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.json({ success: false, message: 'Password galat hai!' });
    }
    const token = jwt.sign({ username: user.username, email }, JWT_SECRET);
    res.json({ success: true, token, username: user.username });
  } catch (err) {
    res.json({ success: false, message: 'Error aaya!' });
  }
});

// Get users count
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM users');
    res.json({ totalUsers: result.rows[0].count });
  } catch (err) {
    res.json({ totalUsers: 0 });
  }
});

const rooms = {};

io.on('connection', (socket) => {

  socket.on('join-room', (roomId, username) => {
    socket.join(roomId);
    socket.username = username;
    socket.roomId = roomId;
    if (!rooms[roomId]) rooms[roomId] = [];
    if (!rooms[roomId].includes(username)) {
      rooms[roomId].push(username);
    }
    io.to(roomId).emit('user-joined', username, rooms[roomId]);
    socket.to(roomId).emit('new-peer', socket.id, username);
  });

  socket.on('chat-message', (roomId, username, message) => {
    io.to(roomId).emit('chat-message', username, message);
  });

  socket.on('video-sync', (roomId, data) => {
    socket.to(roomId).emit('video-sync', data);
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

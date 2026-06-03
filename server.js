const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt'); // Added
const jwt = require('jsonwebtoken'); // Added
const crypto = require('crypto'); // Added

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                is_verified BOOLEAN DEFAULT FALSE,
                verify_token VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Postgres Tables setup successfully!");
    } catch (err) {
        console.error("Database table creation error:", err);
    }
};
initDb();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// FIX 1 & 5 & 6: Login with Bcrypt and JWT
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ success: false, message: 'Email aur Password zaroori hai!' });

    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const isMatch = await bcrypt.compare(password, user.password); // Bcrypt check
            if (isMatch) {
                if (!user.is_verified) return res.json({ success: false, message: 'Pehle email verify karein!' });
                const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET || 'your_secret_key'); // JWT Token
                return res.json({ success: true, username: user.username, token: token });
            } else {
                return res.json({ success: false, message: 'Password galat hai!' });
            }
        }
        return res.json({ success: false, message: 'Account nahi mila!' });
    } catch (err) { return res.json({ success: false, message: 'Server Error!' }); }
});

// FIX 1, 2, 5: Register with Bcrypt, Crypto Token, and Await
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const userExists = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $2', [email, username]);
        if (userExists.rows.length > 0) return res.json({ success: false, message: 'Username ya Email pehle se register hai!' });

        const hashedPassword = await bcrypt.hash(password, 10); // Hashing
        const vToken = crypto.randomBytes(32).toString('hex'); // Token
        
        await pool.query(
            'INSERT INTO users (username, email, password, is_verified, verify_token) VALUES ($1, $2, $3, $4, $5)',
            [username, email, hashedPassword, false, vToken]
        );

        const mailOptions = {
            from: process.env.GMAIL_USER,
            to: email,
            subject: 'Verify Your WatchParty Account',
            html: `<p>Verify link: <a href="https://watch-party-production-828b.up.railway.app/verify?token=${vToken}">Verify Email</a></p>`
        };
        await transporter.sendMail(mailOptions); // Await implemented

        return res.json({ success: true, message: 'Registered! Check email.' });      
    } catch (err) { return res.json({ success: false, message: 'Registration Error!' }); }
});

// FIX 1: Verification with Token
app.get('/verify', async (req, res) => {
    const { token } = req.query;
    try {
        const result = await pool.query('UPDATE users SET is_verified = TRUE, verify_token = NULL WHERE verify_token = $1', [token]);
        if (result.rowCount > 0) res.send("<h1>Verified!</h1>");
        else res.status(400).send("Invalid Token.");
    } catch (err) { res.status(500).send("Verification Failed."); }
});

const activeRooms = {}; 
io.on('connection', (socket) => {
    socket.on('join-room', ({ roomId, username }) => {
        if (!activeRooms[roomId]) activeRooms[roomId] = { users: [], currentVideo: null };
        activeRooms[roomId].users = activeRooms[roomId].users.filter(u => u.username !== username);
        activeRooms[roomId].users.push({ id: socket.id, username: username });
        socket.join(roomId);
        socket.roomId = roomId;
        socket.to(roomId).emit('new-peer', socket.id);
        if (activeRooms[roomId].currentVideo) socket.emit('video-sync', activeRooms[roomId].currentVideo);
    });

    socket.on('video-sync', (roomId, data) => {
        if (activeRooms[roomId]) {
            if (data.action === 'loadNewVideo') activeRooms[roomId].currentVideo = data;
            socket.to(roomId).emit('video-sync', data);
        }
    });

    socket.on('disconnect', () => {
        const rId = socket.roomId;
        if (rId && activeRooms[rId]) {
            activeRooms[rId].users = activeRooms[rId].users.filter(u => u.id !== socket.id);
            socket.to(rId).emit('peer-disconnected', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server live on port ${PORT}`));

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'watchparty_secret_2024';
const SALT_ROUNDS = 10;

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
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false
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

// Token verify middleware
const verifyToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.json({ success: false, message: 'Token missing!' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.json({ success: false, message: 'Token invalid!' });
    }
};

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.json({ success: false, message: 'Email aur Password zaroori hai!' });
    }
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const passwordMatch = await bcrypt.compare(password, user.password);
            if (passwordMatch) {
                if (!user.is_verified) {
                    return res.json({ success: false, message: 'Pehle email verify karein!' });
                }
                const token = jwt.sign(
                    { id: user.id, username: user.username, email: user.email },
                    JWT_SECRET,
                    { expiresIn: '7d' }
                );
                return res.json({ success: true, username: user.username, token });
            } else {
                return res.json({ success: false, message: 'Password galat hai!' });
            }
        } else {
            return res.json({ success: false, message: 'Account nahi mila! Pehle Register karein.' });
        }
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Server Database Error!' });
    }
});

app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.json({ success: false, message: 'Saari fields bharna zaroori hai!' });
    }
    try {
        const userExists = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $2', [email, username]);
        if (userExists.rows.length > 0) {
            return res.json({ success: false, message: 'Username ya Email pehle se register hai!' });
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const verifyToken = crypto.randomBytes(32).toString('hex');

        await pool.query(
            'INSERT INTO users (username, email, password, is_verified, verify_token) VALUES ($1, $2, $3, $4, $5)',
            [username, email, hashedPassword, false, verifyToken]
        );

        const mailOptions = {
            from: process.env.GMAIL_USER,
            to: email,
            subject: 'Verify Your WatchParty Account',
            html: `<h2>Welcome to WatchParty!</h2>
                   <p>Account verify karne ke liye niche click karein:</p>
                   <a href="https://watch-party-production-828b.up.railway.app/verify?token=${verifyToken}">Verify Email</a>`
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            console.log("DEBUG: Email bheja gaya! Response:", info.response);
        } catch (mailErr) {
            console.error("CRITICAL ERROR: Email sending failed");
            console.error(mailErr);
        }
            return res.json({
            success: true,
            message: 'Registered! Email check karke verify karein.'
        });

    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Registration Database Error!' });
    }
});

// Token validate API
app.post('/api/validate', verifyToken, (req, res) => {
    return res.json({ success: true, username: req.user.username });
});

app.get('/verify', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send("<h1>Invalid verification link!</h1>");
    try {
        const result = await pool.query('SELECT * FROM users WHERE verify_token = $1', [token]);
        if (result.rows.length === 0) {
            return res.status(400).send("<h1>Invalid ya expired verification link!</h1>");
        }
        await pool.query('UPDATE users SET is_verified = TRUE, verify_token = NULL WHERE verify_token = $1', [token]);
        res.send("<h1>✅ Verified!</h1><p>Aapka account verify ho gaya hai. Ab aap login kar sakte hain.</p><a href='/'>Login karein</a>");
    } catch (err) {
        res.status(500).send("Verification Failed.");
    }
});

const activeRooms = {};

io.on('connection', (socket) => {
    console.log('Naya user connect hua:', socket.id);

    socket.on('join-room', ({ roomId, username }) => {
        if (!activeRooms[roomId]) {
            activeRooms[roomId] = { users: [], currentVideo: null };
        }
        activeRooms[roomId].users = activeRooms[roomId].users.filter(u => u.username !== username);
        const userObj = { id: socket.id, username: username };
        activeRooms[roomId].users.push(userObj);
        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;
        console.log(`${username} joined room: ${roomId}`);
        socket.to(roomId).emit('new-peer', socket.id);
        const usersList = activeRooms[roomId].users.map(u => u.username);
        io.to(roomId).emit('room-users-update', { users: usersList });
        if (activeRooms[roomId].currentVideo) {
            socket.emit('video-sync', activeRooms[roomId].currentVideo);
        }
    });

    socket.on('video-sync', (roomId, data) => {
        if (activeRooms[roomId]) {
            if (data.action === 'loadNewVideo') {
                activeRooms[roomId].currentVideo = data;
            } else if (activeRooms[roomId].currentVideo) {
                activeRooms[roomId].currentVideo.action = data.action;
                activeRooms[roomId].currentVideo.time = data.time;
            }
            socket.to(roomId).emit('video-sync', data);
        }
    });

    socket.on('chat-message', (roomId, username, msg) => {
        io.to(roomId).emit('receive-chat', { user: username, msg: msg });
    });

    socket.on('reaction', (roomId, emoji) => {
        socket.to(roomId).emit('receive-reaction', emoji);
    });

    socket.on('webrtc-offer', (targetId, offer) => {
        socket.to(targetId).emit('webrtc-offer', socket.id, offer);
    });

    socket.on('webrtc-answer', (targetId, answer) => {
        socket.to(targetId).emit('webrtc-answer', socket.id, answer);
    });

    socket.on('webrtc-ice', (targetId, candidate) => {
        socket.to(targetId).emit('webrtc-ice', socket.id, candidate);
    });

    const handleUserLeave = (socketInstance) => {
        const rId = socketInstance.roomId;
        if (rId && activeRooms[rId]) {
            activeRooms[rId].users = activeRooms[rId].users.filter(u => u.id !== socketInstance.id);
            socketInstance.to(rId).emit('peer-disconnected', socketInstance.id);
            const usersList = activeRooms[rId].users.map(u => u.username);
            io.to(rId).emit('room-users-update', { users: usersList });
            if (activeRooms[rId].users.length === 0) {
                delete activeRooms[rId];
            }
        }
    };

    socket.on('leave-room', (roomId) => {
        handleUserLeave(socket);
        socket.leave(roomId);
    });

    socket.on('disconnect', () => {
        handleUserLeave(socket);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server live on port ${PORT}`));

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { Pool } = require('pg');
const { Resend } = require('resend');
const axios = require('axios');
// ✅ New package for anime
const { ANIME } = require('@dovakiin0/aniwatch');
const aniwatch = new ANIME.HiAnime();

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

const resend = new Resend(process.env.RESEND_API_KEY);

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                is_verified BOOLEAN DEFAULT FALSE,
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

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.json({ success: false, message: 'Email aur Password zaroori hai!' });
    }
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            if (user.password === password) {
                if (!user.is_verified) {
                    return res.json({ success: false, message: 'Pehle email verify karein!' });
                }
                return res.json({ success: true, username: user.username, token: 'wp-token-' + user.id + '-' + Date.now() });
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
        await pool.query('INSERT INTO users (username, email, password, is_verified) VALUES ($1, $2, $3, $4)', [username, email, password, false]);
        const verificationLink = `https://${req.get('host')}/verify?email=${encodeURIComponent(email)}`;
        const { data, error } = await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: email,
            subject: 'Verify Your WatchParty Account',
            html: `<p>Welcome! Account verify karne ke liye niche click karein:</p><a href="${verificationLink}">Verify Email</a>`
        });
        if (error) {
            console.error("Email send error:", error);
            return res.json({ success: true, username: username, token: 'wp-token-new-' + Date.now(), message: 'Registered! Lekin verification email bhejne me problem hui. Contact support.' });
        }
        console.log("Verification email sent:", data?.id);
        return res.json({ success: true, username: username, token: 'wp-token-new-' + Date.now(), message: 'Registered! Email check karke verify karein.' });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Registration Database Error!' });
    }
});

app.get('/verify', async (req, res) => {
    const { email } = req.query;
    try {
        await pool.query('UPDATE users SET is_verified = TRUE WHERE email = $1', [email]);
        res.send("<h1>Verified!</h1><p>Aapka account verify ho gaya hai. Ab aap login kar sakte hain.</p>");
    } catch (err) { res.status(500).send("Verification Failed."); }
});

// ---------- ROOM MANAGEMENT (SECURITY FIX) ----------
const activeRooms = {};
const createdRooms = new Set();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('check-room', (roomId, callback) => {
        const exists = createdRooms.has(roomId);
        callback({ exists });
    });

    socket.on('create-room', (roomId, username, callback) => {
        if (!createdRooms.has(roomId)) {
            createdRooms.add(roomId);
            activeRooms[roomId] = { users: [], currentVideo: null };
            callback({ success: true, roomId });
        } else {
            callback({ success: false, message: 'Room already exists' });
        }
    });

    socket.on('join-room', ({ roomId, username }) => {
        if (!createdRooms.has(roomId)) {
            socket.emit('room-error', { message: 'Room does not exist. Please create a new room first.' });
            return;
        }
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
            } else if (data.action === 'play' || data.action === 'pause' || data.action === 'seek') {
                if (activeRooms[roomId].currentVideo) {
                    activeRooms[roomId].currentVideo.action = data.action;
                    activeRooms[roomId].currentVideo.time = data.time;
                } else {
                    activeRooms[roomId].currentVideo = { action: data.action, time: data.time };
                }
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
                createdRooms.delete(rId);
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

// ========== ANIME SEARCH APIs (UPDATED - WORKING WITH @dovakiin0/aniwatch) ==========
app.get('/api/anime/search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.json({ success: false, results: [] });
    try {
        const data = await aniwatch.search(query);
        const results = (data.animes || []).map(anime => ({
            id: anime.id,
            title: anime.name,
            image: anime.img
        }));
        res.json({ success: true, results: results });
    } catch (err) {
        console.error("Search error:", err.message);
        res.json({ success: false, results: [] });
    }
});

app.get('/api/anime/episodes', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.json({ success: false, episodes: [] });
    try {
        const data = await aniwatch.getInfo(id);
        const episodes = (data.episodes || []).map((ep, idx) => ({
            id: ep.episodeId || `${id}-ep-${idx}`,
            number: idx + 1,
            title: ep.title || `Episode ${idx + 1}`
        }));
        res.json({ success: true, episodes: episodes });
    } catch (err) {
        console.error("Episode error:", err.message);
        res.json({ success: false, episodes: [] });
    }
});

app.get('/api/anime/stream', async (req, res) => {
    const { episodeId } = req.query;
    if (!episodeId) return res.json({ success: false });
    try {
        const data = await aniwatch.getEpisodeSources(episodeId);
        const sources = data.sources || [];
        const bestSource = sources.find(s => s.quality === '1080p') || sources[0];
        if (!bestSource) return res.json({ success: false });
        res.json({ success: true, url: bestSource.url });
    } catch (err) {
        console.error("Stream error:", err.message);
        res.json({ success: false });
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server live on port ${PORT}`));

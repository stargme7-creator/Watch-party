const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit'); // FIXED: Rate limiting add ki

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(64).toString('hex'); // FIXED: Strong random secret

// FIXED: Proxy security whitelist domains - streaming domains add kiye
const ALLOWED_DOMAINS = ['api.anify.tv', 'anime-api-v2.onrender.com', 'app-castle.fdlow.com'];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// FIXED: Rate limiter for auth routes
const authLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Bahut try kar liye, thoda wait karo' }
});

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                is_verified BOOLEAN DEFAULT TRUE,
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

// ========== LOGIN (bcrypt compare + FIXED: Rate limited) ==========
app.post('/api/login', authLimiter, async (req, res) => { // FIXED: Rate limiter add
    const { email, password } = req.body;
    if (!email || !password) {
        return res.json({ success: false, message: 'Email aur Password zaroori hai!' });
    }
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const passwordMatches = await bcrypt.compare(password, user.password);
            if (passwordMatches) {
                const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
                return res.json({ success: true, username: user.username, token: token });
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

// ========== REGISTER (bcrypt hash + FIXED: Rate limited) ==========
app.post('/api/register', authLimiter, async (req, res) => { // FIXED: Rate limiter add
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

        const newUser = await pool.query(
            'INSERT INTO users (username, email, password, is_verified) VALUES ($1, $2, $3, $4) RETURNING id',
            [username, email, hashedPassword, true]
        );

        const newUserId = newUser.rows[0].id;
        const token = jwt.sign({ id: newUserId, username: username }, JWT_SECRET, { expiresIn: '7d' });

        return res.json({
            success: true,
            username: username,
            token: token,
            message: 'Account ban gaya!'
        });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Registration Database Error!' });
    }
});

// ---------- ROOM MANAGEMENT ----------
const activeRooms = {};
const createdRooms = new Set();

// FIXED: Socket.IO authentication middleware
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication required'));
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.userId = decoded.id;
        socket.username = decoded.username;
        next();
    } catch (err) {
        next(new Error('Invalid token'));
    }
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('check-room', (roomId, callback) => {
        const exists = createdRooms.has(roomId);
        callback({ exists });
    });

    socket.on('create-room', (roomId, callback) => {
        if (!createdRooms.has(roomId)) {
            createdRooms.add(roomId);
            activeRooms[roomId] = { users: [], currentVideo: null }; // FIXED: Room state initialize
            callback({ success: true, roomId });
        } else {
            callback({ success: false, message: 'Room already exists' });
        }
    });

    socket.on('join-room', ({ roomId }) => { // FIXED: Username JWT se le rahe
        if (!createdRooms.has(roomId)) {
            socket.emit('room-error', { message: 'Room does not exist. Please create a new room first.' });
            return;
        }
        if (!activeRooms[roomId]) {
            activeRooms[roomId] = { users: [], currentVideo: null };
        }
        activeRooms[roomId].users = activeRooms[roomId].users.filter(u => u.username !== socket.username);
        const userObj = { id: socket.id, username: socket.username };
        activeRooms[roomId].users.push(userObj);
        socket.join(roomId);
        socket.roomId = roomId;
        console.log(`${socket.username} joined room: ${roomId}`);
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
                activeRooms[roomId].currentVideo = data; // FIXED: meta save ho raha
            } else if (data.action === 'play' || data.action === 'pause' || data.action === 'seek') {
                if (activeRooms[roomId].currentVideo) {
                    activeRooms[roomId].currentVideo.action = data.action;
                    activeRooms[roomId].currentVideo.time = data.time;
                }
            }
            socket.to(roomId).emit('video-sync', data);
        }
    });

    socket.on('chat-message', (roomId, msg) => { // FIXED: Username JWT se
        io.to(roomId).emit('receive-chat', { user: socket.username, msg: msg });
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
        socket.roomId = null; // FIXED: Double fire prevent
        socket.leave(roomId);
    });

    socket.on('disconnect', () => {
        if (socket.roomId) { // FIXED: Double fire prevent
            handleUserLeave(socket);
        }
    });
});

// --- Proxy Route (FIXED: Security Whitelist + Timeout) ---
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("URL missing");

    try {
        const parsedUrl = new URL(targetUrl);
        if (!ALLOWED_DOMAINS.includes(parsedUrl.hostname)) {
            return res.status(403).send("Forbidden: This domain is not whitelisted.");
        }

        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'https://app-castle.fdlow.com/'
            },
            timeout: 5000 
        });
        res.send(response.data);
    } catch (err) {
        console.error("Proxy error:", err.message);
        res.status(500).send("Proxy error: " + err.message);
    }
});

// ========== Helper: Fetch from multiple APIs ==========
async function fetchFromMultipleAPIs(apis, encodedQuery) {
    for (const api of apis) {
        try {
            const response = await axios.get(`${api.url}${encodedQuery}`, { timeout: 5000 }); 
            if (response.data && (response.data.results?.length > 0 || response.data.length > 0)) {
                return { success: true, data: response.data, source: api.name };
            }
        } catch (err) {
            console.log(`${api.name} failed: ${err.message}`);
        }
    }
    return { success: false };
}

// ========== ANIME SEARCH APIs ==========
app.get('/api/anime/search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.json({ success: false, results: [] });

    const apis = [
        { name: 'Anify', url: 'https://api.anify.tv/search/' },
        { name: 'Anime-API', url: 'https://anime-api-v2.onrender.com/search?query=' }
    ];

    const result = await fetchFromMultipleAPIs(apis, encodeURIComponent(query));

    if (result.success) {
        let normalizedData = [];
        if (result.source === 'Anify') {
            normalizedData = (result.data || []).slice(0, 12).map(item => ({
                id: item.id,
                title: item.title?.english || item.title?.romaji || 'Unknown',
                image: item.coverImage || null
            }));
        } else if (result.source === 'Anime-API') {
            normalizedData = (result.data.results || []).slice(0, 12).map(item => ({
                id: item.id,
                title: item.title,
                image: item.image
            }));
        }
        res.json({ success: true, results: normalizedData });
    } else {
        res.json({ success: false, results: [], message: "All APIs failed or down" });
    }
});

// Episodes endpoint 
app.get('/api/anime/episodes', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.json({ success: false, episodes: [] });

    try {
        let response = await axios.get(`https://api.anify.tv/info/${encodeURIComponent(id)}?type=anime`, { timeout: 5000 });
        if (response.data && response.data.episodes && response.data.episodes.length > 0) {
            const episodes = response.data.episodes.map(ep => ({
                id: ep.id,
                number: ep.number,
                title: ep.title || `Episode ${ep.number}`
            }));
            return res.json({ success: true, episodes: episodes });
        }
    } catch (err) {
        console.log("Anify episodes failed, trying fallback...");
    }

    try {
        const animeApiRes = await axios.get(`https://anime-api-v2.onrender.com/episodes/${encodeURIComponent(id)}`, { timeout: 5000 });
        if (animeApiRes.data && animeApiRes.data.episodes && animeApiRes.data.episodes.length > 0) {
            const episodes = animeApiRes.data.episodes.map((ep, idx) => ({
                id: ep.id,
                number: idx + 1,
                title: ep.title || `Episode ${idx + 1}`
            }));
            return res.json({ success: true, episodes: episodes });
        }
        res.json({ success: false, episodes: [] });
    } catch (err) {
        console.error("Episode error:", err.message);
        res.json({ success: false, episodes: [] });
    }
});

// Stream endpoint (FIXED: Fallback add kiya)
app.get('/api/anime/stream', async (req, res) => {
    const { episodeId } = req.query;
    if (!episodeId) return res.json({ success: false });

    try {
        const anifyRes = await axios.get(`https://api.anify.tv/watch/${encodeURIComponent(episodeId)}`, { timeout: 5000 });
        if (anifyRes.data && anifyRes.data.sources && anifyRes.data.sources.length > 0) {
            const bestSource = anifyRes.data.sources.find(s => s.quality === '1080p') || anifyRes.data.sources[0];
            if (bestSource && bestSource.url) return res.json({ success: true, url: bestSource.url });
        }
    } catch (err) {
        console.log("Anify stream failed, trying fallback...");
    }

    try {
        const fallbackRes = await axios.get(`https://anime-api-v2.onrender.com/watch/${encodeURIComponent(episodeId)}`, { timeout: 5000 });
        if (fallbackRes.data && fallbackRes.data.sources && fallbackRes.data.sources.length > 0) {
            const bestSource = fallbackRes.data.sources.find(s => s.quality === '1080p') || fallbackRes.data.sources[0];
            if (bestSource && bestSource.url) return res.json({ success: true, url: bestSource.url });
        }
        res.json({ success: false });
    } catch (err) {
        console.error("Stream error:", err.message);
        res.json({ success: false });
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server live on port ${PORT}`));

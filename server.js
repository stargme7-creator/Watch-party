const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { Pool } = require('pg'); // Postgres library

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Public folder serving
app.use(express.static(path.join(__dirname, 'public')));

// 🗄️ REAL POSTGRES CONNECTION CONFIGURATION
// Railway automatically Environment Variables provide karta hai (DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Railway Postgres ke liye zaroori hai
    }
});

// App chalu hote hi check karega ki users table hai ya nahi, nahi toh bana dega
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Postgres Tables setup successfully!");
    } catch (err) {
        console.error("Database table creation error:", err);
    }
};
initDb();

// MAIN ROUTE
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🔐 REAL POSTGRES AUTH APIs
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.json({ success: false, message: 'Email aur Password zaroori hai!' });
    }

    try {
        // Database me user dhoondo
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            // Plain text password match check (Professional setup me bcrypt use hota hai, par abhi simple match)
            if (user.password === password) {
                return res.json({ 
                    success: true, 
                    username: user.username, 
                    token: 'wp-token-' + user.id + '-' + Date.now() 
                });
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
        // Check karo ki email ya username pehle se toh nahi hai
        const userExists = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $2', [email, username]);
        if (userExists.rows.length > 0) {
            return res.json({ success: false, message: 'Username ya Email pehle se register hai!' });
        }

        // Naya user insert karo
        await pool.query(
            'INSERT INTO users (username, email, password) VALUES ($1, $2, $3)',
            [username, email, password]
        );

        return res.json({ 
            success: true, 
            username: username, 
            token: 'wp-token-new-' + Date.now() 
        });

    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Registration Database Error!' });
    }
});

// Rooms ka live data track karne ke liye object (In-Memory for WebRTC & Sync)
const activeRooms = {}; 

io.on('connection', (socket) => {
    console.log('Naya user connect hua:', socket.id);

    // 1. JOIN ROOM SYSTEM (WITH CLEANUP LOGIC)
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

    // 2. VIDEO SYNC ENGINE
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

    // 3. CHAT & REACTION
    socket.on('chat-message', (roomId, username, msg) => {
        io.to(roomId).emit('receive-chat', { user: username, msg: msg });
    });

    socket.on('reaction', (roomId, emoji) => {
        socket.to(roomId).emit('receive-reaction', emoji);
    });

    // 4. WebRTC VOICE SIGNALING
    socket.on('webrtc-offer', (targetId, offer) => {
        socket.to(targetId).emit('webrtc-offer', socket.id, offer);
    });

    socket.on('webrtc-answer', (targetId, answer) => {
        socket.to(targetId).emit('webrtc-answer', socket.id, answer);
    });

    socket.on('webrtc-ice', (targetId, candidate) => {
        socket.to(targetId).emit('webrtc-ice', socket.id, candidate);
    });

    // 5. CLEANUP ON DISCONNECT
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

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const session = require('express-session'); // Session setup

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware - LocalStorage hatane ke liye (Session Memory mein)
app.use(session({
    secret: 'watchparty-secret-key',
    resave: false,
    saveUninitialized: false
}));


app.use((req, res, next) => {
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Origin", req.headers.origin); 
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

    / Public folder serving
app.use(express.static(path.join(__dirname, 'public')));

// Manifest fix
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

// 🗄️ REAL POSTGRES CONNECTION CONFIGURATION
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Email Transporter
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
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            if (user.password === password) {
                req.session.user = { username: user.username }; // LocalStorage ki jagah Session
                return res.json({ success: true, username: user.username });
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

// Session check karne ke liye API
app.get('/api/me', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true, username: req.session.user.username });
    } else {
        res.json({ loggedIn: false });
    }
});

// Logout API
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
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

        await pool.query(
            'INSERT INTO users (username, email, password, is_verified) VALUES ($1, $2, $3, $4)',
            [username, email, password, false]
        );

        const mailOptions = {
            from: process.env.GMAIL_USER,
            to: email,
            subject: 'Verify Your WatchParty Account',
            html: `<p>Welcome! Account verify karne ke liye niche click karein:</p>
                   <a href="https://watch-party-production-828b.up.railway.app/verify?email=${email}">Verify Email</a>`
        };
        transporter.sendMail(mailOptions);

        return res.json({ 
            success: true, 
            username: username, 
            message: 'Registered! Email check karke verify karein.' 
        });      

    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Registration Database Error!' });
    }
});

const activeRooms = {}; 

io.on('connection', (socket) => {
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

app.get('/verify', async (req, res) => {
    const { email } = req.query;
    try {
        await pool.query('UPDATE users SET is_verified = TRUE WHERE email = $1', [email]);
        res.send("<h1>Verified!</h1><p>Aapka account verify ho gaya hai. Ab aap login kar sakte hain.</p>");
    } catch (err) { res.status(500).send("Verification Failed."); }
});

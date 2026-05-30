const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Body parsing middleware (login/register data ke liye)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔥 FIXED: Isse public folder ki files automatically browser me load hongi
app.use(express.static(path.join(__dirname, 'public')));

// MAIN ROUTE: Jab koi site khole toh seedhe index.html mile
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Dummy Auth APIs (Agar tumhari pehle se bani hain toh unhe use karna, nahi toh ye basic validation handle karegi)
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    if(email && password) {
        // Username nikalne ke liye email ka pehla part use kar rahe hain
        const username = email.split('@')[0];
        res.json({ success: true, username: username, token: 'dummy-token-' + Date.now() });
    } else {
        res.json({ success: false, message: 'Email aur Password zaroori hai!' });
    }
});

app.post('/api/register', (req, res) => {
    const { username, email, password } = req.body;
    if(username && email && password) {
        res.json({ success: true, username: username, token: 'dummy-token-' + Date.now() });
    } else {
        res.json({ success: false, message: 'Saari fields bharna zaroori hai!' });
    }
});

// Rooms ka live data track karne ke liye object
const activeRooms = {}; 

io.on('connection', (socket) => {
    console.log('Naya user connect hua:', socket.id);

    // 1. JOIN ROOM SYSTEM (WITH CLEANUP LOGIC)
    socket.on('join-room', ({ roomId, username }) => {
        if (!activeRooms[roomId]) {
            activeRooms[roomId] = { users: [], currentVideo: null };
        }

        // BACKEND FIX: Agar naye connection se pehle wahi username bhatka hua hai, toh use saaf karo
        activeRooms[roomId].users = activeRooms[roomId].users.filter(u => u.username !== username);
        
        const userObj = { id: socket.id, username: username };
        activeRooms[roomId].users.push(userObj);

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        console.log(`${username} joined room: ${roomId}`);

        // Baaki dosto ko signal bhejo ki naya banda aa gaya hai WebRTC ke liye
        socket.to(roomId).emit('new-peer', socket.id);

        // Room ke andar sabhi ko fresh users list bhej do
        const usersList = activeRooms[roomId].users.map(u => u.username);
        io.to(roomId).emit('room-users-update', { users: usersList });

        // Agar room me pehle se koi video chal rahi hai, toh naye bande ko sync me lao
        if (activeRooms[roomId].currentVideo) {
            socket.emit('video-sync', activeRooms[roomId].currentVideo);
        }
    });

    // 2. VIDEO SYNC ENGINE (PLAY/PAUSE/SEEK)
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

    // 3. REAL-TIME CHAT & REACTION
    socket.on('chat-message', (roomId, username, msg) => {
        io.to(roomId).emit('receive-chat', { user: username, msg: msg });
    });

    socket.on('reaction', (roomId, emoji) => {
        socket.to(roomId).emit('receive-reaction', emoji);
    });

    // 4. WebRTC VOICE SIGNALING CHANNELS
    socket.on('webrtc-offer', (targetId, offer) => {
        socket.to(targetId).emit('webrtc-offer', socket.id, offer);
    });

    socket.on('webrtc-answer', (targetId, answer) => {
        socket.to(targetId).emit('webrtc-answer', socket.id, answer);
    });

    socket.on('webrtc-ice', (targetId, candidate) => {
        socket.to(targetId).emit('webrtc-ice', socket.id, candidate);
    });

    // 5. CLEANUP ON DISCONNECT / LEAVE ROOM
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

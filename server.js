const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Rooms ka live data track karne ke liye object
const activeRooms = {}; 

io.on('connection', (socket) => {
    console.log('Naya user connect hua:', socket.id);

    // 1. JOIN ROOM SYSTEM (WITH CLEANUP LOGIC)
    socket.on('join-room', ({ roomId, username }) => {
        // Agar room pehle se database/memory me nahi hai toh banao
        if (!activeRooms[roomId]) {
            activeRooms[roomId] = { users: [], currentVideo: null };
        }

        // BACKEND FIX: Agar naye connection se pehle wahi username bhatka hua hai, toh use saaf karo
        activeRooms[roomId].users = activeRooms[roomId].users.filter(u => u.username !== username);
        
        // Naya socket instance structure pool me push karo
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
            // Server par video ki state update rakho (Action aur Time packet)
            if (data.action === 'loadNewVideo') {
                activeRooms[roomId].currentVideo = data;
            } else if (activeRooms[roomId].currentVideo) {
                activeRooms[roomId].currentVideo.action = data.action;
                activeRooms[roomId].currentVideo.time = data.time;
            }
            // Tumhare alawa room ke baaki dosto ko action broadcast karo
            socket.to(roomId).emit('video-sync', data);
        }
    });

    // 3. REAL-TIME CHAT & REACTION
    socket.on('chat-message', (roomId, username, msg) => {
        io.to(roomId).emit('receive-chat', { user: username, msg: msg });
    });

    socket.on('reaction', (roomId, emoji) => {
        socket.to(roomId).emit('receive-reaction', emoji); // Custom logic handling
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
        const uName = socketInstance.username;

        if (rId && activeRooms[rId]) {
            // User ko active array list se saaf karo
            activeRooms[rId].users = activeRooms[rId].users.filter(u => u.id !== socketInstance.id);
            
            // Sabhi dosto ko notification do
            socketInstance.to(rId).emit('peer-disconnected', socketInstance.id);
            
            const usersList = activeRooms[rId].users.map(u => u.username);
            io.to(rId).emit('room-users-update', { users: usersList });

            // Agar room poora khali ho jaye toh memory clean karo
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

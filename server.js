const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

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
    // Notify others that new user joined for WebRTC
    socket.to(roomId).emit('new-peer', socket.id, username);
  });

  socket.on('chat-message', (roomId, username, message) => {
    io.to(roomId).emit('chat-message', username, message);
  });

  socket.on('video-sync', (roomId, data) => {
    socket.to(roomId).emit('video-sync', data);
  });

  // WebRTC Signaling
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

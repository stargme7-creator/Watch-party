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
    if (!rooms[roomId]) rooms[roomId] = [];
    rooms[roomId].push(username);
    io.to(roomId).emit('user-joined', username, rooms[roomId]);
  });

  socket.on('chat-message', (roomId, username, message) => {
    io.to(roomId).emit('chat-message', username, message);
  });

  socket.on('video-sync', (roomId, data) => {
    socket.to(roomId).emit('video-sync', data);
  });

  socket.on('disconnect', () => {
    for (let roomId in rooms) {
      rooms[roomId] = rooms[roomId].filter(u => u !== socket.username);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

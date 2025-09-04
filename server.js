const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// 伺服靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

// 遊戲房間管理
const rooms = new Map();
const playerRooms = new Map(); // 玩家ID對應房間ID

// 生成房間ID
function generateRoomId() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// 判斷勝負
function determineWinner(choice1, choice2) {
    if (choice1 === choice2) return 'tie';
    
    const winConditions = {
        rock: 'scissors',
        paper: 'rock',
        scissors: 'paper'
    };
    
    if (winConditions[choice1] === choice2) return 'player1';
    return 'player2';
}

io.on('connection', (socket) => {
    console.log('玩家連接:', socket.id);

    // 創建房間
    socket.on('createRoom', (data) => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            players: [{
                id: socket.id,
                name: data.playerName,
                choice: null,
                ready: false
            }],
            gameState: 'waiting'
        };
        
        rooms.set(roomId, room);
        playerRooms.set(socket.id, roomId);
        socket.join(roomId);
        
        socket.emit('roomCreated', {
            roomId: roomId,
            players: room.players
        });
        
        console.log(`房間 ${roomId} 已創建`);
    });

    // 加入房間
    socket.on('joinRoom', (data) => {
        const room = rooms.get(data.roomId);
        if (!room) {
            socket.emit('error', { message: '房間不存在' });
            return;
        }
        
        if (room.players.length >= 2) {
            socket.emit('error', { message: '房間已滿' });
            return;
        }
        
        // 檢查名稱是否重複
        if (room.players.some(p => p.name === data.playerName)) {
            socket.emit('error', { message: '暱稱已被使用' });
            return;
        }
        
        room.players.push({
            id: socket.id,
            name: data.playerName,
            choice: null,
            ready: false
        });
        
        playerRooms.set(socket.id, data.roomId);
        socket.join(data.roomId);
        
        // 通知房間內所有玩家
        io.to(data.roomId).emit('roomJoined', {
            roomId: data.roomId,
            players: room.players
        });
        
        // 如果房間滿了，開始遊戲
        if (room.players.length === 2) {
            room.gameState = 'ready';
            io.to(data.roomId).emit('gameReady', {
                players: room.players
            });
        }
        
        console.log(`玩家 ${data.playerName} 加入房間 ${data.roomId}`);
    });

    // 玩家選擇
    socket.on('makeChoice', (data) => {
        const roomId = playerRooms.get(socket.id);
        const room = rooms.get(roomId);
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.choice = data.choice;
            player.ready = true;
        }
        
        // 通知房間內玩家狀態更新
        io.to(roomId).emit('playerReady', {
            players: room.players
        });
        
        // 如果兩個玩家都準備好了，開始倒數
        if (room.players.length === 2 && room.players.every(p => p.ready)) {
            startCountdown(roomId);
        }
    });

    // 開始倒數
    function startCountdown(roomId) {
        let count = 3;
        const countdownTexts = ['剪刀', '石頭', '布'];
        
        const countdownInterval = setInterval(() => {
            const message = count > 0 ? countdownTexts[3 - count] : '開！';
            
            io.to(roomId).emit('countdown', {
                count: count,
                message: message
            });
            
            count--;
            
            if (count < 0) {
                clearInterval(countdownInterval);
                setTimeout(() => showResult(roomId), 500);
            }
        }, 1000);
    }

    // 顯示結果
    function showResult(roomId) {
        const room = rooms.get(roomId);
        if (!room) return;
        
        const [player1, player2] = room.players;
        const result = determineWinner(player1.choice, player2.choice);
        
        io.to(roomId).emit('gameResult', {
            players: room.players,
            result: result
        });
        
        // 重置遊戲狀態
        room.players.forEach(p => {
            p.choice = null;
            p.ready = false;
        });
        room.gameState = 'result';
        
        console.log(`房間 ${roomId} 遊戲結束`);
    }

    // 再玩一次
    socket.on('playAgain', () => {
        const roomId = playerRooms.get(socket.id);
        const room = rooms.get(roomId);
        if (!room) return;
        
        room.gameState = 'ready';
        io.to(roomId).emit('gameReady', {
            players: room.players
        });
    });

    // 離開房間
    socket.on('leaveRoom', () => {
        const roomId = playerRooms.get(socket.id);
        const room = rooms.get(roomId);
        if (!room) return;
        
        room.players = room.players.filter(p => p.id !== socket.id);
        playerRooms.delete(socket.id);
        socket.leave(roomId);
        
        if (room.players.length === 0) {
            rooms.delete(roomId);
            console.log(`房間 ${roomId} 已刪除`);
        } else {
            io.to(roomId).emit('playerLeft', {
                players: room.players
            });
        }
    });

    // 玩家斷線
    socket.on('disconnect', () => {
        const roomId = playerRooms.get(socket.id);
        if (roomId) {
            const room = rooms.get(roomId);
            if (room) {
                room.players = room.players.filter(p => p.id !== socket.id);
                
                if (room.players.length === 0) {
                    rooms.delete(roomId);
                    console.log(`房間 ${roomId} 已刪除`);
                } else {
                    io.to(roomId).emit('playerLeft', {
                        players: room.players
                    });
                }
            }
        }
        
        playerRooms.delete(socket.id);
        console.log('玩家斷線:', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`伺服器運行在 http://localhost:${PORT}`);
});
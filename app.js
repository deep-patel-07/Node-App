const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const QRCode = require('qrcode');

const app = express();
app.use(cookieParser());
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const SESSIONS_FILE = './sessions.json';
let sessions = {};
if (fs.existsSync(SESSIONS_FILE)) {
    try {
        sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    } catch (error) {
        console.error('Error reading sessions file:', error);
        sessions = {};
    }
}
let clients = {};

const createClient = (sessionId) => {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: sessionId
        }),
        puppeteer: {
            headless: false,
            timeout: 0,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });
    client.on('qr', (qr) => {
        console.log('QR RECEIVED', qr);
        console.log('sessionId RECEIVED', sessionId);
        try {
            QRCode.toDataURL(qr, function (err, url) {
                if (err) throw err;
                io.emit('qr', { qr: url.split(',')[1], sessionId: sessionId });
            });
        } catch (error) {
            console.error('Error generating QR code:', error);
            io.emit('error', { status: 'error', datamsg: `Error generating QR code: ${error.message}` });
        }
    });

    client.on('authenticated', () => {
        try {
            sessions[sessionId] = { authenticated: true };
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
            console.log(`Client ${sessionId} is authenticated!`);
            io.emit('authenticated', { sessionId: sessionId, status: 'Success', message: `Client ${sessionId} is authenticated!` });
        } catch (error) {
            console.error('Error saving session:', error);
            io.emit('error', { status: 'error', datamsg: `Error saving session: ${error.message}` });
        }
    });

    client.on('ready', () => {
        console.log(`Client ${sessionId} is ready to send messages!`);
        io.emit('reconnected', { sessionId: sessionId, status: 'Success', message: `Client ${sessionId} is ready to send messages!` });
    });

    client.on('auth_failure', (msg) => {
        io.emit('error', { datamsg: `Authentication failed for session ${sessionId}: ${msg}` });
    });

    client.on('page_error', (error) => {
        console.error('Page error:', error);
        io.emit('error', { status: 'error', datamsg: `Page error: ${error.message}` });
    });

    client.on('error', (error) => {
        console.error('Client error:', error);
        io.emit('error', { status: 'error', datamsg: `Client error: ${error.message}` });
        if (error.message.includes('Execution context was destroyed')) {
            initializeClient(sessionId);
        }
    });

    client.on('disconnected', () => {
        console.log('Client disconnected, attempting reconnection...');
        initializeClient('');
    });

    return client;
};

const initializeClient = (sessionId) => {
    try {
        if (clients[sessionId]) {
            clients[sessionId].initialize();
            io.emit('reconnect-status', { sessionId: sessionId, status: 'Success', message: `Client ${sessionId} is reconnected!` });
        } else {
            clients[sessionId] = createClient(sessionId);
            clients[sessionId].initialize();
            sessions[sessionId] = { authenticated: false };
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
        }
    } catch (error) {
        console.error('Error initializing client:', error);
        io.emit('error', { status: 'error', datamsg: `Error initializing client: ${error.message}` });
    }
};

app.use(express.json());
io.on('connection', (socket) => {
    console.log('A client connected');
    socket.on('get-qr', async (data) => {
        const sessionId = data.sessionId;
        try {
            if (!clients[sessionId]) {
                initializeClient(sessionId);
            }

            if (sessions[sessionId] && !sessions[sessionId].authenticated) {
                socket.emit('qr', { sessionId });
            } else {
                socket.emit('qr', { sessionId, message: 'Already authenticated or session does not exist.' });
            }
        } catch (error) {
            console.error('Error handling get-qr event:', error);
            socket.emit('error', { status: 'error', datamsg: `Error handling get-qr event: ${error.message}` });
        }
    });

    socket.on('send-message', async (data) => {
        const { sessionId, number, message } = data;
        try {
            if (!clients[sessionId]) {
                initializeClient(sessionId);
                return socket.once('reconnected', async () => {
                    await sendMediaToClient(sessionId, number, message, base64Data, mimeType, filename, socket);
                });
            }
            const client = clients[sessionId];
            if (!/^\d+$/.test(number)) {
                return socket.emit('error', { status: 'error', datamsg: 'Invalid phone number format!' });
            }
            try {
                await client.sendMessage(number + '@c.us', message);
                socket.emit('message-sent', 'Message sent successfully!');
            } catch (err) {
                if (err.message.includes('Session closed')) {
                    socket.emit('error', { status: 'reconnect', sessionId: sessionId, datamsg: 'The session is closed. Please Wait While Reauthenticating.' });
                } else if (err.message.includes('page has been closed')) {
                    socket.emit('Warning', { status: 'warning', datamsg: `Failed to send message: ${err.message}` });
                }
            }
        } catch (error) {
            console.error('Error handling send-message event:', error);
            socket.emit('error', { status: 'error', datamsg: `Error handling send-message event: ${error.message}` });
        }
    });

    socket.on('send-media', async (data) => {
        const { sessionId, number, message, filePath, base64Data, mimeType, filename, filesize } = data;
        try {
            if (!clients[sessionId]) {
                initializeClient(sessionId);
                return socket.once('reconnected', async () => {
                    await sendMediaToClient(sessionId, number, message, base64Data, mimeType, filename, socket);
                });
            }
            const client = clients[sessionId];
            try {
                let media;
                if (base64Data) {
                    media = new MessageMedia(mimeType || 'application/octet-stream', base64Data, filename, filesize);
                } else if (filePath) {
                    if (filePath.startsWith('http')) {
                        media = await MessageMedia.fromUrl(filePath);
                    } else {
                        media = await MessageMedia.fromFilePath(filePath);
                    }
                } else {
                    media = message;
                }
                await client.sendMessage(number + '@c.us', media, { caption: message });
                socket.emit('message-sent', 'Message sent successfully!');
            } catch (err) {
                if (err.message.includes('Session closed')) {
                    socket.emit('error', { status: 'reconnect', sessionId: sessionId, datamsg: 'The session is closed. Please Wait While Reauthenticating.' });
                } else if (err.message.includes('page has been closed')) {
                    socket.emit('Warning', { status: 'warning', sessionId: sessionId, datamsg: `Failed to send message: ${err.message}` });
                }
            }
        } catch (error) {
            console.error('Error handling send-media event:', error);
            socket.emit('error', { status: 'error', datamsg: `Error handling send-media event: ${error.message}` });
        }
    });

    socket.on('reconnect-session', (data) => {
        const reconnectsession = data.sessionId;
        try {
            initializeClient(reconnectsession);
        } catch (error) {
            console.error('Error handling reconnect-session event:', error);
            socket.emit('error', { status: 'error', datamsg: `Error handling reconnect-session event: ${error.message}` });
        }
    });

    socket.on('disconnect', (err) => {
        console.log('A client disconnected');
        socket.emit('error', { status: 'message', datamsg: `A client disconnected: ${err.message}` });
    });

    socket.on('destroy-session', (data) => {
        const client = clients[data.sessionId];
        try {
            setTimeout(() => {
                if (client) {
                    client.pupBrowser.close();
                    client.destroy();
                    delete clients[data.sessionId];
                    delete sessions[data.sessionId];
                }
            }, 5000);
        } catch (error) {
            console.error('Error handling destroy-session event:', error);
            socket.emit('error', { status: 'error', datamsg: `Error handling destroy-session event: ${error.message}` });
        }
    });

    socket.on('remove_unwanted_session', () => {
        try {
            const validSessionPattern = /^session_/;

            let sessionsToRemove = [];
            for (const sessionId in sessions) {
                if (!sessionId || typeof sessionId !== 'string' || !validSessionPattern.test(sessionId)) {
                    sessionsToRemove.push(sessionId);
                    delete sessions[sessionId];
                }
            }

            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));

            console.log(`Removed ${sessionsToRemove.length} unwanted sessions:`, sessionsToRemove);

            socket.emit('unwanted_sessions_removed', {
                removedSessions: sessionsToRemove,
                status: 'success',
                message: `${sessionsToRemove.length} unwanted sessions removed.`,
            });
        } catch (error) {
            console.error('Error handling remove_unwanted_session event:', error);
            socket.emit('error', { status: 'error', datamsg: `Error handling remove_unwanted_session event: ${error.message}` });
        }
    });
});

server.listen(4000, () => {
    console.log('Server is running on port 4000');
});

// ═══════════════════════════════════════════════════════════
//  SpeedDraw — Server
//  Phases: LOBBY → PROMPT → DRAWING → VOTING → LEADERBOARD → (loop)
// ═══════════════════════════════════════════════════════════

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  // Allow large base64 canvas images (~5 MB)
  maxHttpBufferSize: 5e6,
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY:       'lobby',
  PROMPT:      'prompt',
  DRAWING:     'drawing',
  VOTING:      'voting',
  LEADERBOARD: 'leaderboard'
};

const TIMING = {
  PROMPT_DISPLAY:  6,   // seconds to show the word before drawing starts
  DRAWING:        180,  // 3 minutes for the drawing phase
  VOTE_DISPLAY:   12,   // seconds per drawing during voting
  LEADERBOARD:    12,   // seconds to show leaderboard before resetting
  SUBMIT_GRACE:    2500 // ms to wait for final drawing submissions
};

const WORDS = [
  // Animals
  'Penguin','Crocodile','Jellyfish','Hamster','Caterpillar',
  // Objects
  'Telescope','Submarine','Trampoline','Saxophone','Skateboard','Microscope','Snowglobe',
  // Places / Structures
  'Volcano','Pyramid','Lighthouse','Castle','Treehouse','Ferris Wheel',
  // Abstract / Fun
  'Wizard','Ninja','Pirate','Astronaut','Robot','Unicorn',
  // Food
  'Pizza','Spaghetti','Sushi','Taco','Waffle',
  // Nature
  'Tornado','Thunderstorm','Waterfall','Rainbow','Cactus',
  // Misc
  'Dragon','Rocket','Diamond','Guitar','Pinball','Spaceship','Mushroom'
];

// ─── Room Storage ─────────────────────────────────────────────────────────────

const rooms = {};

/** Generate a unique 5-char alphanumeric room code. */
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude 0/O/1/I for clarity
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

/** Create a fresh room object. */
function createRoom(code, hostId) {
  rooms[code] = {
    code,
    host:       hostId,
    players:    [],       // [{ id, username, score, connected }]
    phase:      PHASES.LOBBY,
    word:       null,
    timer:      null,
    timeLeft:   0,
    drawings:   {},       // { playerId → base64 }
    votes:      {},       // { drawerId → [{ voterId, stars }] }
    votingQueue: [],
    voteIdx:    0,
    roundScores: {}       // { playerId → points this round }
  };
  return rooms[code];
}

/** Return serialisable player list (no internal fields). */
function publicPlayers(room) {
  return room.players.map(({ id, username, score, connected }) =>
    ({ id, username, score, connected })
  );
}

// ─── Timer Helpers ────────────────────────────────────────────────────────────

function clearTimer(room) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
}

/**
 * Start a countdown for a room.
 * onTick(timeLeft) fires each second.
 * onDone() fires when timeLeft reaches 0.
 */
function startCountdown(room, seconds, onTick, onDone) {
  clearTimer(room);
  room.timeLeft = seconds;
  onTick(seconds); // fire immediately so UI syncs right away

  room.timer = setInterval(() => {
    room.timeLeft--;
    onTick(room.timeLeft);
    if (room.timeLeft <= 0) {
      clearTimer(room);
      onDone();
    }
  }, 1000);
}

// ─── Phase Transitions ────────────────────────────────────────────────────────

function startPromptPhase(code) {
  const room = rooms[code];
  if (!room) return;

  // Pick a word different from the last one
  const pool  = WORDS.filter(w => w !== room.word);
  room.word   = pool[Math.floor(Math.random() * pool.length)];
  room.phase  = PHASES.PROMPT;
  room.drawings  = {};
  room.votes     = {};
  room.roundScores = {};
  room.players.forEach(p => {
    room.votes[p.id]       = [];
    room.roundScores[p.id] = 0;
  });

  io.to(code).emit('phase:prompt', {
    word:     room.word,
    duration: TIMING.PROMPT_DISPLAY,
    players:  publicPlayers(room)
  });

  startCountdown(room, TIMING.PROMPT_DISPLAY,
    () => {},                          // no per-tick emit needed for prompt
    () => startDrawingPhase(code)
  );
}

function startDrawingPhase(code) {
  const room = rooms[code];
  if (!room) return;

  room.phase = PHASES.DRAWING;

  io.to(code).emit('phase:drawing', {
    word:     room.word,
    duration: TIMING.DRAWING
  });

  startCountdown(room, TIMING.DRAWING,
    (t) => io.to(code).emit('timer:tick', { timeLeft: t }),
    () => endDrawingPhase(code)
  );
}

function endDrawingPhase(code) {
  const room = rooms[code];
  if (!room) return;

  // Tell all clients to immediately submit their canvas
  io.to(code).emit('phase:drawing-end');

  // Give clients SUBMIT_GRACE ms to transmit base64 data, then proceed
  setTimeout(() => startVotingPhase(code), TIMING.SUBMIT_GRACE);
}

function startVotingPhase(code) {
  const room = rooms[code];
  if (!room) return;

  room.phase      = PHASES.VOTING;
  room.votingQueue = room.players
    .filter(p => room.drawings[p.id])
    .map(p => p.id);
  room.voteIdx    = 0;

  if (room.votingQueue.length === 0) {
    // No drawings were submitted — skip straight to results
    return startLeaderboardPhase(code);
  }

  io.to(code).emit('phase:voting', {
    totalDrawings: room.votingQueue.length
  });

  showNextDrawing(code);
}

function showNextDrawing(code) {
  const room = rooms[code];
  if (!room) return;

  if (room.voteIdx >= room.votingQueue.length) {
    return startLeaderboardPhase(code);
  }

  const drawerId = room.votingQueue[room.voteIdx];
  const drawer   = room.players.find(p => p.id === drawerId);

  io.to(code).emit('vote:show', {
    drawerId,
    drawerName:    drawer?.username ?? 'Unknown',
    imageData:     room.drawings[drawerId],
    drawingIndex:  room.voteIdx + 1,
    totalDrawings: room.votingQueue.length,
    duration:      TIMING.VOTE_DISPLAY,
    word:          room.word
  });

  startCountdown(room, TIMING.VOTE_DISPLAY,
    (t) => io.to(code).emit('timer:tick', { timeLeft: t }),
    () => {
      room.voteIdx++;
      showNextDrawing(code);
    }
  );
}

function startLeaderboardPhase(code) {
  const room = rooms[code];
  if (!room) return;

  room.phase = PHASES.LEADERBOARD;
  clearTimer(room);

  // Tally votes → round scores → cumulative scores
  Object.entries(room.votes).forEach(([drawerId, voteList]) => {
    if (!voteList.length) return;
    const avg         = voteList.reduce((s, v) => s + v.stars, 0) / voteList.length;
    const pts         = Math.round(avg * 20); // 1–5 stars maps to 20–100 pts
    room.roundScores[drawerId] = pts;
    const player      = room.players.find(p => p.id === drawerId);
    if (player) player.score += pts;
  });

  const leaderboard = [...room.players]
    .sort((a, b) => b.score - a.score)
    .map(p => ({
      id:         p.id,
      username:   p.username,
      score:      p.score,
      roundScore: room.roundScores[p.id] ?? 0
    }));

  io.to(code).emit('phase:leaderboard', {
    leaderboard,
    word:     room.word,
    drawings: room.drawings
  });

  // Auto-loop back to lobby/waiting state
  setTimeout(() => {
    if (!rooms[code]) return;
    rooms[code].phase = PHASES.LOBBY;
    io.to(code).emit('phase:lobby', { players: publicPlayers(rooms[code]) });
  }, TIMING.LEADERBOARD * 1000);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ── Create a new room ───────────────────────────────────
  socket.on('room:create', ({ username }) => {
    username = username?.trim();
    if (!username) return socket.emit('error', { msg: 'Username is required.' });

    const code = generateCode();
    const room = createRoom(code, socket.id);

    room.players.push({ id: socket.id, username, score: 0, connected: true });
    socket.join(code);
    socket.data.roomCode  = code;
    socket.data.username  = username;

    socket.emit('room:joined', {
      roomCode:  code,
      playerId:  socket.id,
      hostId:    socket.id,
      isHost:    true,
      players:   publicPlayers(room)
    });

    console.log(`[Room] "${username}" created ${code}`);
  });

  // ── Join an existing room ────────────────────────────────
  socket.on('room:join', ({ username, roomCode }) => {
    username = username?.trim();
    const code = roomCode?.trim().toUpperCase();

    if (!username)    return socket.emit('error', { msg: 'Username is required.' });
    if (!code)        return socket.emit('error', { msg: 'Room code is required.' });

    const room = rooms[code];
    if (!room)                        return socket.emit('error', { msg: `Room "${code}" not found.` });
    if (room.phase !== PHASES.LOBBY)  return socket.emit('error', { msg: 'That game is already in progress.' });
    if (room.players.some(p => p.username.toLowerCase() === username.toLowerCase())) {
      return socket.emit('error', { msg: 'That username is already taken in this room.' });
    }

    const player = { id: socket.id, username, score: 0, connected: true };
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.username = username;

    // Tell the joiner their details
    socket.emit('room:joined', {
      roomCode: code,
      playerId: socket.id,
      hostId:   room.host,
      isHost:   false,
      players:  publicPlayers(room)
    });

    // Tell everyone else a new player arrived
    socket.to(code).emit('room:player-joined', {
      player:  { id: socket.id, username, score: 0, connected: true },
      players: publicPlayers(room)
    });

    console.log(`[Room] "${username}" joined ${code}`);
  });

  // ── Host starts the game ────────────────────────────────
  socket.on('game:start', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room)                         return socket.emit('error', { msg: 'Room not found.' });
    if (room.host !== socket.id)       return socket.emit('error', { msg: 'Only the host can start.' });
    if (room.players.length < 2)       return socket.emit('error', { msg: 'Need at least 2 players to start.' });
    if (room.phase !== PHASES.LOBBY)   return socket.emit('error', { msg: 'Game is already running.' });

    startPromptPhase(code);
  });

  // ── Client submits their finished drawing ───────────────
  socket.on('game:submit-drawing', ({ imageData }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room)      return;
    if (!imageData) return;
    // Accept submissions from the drawing phase and the brief grace window
    if (room.phase !== PHASES.DRAWING && room.phase !== PHASES.VOTING) return;

    room.drawings[socket.id] = imageData;
    console.log(`[Draw] Received from "${socket.data.username}" in ${code}`);
  });

  // ── Client casts a vote ─────────────────────────────────
  socket.on('game:vote', ({ drawerId, stars }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room)                     return;
    if (room.phase !== PHASES.VOTING) return;
    if (socket.id === drawerId)    return; // can't vote for yourself
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return;

    const voteList = room.votes[drawerId];
    if (!voteList) return;

    // One vote per voter per drawing
    if (voteList.some(v => v.voterId === socket.id)) return;

    voteList.push({ voterId: socket.id, stars });

    // Broadcast a count update so others see activity (not raw votes, to prevent bias)
    io.to(code).emit('vote:count', {
      drawerId,
      count: voteList.length
    });
  });

  // ── Disconnect ──────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      clearTimer(room);
      delete rooms[code];
      console.log(`[Room] ${code} deleted (empty)`);
      return;
    }

    // Transfer host if the host left
    if (room.host === socket.id) {
      room.host = room.players[0].id;
    }

    io.to(code).emit('room:player-left', {
      playerId: socket.id,
      players:  publicPlayers(room),
      hostId:   room.host
    });

    console.log(`[-] "${socket.data.username}" left ${code}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎨  SpeedDraw is running → http://localhost:${PORT}\n`);
});

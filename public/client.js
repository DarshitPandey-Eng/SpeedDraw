// ═══════════════════════════════════════════════════════════
//  SpeedDraw — Client
//  Phases: lobby → waiting → game (prompt/drawing/voting/lb)
// ═══════════════════════════════════════════════════════════

const socket = io();

// ─── Global state ─────────────────────────────────────────
const G = {
  // Identity
  playerId: null,
  roomCode: null,
  hostId:   null,
  isHost:   false,

  // Game
  phase:    'lobby',
  word:     null,
  players:  [],

  // Drawing
  tool:      'brush',   // 'brush' | 'eraser' | 'fill'
  color:     '#000000',
  brushSize: 10,
  isDown:    false,
  canDraw:   false,
  history:   [],        // base64 snapshots for undo (max 20)

  // Timer
  timerMax: 180,

  // Voting
  votingDrawerId: null,
  hasVoted:       false,
};

// Canvas internal resolution — fixed at 800×600, display size scales via CSS
const CW = 800, CH = 600;

// ─── Shorthand DOM lookup ──────────────────────────────────
const $ = id => document.getElementById(id);

// Screens
const scrLobby   = $('screen-lobby');
const scrWaiting = $('screen-waiting');
const scrGame    = $('screen-game');

// Lobby
const inpUsername   = $('inp-username');
const inpCode       = $('inp-room-code');
const btnCreate     = $('btn-create');
const btnToggleJoin = $('btn-toggle-join');
const btnJoin       = $('btn-join');
const joinPanel     = $('join-panel');
const lobbyError    = $('lobby-error');

// Waiting room
const dispCode    = $('disp-code');
const waitingGrid = $('waiting-grid');
const waitingMsg  = $('waiting-msg');
const btnStart    = $('btn-start');
const hostHint    = $('host-hint');
const btnCopy     = $('btn-copy');

// Game header
const ghRoomCode  = $('gh-room-code');
const wordDisplay = $('word-display');
const timerVal    = $('timer-val');
const timerFill   = $('timer-fill');

// Drawing tools
const colorGrid   = $('color-grid');
const customColor = $('custom-color');
const brushSize   = $('brush-size');
const brushDot    = $('brush-dot');
const toolPanel   = $('tool-panel');
const btnUndo     = $('btn-undo');
const btnClear    = $('btn-clear');

// Canvas
const canvas     = $('canvas');
const ctx        = canvas.getContext('2d');
const canvasLock = $('canvas-lock');

// Game player list
const gamePlayers = $('game-players');

// Phase overlays
const ovPrompt      = $('ov-prompt');
const ovWord        = $('ov-word');
const ovPromptSecs  = $('ov-prompt-secs');
const ovVoting      = $('ov-voting');
const vtArtist      = $('vt-artist');
const vtProgress    = $('vt-progress');
const vtWord        = $('vt-word');
const vtImg         = $('vt-img');
const starsEl       = $('stars');
const vtStatus      = $('vt-status');
const voteFill      = $('vote-fill');
const ovLb          = $('ov-leaderboard');
const lbWord        = $('lb-word');
const lbList        = $('lb-list');
const lbGallery     = $('lb-gallery');
const lbSecs        = $('lb-secs');
const toastsEl      = $('toasts');


// ═══════════════════════════════════════════════════════════
//  SCREEN & OVERLAY MANAGEMENT
// ═══════════════════════════════════════════════════════════

function showScreen(name) {
  [scrLobby, scrWaiting, scrGame].forEach(s => s.classList.remove('active'));
  ({ lobby: scrLobby, waiting: scrWaiting, game: scrGame })[name].classList.add('active');
}

function hideOverlays() {
  [ovPrompt, ovVoting, ovLb].forEach(o => {
    o.style.display = 'none';
    o.setAttribute('aria-hidden', 'true');
  });
}

function showOverlay(el) {
  hideOverlays();
  el.style.display = 'flex';
  el.setAttribute('aria-hidden', 'false');
}


// ═══════════════════════════════════════════════════════════
//  LOBBY
// ═══════════════════════════════════════════════════════════

function setLobbyError(msg) {
  lobbyError.textContent = msg || '';
  lobbyError.classList.toggle('visible', !!msg);
  if (msg) setTimeout(() => lobbyError.classList.remove('visible'), 4500);
}

btnCreate.addEventListener('click', () => {
  const u = inpUsername.value.trim();
  if (!u) return setLobbyError('Please enter a username first!');
  socket.emit('room:create', { username: u });
});

btnToggleJoin.addEventListener('click', () => {
  const open = joinPanel.classList.toggle('open');
  joinPanel.setAttribute('aria-hidden', String(!open));
  if (open) setTimeout(() => inpCode.focus(), 60);
});

function doJoin() {
  const u = inpUsername.value.trim();
  const c = inpCode.value.trim().toUpperCase();
  if (!u) return setLobbyError('Please enter a username!');
  if (!c) return setLobbyError('Please enter a room code!');
  socket.emit('room:join', { username: u, roomCode: c });
}

btnJoin.addEventListener('click', doJoin);

// Keyboard shortcuts
inpUsername.addEventListener('keydown', e => { if (e.key === 'Enter') btnCreate.click(); });
inpCode.addEventListener('keydown',     e => { if (e.key === 'Enter') doJoin(); });

// Auto-uppercase room codes as you type
inpCode.addEventListener('input', () => { inpCode.value = inpCode.value.toUpperCase(); });


// ═══════════════════════════════════════════════════════════
//  WAITING ROOM — PLAYER CARDS
// ═══════════════════════════════════════════════════════════

// Deterministic avatar colour from username string
const AVATAR_PALETTE = [
  '#ff2d7a','#00e5ff','#00ff88','#ffd54f','#ae80ff',
  '#ff6b35','#00d4aa','#ff9f1c','#2ec4b6','#e63946',
];
function avatarColor(name) {
  let h = 0;
  for (const c of name) h = c.charCodeAt(0) + ((h << 5) - h);
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function renderWaiting(players) {
  waitingGrid.innerHTML = '';
  players.forEach(p => {
    const you  = p.id === G.playerId;
    const host = p.id === G.hostId;
    const card = document.createElement('div');
    card.className = `w-player-card${you ? ' is-you' : ''}${host ? ' is-host' : ''}`;
    card.innerHTML = `
      <div class="w-avatar" style="background:${avatarColor(p.username)}">
        ${esc(p.username[0].toUpperCase())}
      </div>
      <div class="w-name">${esc(p.username)}</div>
      ${host && you  ? '<span class="w-tag w-tag-host">👑 Host · You</span>'
      : host         ? '<span class="w-tag w-tag-host">👑 Host</span>'
      : you          ? '<span class="w-tag w-tag-you">You</span>'
      : ''}
    `;
    waitingGrid.appendChild(card);
  });

  const n = players.length;
  waitingMsg.textContent = n < 2
    ? `Waiting for more players… (${n}/2 minimum)`
    : `${n} player${n !== 1 ? 's' : ''} ready!`;

  btnStart.style.display = (G.isHost && n >= 2) ? 'inline-flex' : 'none';
}

btnCopy.addEventListener('click', () => {
  if (!G.roomCode) return;
  navigator.clipboard.writeText(G.roomCode).then(() => {
    btnCopy.textContent = '✅';
    setTimeout(() => { btnCopy.textContent = '📋'; }, 2000);
  });
});

btnStart.addEventListener('click', () => socket.emit('game:start'));


// ═══════════════════════════════════════════════════════════
//  GAME — IN-GAME PLAYER LIST
// ═══════════════════════════════════════════════════════════

function renderGamePlayers(players) {
  G.players = players;
  gamePlayers.innerHTML = '';
  [...players]
    .sort((a, b) => b.score - a.score)
    .forEach(p => {
      const you = p.id === G.playerId;
      const li  = document.createElement('li');
      li.className = `p-row${you ? ' is-you' : ''}`;
      li.innerHTML = `
        <div class="p-avatar-sm" style="background:${avatarColor(p.username)}">
          ${esc(p.username[0].toUpperCase())}
        </div>
        <div class="p-info">
          <div class="p-name">${esc(p.username)}${you ? ' 👤' : ''}</div>
          <div class="p-score">⭐ ${p.score} pts</div>
        </div>
      `;
      gamePlayers.appendChild(li);
    });
  // Keep mobile player list in sync
  if (typeof renderMobilePlayers === 'function') renderMobilePlayers(players);
}


// ═══════════════════════════════════════════════════════════
//  CANVAS — INIT & RESPONSIVE RESIZE
// ═══════════════════════════════════════════════════════════

function initCanvas() {
  canvas.width  = CW;
  canvas.height = CH;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CW, CH);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
}

/**
 * Scale the canvas DISPLAY size to fit the available area while
 * keeping the 800×600 aspect ratio and never changing the internal
 * pixel buffer (so toDataURL always returns a consistent image).
 */
function resizeCanvas() {
  const area = document.querySelector('.canvas-area');
  if (!area) return;
  const aw = area.clientWidth  - 32;
  const ah = area.clientHeight - 32;
  if (aw <= 0 || ah <= 0) return;

  const aspect = CW / CH;
  let dw = aw, dh = aw / aspect;
  if (dh > ah) { dh = ah; dw = ah * aspect; }

  canvas.style.width  = `${Math.floor(dw)}px`;
  canvas.style.height = `${Math.floor(dh)}px`;
}

window.addEventListener('resize', resizeCanvas);


// ═══════════════════════════════════════════════════════════
//  CANVAS — COORDINATE MAPPING
//  Converts a mouse/touch client position → canvas pixel coords,
//  accounting for the CSS scaling between display and buffer sizes.
// ═══════════════════════════════════════════════════════════

function getPos(e) {
  const rect   = canvas.getBoundingClientRect();
  const scaleX = CW / rect.width;
  const scaleY = CH / rect.height;

  let cx, cy;
  if (e.touches && e.touches.length > 0) {
    cx = e.touches[0].clientX;
    cy = e.touches[0].clientY;
  } else if (e.changedTouches && e.changedTouches.length > 0) {
    cx = e.changedTouches[0].clientX;
    cy = e.changedTouches[0].clientY;
  } else {
    cx = e.clientX;
    cy = e.clientY;
  }

  return {
    x: (cx - rect.left) * scaleX,
    y: (cy - rect.top)  * scaleY,
  };
}


// ═══════════════════════════════════════════════════════════
//  CANVAS — DRAWING ENGINE
//
//  Smooth strokes via the midpoint quadratic-bezier technique:
//    • Every frame we draw from the previous midpoint → new midpoint
//    • The previous raw point becomes the bezier control point
//    • This ensures curves are always tangent to consecutive segments
// ═══════════════════════════════════════════════════════════

let lx = 0, ly = 0;   // last raw mouse position
let mx = 0, my = 0;   // last midpoint (start of next curve segment)

// Save a JPEG snapshot for undo (JPEG keeps memory small)
function snapshot() {
  G.history.push(canvas.toDataURL('image/jpeg', 0.85));
  if (G.history.length > 20) G.history.shift();
}

function strokeColor() {
  return G.tool === 'eraser' ? '#ffffff' : G.color;
}

function strokeWidth() {
  // lineWidth is the full diameter; brushSize is treated as diameter too
  return G.brushSize;
}

function onPointerDown(e) {
  if (!G.canDraw) return;
  e.preventDefault();

  const p = getPos(e);
  lx = mx = p.x;
  ly = my = p.y;
  G.isDown = true;
  snapshot();

  // Fill bucket: handle on pointerdown, not in the move loop
  if (G.tool === 'fill') {
    floodFill(Math.round(p.x), Math.round(p.y), G.color);
    G.isDown = false;
    return;
  }

  // Paint a dot so a single click always leaves a visible mark
  ctx.beginPath();
  ctx.arc(p.x, p.y, strokeWidth() / 2, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor();
  ctx.fill();
}

function onPointerMove(e) {
  if (!G.isDown || !G.canDraw) return;
  e.preventDefault();

  const p  = getPos(e);
  const nx = (lx + p.x) / 2;   // new midpoint
  const ny = (ly + p.y) / 2;

  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.quadraticCurveTo(lx, ly, nx, ny);  // smooth bezier arc
  ctx.strokeStyle = strokeColor();
  ctx.lineWidth   = strokeWidth();
  ctx.stroke();

  // Advance midpoint and last-raw for next segment
  mx = nx;  my = ny;
  lx = p.x; ly = p.y;
}

function onPointerUp(e) {
  if (!G.isDown) return;
  G.isDown = false;

  // Draw the final stub from last midpoint to the exact cursor position
  // so the stroke end is never visibly truncated.
  const p = getPos(e);
  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = strokeColor();
  ctx.lineWidth   = strokeWidth();
  ctx.stroke();
}

// Mouse
canvas.addEventListener('mousedown',  onPointerDown);
canvas.addEventListener('mousemove',  onPointerMove);
canvas.addEventListener('mouseup',    onPointerUp);
canvas.addEventListener('mouseleave', onPointerUp);

// Touch (passive:false so we can call preventDefault and block scroll)
canvas.addEventListener('touchstart', onPointerDown, { passive: false });
canvas.addEventListener('touchmove',  onPointerMove, { passive: false });
canvas.addEventListener('touchend',   onPointerUp);


// ═══════════════════════════════════════════════════════════
//  FLOOD FILL  (BFS, tolerance-based to handle anti-aliasing)
// ═══════════════════════════════════════════════════════════

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function floodFill(sx, sy, hex) {
  if (sx < 0 || sy < 0 || sx >= CW || sy >= CH) return;

  const img  = ctx.getImageData(0, 0, CW, CH);
  const data = img.data;
  const [fr, fg, fb] = hexToRgb(hex);

  const base = (sy * CW + sx) * 4;
  const [tr, tg, tb, ta] = [data[base], data[base+1], data[base+2], data[base+3]];

  // Nothing to do if the target pixel is already the fill colour
  if (tr === fr && tg === fg && tb === fb && ta === 255) return;

  // Check if a pixel at index i is "close enough" to the seed colour
  const TOL = 30;
  const matches = i =>
    Math.abs(data[i]   - tr) <= TOL &&
    Math.abs(data[i+1] - tg) <= TOL &&
    Math.abs(data[i+2] - tb) <= TOL &&
    Math.abs(data[i+3] - ta) <= TOL;

  const fill = i => {
    data[i]   = fr; data[i+1] = fg;
    data[i+2] = fb; data[i+3] = 255;
  };

  const visited = new Uint8Array(CW * CH);
  const stack   = [sy * CW + sx];

  while (stack.length) {
    const pos = stack.pop();
    if (pos < 0 || pos >= CW * CH || visited[pos]) continue;
    if (!matches(pos * 4)) continue;

    visited[pos] = 1;
    fill(pos * 4);

    const x = pos % CW;
    if (x > 0)      stack.push(pos - 1);
    if (x < CW - 1) stack.push(pos + 1);
    stack.push(pos - CW);
    stack.push(pos + CW);
  }

  ctx.putImageData(img, 0, 0);
}


// ═══════════════════════════════════════════════════════════
//  COLOUR PALETTE
// ═══════════════════════════════════════════════════════════

const PALETTE = [
  // Greyscale
  '#000000','#3a3a3a','#787878','#b4b4b4','#ffffff',
  // Hot spectrum
  '#ff0000','#ff5500','#ffaa00','#aaff00','#00ff88',
  // Cool spectrum
  '#00e5ff','#0055ff','#6600ff','#bb00ff','#ff0088',
  // Earth / skin
  '#6b3500','#c97b2e','#f5c27f','#ffe0bd','#ffe8e8',
  // Deep tones
  '#002200','#003333','#000055','#1a001a','#330000',
  // Pastels
  '#ffb3c6','#ffedb3','#b3ffd5','#b3e5ff','#ddb3ff',
];

function buildPalette() {
  colorGrid.innerHTML = '';
  PALETTE.forEach(c => {
    const sw = document.createElement('div');
    sw.className        = 'c-swatch' + (c === G.color ? ' active' : '');
    sw.style.background = c;
    sw.dataset.c        = c;
    sw.title            = c.toUpperCase();
    sw.addEventListener('click', () => pickColor(c));
    colorGrid.appendChild(sw);
  });
}

function pickColor(c) {
  G.color = c;
  customColor.value = c;
  document.querySelectorAll('.c-swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.c === c)
  );
  // Auto-switch from eraser back to brush when a colour is chosen
  if (G.tool === 'eraser') setTool('brush');
  refreshBrushDot();
  if (typeof refreshMobileBrushDot === 'function') refreshMobileBrushDot();
}

customColor.addEventListener('input', () => pickColor(customColor.value));


// ═══════════════════════════════════════════════════════════
//  BRUSH SIZE
// ═══════════════════════════════════════════════════════════

brushSize.addEventListener('input', () => {
  G.brushSize = Number(brushSize.value);
  refreshBrushDot();
});

function refreshBrushDot() {
  // Dot diameter: scales non-linearly so small sizes feel fine, large feel bold
  const d = Math.max(4, Math.min(G.brushSize * 1.4, 48));
  brushDot.style.width      = `${d}px`;
  brushDot.style.height     = `${d}px`;
  brushDot.style.background = G.tool === 'eraser' ? '#888888' : G.color;
}


// ═══════════════════════════════════════════════════════════
//  TOOL SELECTION
// ═══════════════════════════════════════════════════════════

const TOOL_MAP = {
  brush:  $('btn-tool-brush'),
  eraser: $('btn-tool-eraser'),
  fill:   $('btn-tool-fill'),
};

function setTool(name) {
  G.tool = name;
  Object.entries(TOOL_MAP).forEach(([k, b]) =>
    b.classList.toggle('active', k === name)
  );
  canvas.style.cursor =
    name === 'eraser' ? 'cell'      :
    name === 'fill'   ? 'copy'      : 'crosshair';
  refreshBrushDot();
  if (typeof syncMobileToolBtns === 'function') syncMobileToolBtns();
}

Object.entries(TOOL_MAP).forEach(([name, btn]) =>
  btn.addEventListener('click', () => setTool(name))
);


// ═══════════════════════════════════════════════════════════
//  UNDO & CLEAR
// ═══════════════════════════════════════════════════════════

btnUndo.addEventListener('click', () => {
  if (!G.canDraw || !G.history.length) return;
  const prev = G.history.pop();
  const img  = new Image();
  img.onload = () => { ctx.clearRect(0, 0, CW, CH); ctx.drawImage(img, 0, 0); };
  img.src    = prev;
});

btnClear.addEventListener('click', () => {
  if (!G.canDraw) return;
  snapshot();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CW, CH);
});


// ═══════════════════════════════════════════════════════════
//  TIMER DISPLAY
// ═══════════════════════════════════════════════════════════

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function setTimer(left, max) {
  timerVal.textContent  = fmtTime(Math.max(0, left));
  timerFill.style.width = `${Math.max(0, (left / max)) * 100}%`;

  timerVal.classList.remove('warn', 'danger');
  timerFill.classList.remove('warn', 'danger');

  if      (left <= 30) { timerVal.classList.add('danger'); timerFill.classList.add('danger'); }
  else if (left <= 60) { timerVal.classList.add('warn');   timerFill.classList.add('warn'); }
}


// ═══════════════════════════════════════════════════════════
//  WORD REVEAL ANIMATION
//  Each character drops in with a staggered delay.
//  Spaces are preserved as non-breaking space pairs.
// ═══════════════════════════════════════════════════════════

function animateWord(word) {
  ovWord.innerHTML = '';
  [...word].forEach((ch, i) => {
    if (ch === ' ') {
      ovWord.appendChild(document.createTextNode('\u00A0\u00A0'));
      return;
    }
    const span = document.createElement('span');
    span.className   = 'char';
    span.textContent = ch;
    span.style.animationDelay = `${i * 60}ms`;
    ovWord.appendChild(span);
  });
}


// ═══════════════════════════════════════════════════════════
//  PHASE HANDLERS
// ═══════════════════════════════════════════════════════════

// ── PROMPT — word is revealed, drawing is about to start ───
function onPhasePrompt({ word, duration, players }) {
  G.phase   = 'prompt';
  G.word    = word;
  G.canDraw = false;
  G.history = [];

  // Wipe the canvas for the new round
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CW, CH);

  // Update persistent game-screen elements
  ghRoomCode.textContent  = `ROOM: ${G.roomCode}`;
  wordDisplay.textContent = '…';
  if (players) renderGamePlayers(players);

  // Show prompt overlay with letter-drop animation
  showOverlay(ovPrompt);
  animateWord(word);
  setTimer(duration, duration);
  G.timerMax = duration;

  // Tick the "Drawing starts in Xs" counter inside the overlay
  let secs = duration;
  ovPromptSecs.textContent = secs;
  const tick = setInterval(() => {
    secs = Math.max(0, secs - 1);
    ovPromptSecs.textContent = secs;
    if (secs <= 0) clearInterval(tick);
  }, 1000);

  // Transition to game screen (canvas will resize on next frame)
  showScreen('game');
  requestAnimationFrame(resizeCanvas);
}

// ── DRAWING — timer running, canvas is live ─────────────────
function onPhaseDrawing({ word, duration }) {
  G.phase    = 'drawing';
  G.canDraw  = true;
  G.timerMax = duration;

  hideOverlays();
  toolPanel.classList.remove('locked');
  canvasLock.style.display = 'none';
  canvasLock.setAttribute('aria-hidden', 'true');

  // Restore the cursor that matches the current tool
  canvas.style.cursor =
    G.tool === 'eraser' ? 'cell'      :
    G.tool === 'fill'   ? 'copy'      : 'crosshair';

  wordDisplay.textContent = word;
  setTimer(duration, duration);
}

// ── DRAWING END — lock canvas, ship the base64 to server ────
function onPhaseDrawingEnd() {
  G.canDraw = false;
  toolPanel.classList.add('locked');
  canvasLock.style.display = 'flex';
  canvasLock.setAttribute('aria-hidden', 'false');
  canvas.style.cursor = 'not-allowed';

  // JPEG at 0.75 quality keeps the payload well under 1 MB for an 800×600 canvas
  const imageData = canvas.toDataURL('image/jpeg', 0.75);
  socket.emit('game:submit-drawing', { imageData });
  toast('Canvas submitted! ✅');
}

// ── VOTING — prompt overlay is replaced by the vote UI ──────
function onPhaseVoting({ totalDrawings }) {
  G.phase = 'voting';
  showOverlay(ovVoting);
  vtWord.textContent = G.word;
}

// Server broadcasts each drawing one by one for ratings
function onVoteShow({ drawerId, drawerName, imageData, drawingIndex, totalDrawings, duration, word }) {
  G.votingDrawerId = drawerId;
  // You can't vote for your own drawing; flag it so the UI disables stars
  G.hasVoted = (drawerId === G.playerId);

  vtArtist.textContent   = `🎨 ${esc(drawerName)}`;
  vtProgress.textContent = `${drawingIndex} / ${totalDrawings}`;
  vtWord.textContent     = word ?? G.word;
  vtImg.src              = imageData;

  // Reset star state
  document.querySelectorAll('.star').forEach(s => s.classList.remove('lit'));
  starsEl.classList.toggle('voted-own', G.hasVoted);

  vtStatus.textContent = G.hasVoted
    ? "That's your drawing! 🎨 Watching others vote…"
    : 'Rate this drawing!';

  // Animate the per-drawing countdown bar independently of the header timer
  G.timerMax = duration;
  let t = duration;
  voteFill.style.transition = 'none';
  voteFill.style.width      = '100%';
  // Kick off smooth transitions after the first frame so the bar isn't jittery
  requestAnimationFrame(() => {
    voteFill.style.transition = 'width 1s linear';
  });

  let voteBarInterval = setInterval(() => {
    t = Math.max(0, t - 1);
    voteFill.style.width = `${(t / duration) * 100}%`;
    if (t <= 0) clearInterval(voteBarInterval);
  }, 1000);
}

function onVoteCount({ drawerId, count }) {
  // Show live vote count only if we haven't voted yet and it's not our own drawing
  if (drawerId === G.votingDrawerId && !G.hasVoted && drawerId !== G.playerId) {
    vtStatus.textContent = `${count} vote${count !== 1 ? 's' : ''} received…`;
  }
}

// ── LEADERBOARD — scores + drawing gallery ──────────────────
function onPhaseLeaderboard({ leaderboard, word, drawings }) {
  G.phase = 'leaderboard';
  lbWord.textContent = word;

  // Score rows
  lbList.innerHTML = '';
  leaderboard.forEach((p, i) => {
    const medals  = ['🥇','🥈','🥉'];
    const rankCls = ['gold','silver','bronze'][i] ?? '';
    const li      = document.createElement('li');
    li.className  = 'lb-row';
    li.style.animationDelay = `${i * 90}ms`;
    li.innerHTML = `
      <span class="lb-rank ${rankCls}">${medals[i] ?? `${i + 1}.`}</span>
      <span class="lb-name">${esc(p.username)}</span>
      <div class="lb-pts">
        <div class="lb-round">+${p.roundScore} this round</div>
        <div class="lb-total">⭐ ${p.score} total</div>
      </div>
    `;
    lbList.appendChild(li);
  });

  // Drawing gallery beneath scores
  lbGallery.innerHTML = '';
  if (drawings) {
    Object.entries(drawings).forEach(([pid, src]) => {
      if (!src) return;
      const player = leaderboard.find(x => x.id === pid);
      if (!player) return;
      const div = document.createElement('div');
      div.className = 'lb-thumb';
      div.innerHTML = `
        <img src="${src}" alt="${esc(player.username)}'s drawing" loading="lazy" />
        <span class="lb-thumb-name">${esc(player.username)}</span>
      `;
      lbGallery.appendChild(div);
    });
  }

  // Countdown to next round
  let n = 12;
  lbSecs.textContent = n;
  const ct = setInterval(() => {
    n = Math.max(0, n - 1);
    lbSecs.textContent = n;
    if (n <= 0) clearInterval(ct);
  }, 1000);

  showOverlay(ovLb);
}

// ── LOBBY — round over, back to waiting room ────────────────
function onPhaseLobby({ players }) {
  G.phase   = 'waiting';
  G.canDraw = false;
  hideOverlays();
  dispCode.textContent   = G.roomCode;
  hostHint.style.display = G.isHost ? 'block' : 'none';
  if (players) { G.players = players; renderWaiting(players); }
  showScreen('waiting');
  toast('Round over! Starting again soon… 🔁');
}


// ═══════════════════════════════════════════════════════════
//  STAR RATING
// ═══════════════════════════════════════════════════════════

const starBtns = document.querySelectorAll('.star');

starBtns.forEach(btn => {
  // Preview highlight on hover
  btn.addEventListener('mouseenter', () => {
    if (G.hasVoted) return;
    const v = Number(btn.dataset.v);
    starBtns.forEach(s => s.classList.toggle('lit', Number(s.dataset.v) <= v));
  });

  // Commit vote on click
  btn.addEventListener('click', () => {
    if (G.hasVoted) return;
    const stars = Number(btn.dataset.v);
    socket.emit('game:vote', { drawerId: G.votingDrawerId, stars });
    G.hasVoted = true;
    starsEl.classList.add('voted-own');
    vtStatus.textContent = `You rated ${stars} star${stars !== 1 ? 's' : ''}! ⭐`;
    // Lock the highlight at the selected value
    starBtns.forEach(s => s.classList.toggle('lit', Number(s.dataset.v) <= stars));
  });
});

// Clear hover highlight when mouse leaves the star group
starsEl.addEventListener('mouseleave', () => {
  if (!G.hasVoted) starBtns.forEach(s => s.classList.remove('lit'));
});


// ═══════════════════════════════════════════════════════════
//  SOCKET.IO — EVENT BINDINGS
// ═══════════════════════════════════════════════════════════

socket.on('connect', () => console.log('[ws] connected:', socket.id));

socket.on('error', ({ msg }) => {
  setLobbyError(msg);
  // If we're not already on the lobby screen, go back
  if (!scrLobby.classList.contains('active')) showScreen('lobby');
  toast(msg, 'error');
});

// ── Room events ──────────────────────────────────────────────
socket.on('room:joined', ({ roomCode, playerId, hostId, isHost, players }) => {
  G.playerId = playerId;
  G.roomCode = roomCode;
  G.hostId   = hostId;
  G.isHost   = isHost;
  G.players  = players;

  dispCode.textContent   = roomCode;
  ghRoomCode.textContent = `ROOM: ${roomCode}`;

  hostHint.style.display = isHost ? 'block' : 'none';
  renderWaiting(players);
  showScreen('waiting');
  toast(`Joined room ${roomCode} 🎉`);
});

socket.on('room:player-joined', ({ player, players }) => {
  G.players = players;
  renderWaiting(players);
  toast(`${player.username} joined! 👋`);
});

socket.on('room:player-left', ({ playerId, players, hostId }) => {
  const leaving = G.players.find(p => p.id === playerId);
  G.players = players;
  G.hostId  = hostId;

  // Check if we just got promoted to host
  if (hostId === G.playerId && !G.isHost) {
    G.isHost = true;
    toast('You are now the host! 👑');
  }

  if (scrWaiting.classList.contains('active')) renderWaiting(players);
  else renderGamePlayers(players);

  if (leaving) toast(`${leaving.username} left.`);
});

// ── Phase events ─────────────────────────────────────────────
socket.on('phase:prompt',      onPhasePrompt);
socket.on('phase:drawing',     onPhaseDrawing);
socket.on('phase:drawing-end', onPhaseDrawingEnd);
socket.on('phase:voting',      onPhaseVoting);
socket.on('phase:leaderboard', onPhaseLeaderboard);
socket.on('phase:lobby',       onPhaseLobby);

socket.on('vote:show',  onVoteShow);
socket.on('vote:count', onVoteCount);

// Both drawing and voting phases use the same tick event
socket.on('timer:tick', ({ timeLeft }) => {
  setTimer(timeLeft, G.timerMax);
});


// ═══════════════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = msg;
  toastsEl.appendChild(el);
  // Fade out then remove
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 380);
  }, 3200);
}


// ═══════════════════════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════════════════════

/** Escape HTML to prevent XSS from user-supplied strings (names, words). */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}




// ═══════════════════════════════════════════════════════════
//  MOBILE TOOLBAR
// ═══════════════════════════════════════════════════════════

const mobileToolbar   = $('mobile-toolbar');
const mobColorGrid    = $('mob-color-grid');
const mobCustomColor  = $('mob-custom-color');
const mobBrushSize    = $('mob-brush-size');
const mobBrushDot     = $('mob-brush-dot');
const mobGamePlayers  = $('mob-game-players');

const MOB_TOOL_MAP = {
  brush:  $('mob-btn-brush'),
  eraser: $('mob-btn-eraser'),
  fill:   $('mob-btn-fill'),
};

function isMobile() { return window.innerWidth <= 720; }

function showMobileToolbar(show) {
  if (!mobileToolbar) return;
  mobileToolbar.style.display = show ? 'flex' : 'none';
}

// Build the mobile colour palette (same colours, different grid layout)
function buildMobilePalette() {
  if (!mobColorGrid) return;
  mobColorGrid.innerHTML = '';
  PALETTE.forEach(c => {
    const sw = document.createElement('div');
    sw.className        = 'c-swatch' + (c === G.color ? ' active' : '');
    sw.style.background = c;
    sw.dataset.c        = c;
    sw.addEventListener('click', () => {
      pickColor(c);
      syncMobilePalette();
    });
    mobColorGrid.appendChild(sw);
  });
}

function syncMobilePalette() {
  if (!mobColorGrid) return;
  mobColorGrid.querySelectorAll('.c-swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.c === G.color)
  );
  if (mobCustomColor) mobCustomColor.value = G.color;
  refreshMobileBrushDot();
}

function refreshMobileBrushDot() {
  if (!mobBrushDot) return;
  const d = Math.max(4, Math.min(G.brushSize * 1.4, 48));
  mobBrushDot.style.width      = `${d}px`;
  mobBrushDot.style.height     = `${d}px`;
  mobBrushDot.style.background = G.tool === 'eraser' ? '#888888' : G.color;
}

function syncMobileToolBtns() {
  Object.entries(MOB_TOOL_MAP).forEach(([k, b]) => {
    if (b) b.classList.toggle('active', k === G.tool);
  });
}

// Sync the mobile players list (horizontal scroll row)
function renderMobilePlayers(players) {
  if (!mobGamePlayers) return;
  mobGamePlayers.innerHTML = '';
  [...players]
    .sort((a, b) => b.score - a.score)
    .forEach(p => {
      const you = p.id === G.playerId;
      const li  = document.createElement('li');
      li.className = `p-row${you ? ' is-you' : ''}`;
      li.innerHTML = `
        <div class="p-avatar-sm" style="background:${avatarColor(p.username)}">
          ${esc(p.username[0].toUpperCase())}
        </div>
        <div class="p-info">
          <div class="p-name">${esc(p.username)}${you ? ' 👤' : ''}</div>
          <div class="p-score">⭐ ${p.score} pts</div>
        </div>
      `;
      mobGamePlayers.appendChild(li);
    });
}

// Tab switching
document.querySelectorAll('.mob-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mob-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    ['colors','brush','tools','players'].forEach(p => {
      const el = $(`mob-panel-${p}`);
      if (el) el.style.display = (p === name) ? 'flex' : 'none';
    });
  });
});

// Mobile custom colour picker
if (mobCustomColor) {
  mobCustomColor.addEventListener('input', () => {
    pickColor(mobCustomColor.value);
    syncMobilePalette();
  });
}

// Mobile brush size
if (mobBrushSize) {
  mobBrushSize.addEventListener('input', () => {
    G.brushSize = Number(mobBrushSize.value);
    brushSize.value = mobBrushSize.value; // keep desktop slider in sync
    refreshBrushDot();
    refreshMobileBrushDot();
  });
}

// Keep desktop brush slider synced → mobile
brushSize.addEventListener('input', () => {
  if (mobBrushSize) mobBrushSize.value = brushSize.value;
  refreshMobileBrushDot();
});

// Mobile tool buttons
Object.entries(MOB_TOOL_MAP).forEach(([name, btn]) => {
  if (btn) btn.addEventListener('click', () => {
    setTool(name);
    syncMobileToolBtns();
    syncMobilePalette();
  });
});

// Mobile undo / clear
const mobBtnUndo  = $('mob-btn-undo');
const mobBtnClear = $('mob-btn-clear');
if (mobBtnUndo)  mobBtnUndo.addEventListener('click',  () => btnUndo.click());
if (mobBtnClear) mobBtnClear.addEventListener('click', () => btnClear.click());

// Show/hide toolbar when entering/leaving game screen
// We override showScreen here so mobile toolbar syncs automatically
const _showScreenOrig = showScreen;
showScreen = function(name) {
  _showScreenOrig(name);
  showMobileToolbar(name === 'game' && isMobile());
};

// Re-check on resize in case orientation changes
window.addEventListener('resize', () => {
  const onGame = scrGame.classList.contains('active');
  showMobileToolbar(onGame && isMobile());
  refreshBrushDot();
  refreshMobileBrushDot();
});

// Sync mobile player list whenever the desktop one is rendered
// We hook into G.players directly via a helper called after renderGamePlayers
function _syncMobileAfterRender(players) {
  renderMobilePlayers(players);
}


// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

(function init() {
  buildPalette();
  buildMobilePalette();
  initCanvas();
  resizeCanvas();
  setTool('brush');
  refreshBrushDot();
  refreshMobileBrushDot();
  showScreen('lobby');
  showMobileToolbar(false); // hidden until game screen
  console.log('🎨 SpeedDraw client ready');
})();

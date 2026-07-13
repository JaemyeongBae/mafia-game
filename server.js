const express = require('express');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// QR 코드 생성 (방 참가 링크)
app.get('/qr', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url required');
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 });
    res.json({ dataUrl });
  } catch (e) {
    res.status(500).send('qr error');
  }
});

// ─── 게임 상태 ───────────────────────────────────────────
const rooms = new Map(); // code -> room

function genCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function createRoom(hostName) {
  const code = genCode();
  const hostId = genId();
  const room = {
    code,
    hostId,
    players: new Map(), // playerId -> {id, name, connected, role, alive}
    moderatorId: null,
    phase: 'lobby', // lobby | reveal | night | day | vote | ended
    settings: { mafia: 1, police: 1, doctor: 1 },
    night: { mafiaTarget: null, doctorTarget: null, policeTarget: null },
    votes: new Map(), // voterId -> targetId
    dayCount: 0,
    lastNightResult: null,
    winner: null,
    log: [],
    chat: [],
  };
  room.players.set(hostId, { id: hostId, name: hostName, connected: true, role: null, alive: true });
  rooms.set(code, room);
  return { room, hostId };
}

function alivePlayers(room) {
  return [...room.players.values()].filter((p) => p.alive && p.id !== room.moderatorId);
}

function aliveByRole(room, role) {
  return alivePlayers(room).filter((p) => p.role === role);
}

function checkWin(room) {
  const mafia = aliveByRole(room, 'mafia').length;
  const others = alivePlayers(room).length - mafia;
  if (mafia === 0) return 'citizen';
  if (mafia >= others) return 'mafia';
  return null;
}

// ─── 상태 전송 ───────────────────────────────────────────
function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    moderatorId: room.moderatorId,
    phase: room.phase,
    settings: room.settings,
    dayCount: room.dayCount,
    winner: room.winner,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      alive: p.alive,
      // 게임 종료 시에만 전체 역할 공개
      role: room.phase === 'ended' ? p.role : undefined,
    })),
    voteCount: room.phase === 'vote' ? room.votes.size : 0,
    aliveCount: room.phase === 'lobby' ? null : alivePlayers(room).length,
    chat: room.phase === 'lobby' ? room.chat.slice(-50) : [],
  };
}

function privateState(room, player) {
  const priv = { role: player.role, alive: player.alive };
  if (player.role === 'mafia') {
    priv.mafiaTeam = [...room.players.values()]
      .filter((p) => p.role === 'mafia')
      .map((p) => p.name);
    priv.mafiaTarget = room.night.mafiaTarget;
  }
  if (player.role === 'doctor') priv.doctorTarget = room.night.doctorTarget;
  if (player.role === 'police') {
    priv.policeTarget = room.night.policeTarget;
    if (room.night.policeTarget) {
      const t = room.players.get(room.night.policeTarget);
      priv.policeResult = { name: t.name, isMafia: t.role === 'mafia' };
    }
  }
  if (player.id === room.moderatorId) {
    priv.moderator = {
      roles: [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, role: p.role, alive: p.alive,
      })),
      night: {
        mafiaTarget: room.night.mafiaTarget && room.players.get(room.night.mafiaTarget)?.name,
        doctorTarget: room.night.doctorTarget && room.players.get(room.night.doctorTarget)?.name,
        policeTarget: room.night.policeTarget && room.players.get(room.night.policeTarget)?.name,
      },
      votes: [...room.votes.entries()].map(([v, t]) => ({
        voter: room.players.get(v)?.name,
        target: room.players.get(t)?.name || '기권',
        targetId: t,
      })),
      lastNightResult: room.lastNightResult,
      log: room.log,
    };
  }
  if (player.myVote === undefined) priv.myVote = room.votes.get(player.id) ?? null;
  return priv;
}

function broadcast(room) {
  const pub = publicState(room);
  for (const [sid, socket] of io.sockets.sockets) {
    if (socket.data.roomCode !== room.code) continue;
    const player = room.players.get(socket.data.playerId);
    if (!player) continue;
    socket.emit('state', { ...pub, me: { id: player.id, ...privateState(room, player) } });
  }
}

// ─── 소켓 핸들러 ─────────────────────────────────────────
io.on('connection', (socket) => {
  const bind = (room, playerId) => {
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    socket.join(room.code);
  };

  socket.on('createRoom', ({ name }, cb) => {
    name = String(name || '').trim().slice(0, 12);
    if (!name) return cb({ error: '이름을 입력하세요' });
    const { room, hostId } = createRoom(name);
    bind(room, hostId);
    cb({ code: room.code, playerId: hostId });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    const room = rooms.get(String(code));
    if (!room) return cb({ error: '방을 찾을 수 없어요' });
    if (room.phase !== 'lobby') return cb({ error: '이미 게임이 시작됐어요' });
    name = String(name || '').trim().slice(0, 12);
    if (!name) return cb({ error: '이름을 입력하세요' });
    if ([...room.players.values()].some((p) => p.name === name))
      return cb({ error: '이미 있는 이름이에요' });
    if (room.players.size >= 20) return cb({ error: '최대 20명까지 가능해요' });
    const id = genId();
    room.players.set(id, { id, name, connected: true, role: null, alive: true });
    bind(room, id);
    cb({ code: room.code, playerId: id });
    broadcast(room);
  });

  socket.on('rejoin', ({ code, playerId }, cb) => {
    const room = rooms.get(String(code));
    const player = room?.players.get(playerId);
    if (!room || !player) return cb({ error: 'no-room' });
    player.connected = true;
    bind(room, playerId);
    cb({ ok: true });
    broadcast(room);
  });

  const getCtx = () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    return room && player ? { room, player } : null;
  };

  socket.on('updateSettings', (settings) => {
    const ctx = getCtx();
    if (!ctx || ctx.player.id !== ctx.room.hostId || ctx.room.phase !== 'lobby') return;
    const clamp = (n) => Math.max(0, Math.min(5, parseInt(n, 10) || 0));
    ctx.room.settings = {
      mafia: Math.max(1, clamp(settings.mafia)),
      police: clamp(settings.police),
      doctor: clamp(settings.doctor),
    };
    broadcast(ctx.room);
  });

  socket.on('startGame', (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    const ctx = getCtx();
    if (!ctx || ctx.player.id !== ctx.room.hostId || ctx.room.phase !== 'lobby') return;
    const { room } = ctx;
    const n = room.players.size;
    const { mafia, police, doctor } = room.settings;
    const special = mafia + police + doctor;
    // 사회자 1명 + 특수직업 + 최소 시민 1명
    if (n < special + 2)
      return cb?.({ error: `이 설정에는 최소 ${special + 2}명이 필요해요 (현재 ${n}명)` });

    // 방장이 사회자, 나머지는 랜덤 섞어서 역할 배정
    room.moderatorId = room.hostId;
    const ids = [...room.players.keys()].filter((id) => id !== room.hostId);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const roles = [
      ...Array(mafia).fill('mafia'),
      ...Array(police).fill('police'),
      ...Array(doctor).fill('doctor'),
    ];
    ids.forEach((id, i) => {
      room.players.get(id).role = roles[i] || 'citizen';
    });
    room.players.get(room.moderatorId).role = 'moderator';
    room.phase = 'reveal';
    room.log.push('게임 시작 — 역할이 배정되었습니다');
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('nightAction', ({ target }) => {
    const ctx = getCtx();
    if (!ctx || ctx.room.phase !== 'night' || !ctx.player.alive) return;
    const { room, player } = ctx;
    const t = room.players.get(target);
    if (!t || !t.alive || t.id === room.moderatorId) return;
    if (player.role === 'mafia') room.night.mafiaTarget = target;
    else if (player.role === 'doctor') room.night.doctorTarget = target;
    else if (player.role === 'police' && !room.night.policeTarget)
      room.night.policeTarget = target; // 경찰 조사는 한 번 정하면 확정
    else return;
    broadcast(room);
  });

  socket.on('chatMessage', ({ text }) => {
    const ctx = getCtx();
    if (!ctx || ctx.room.phase !== 'lobby') return;
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    ctx.room.chat.push({ name: ctx.player.name, text, ts: Date.now() });
    if (ctx.room.chat.length > 100) ctx.room.chat.shift();
    broadcast(ctx.room);
  });

  socket.on('vote', ({ target }) => {
    const ctx = getCtx();
    if (!ctx || ctx.room.phase !== 'vote' || !ctx.player.alive) return;
    const { room, player } = ctx;
    if (player.id === room.moderatorId) return;
    if (target !== null) {
      const t = room.players.get(target);
      if (!t || !t.alive || t.id === room.moderatorId) return;
    }
    room.votes.set(player.id, target);
    broadcast(room);
  });

  // ── 사회자 진행 ──
  const isModerator = (ctx) => ctx && ctx.player.id === ctx.room.moderatorId;

  socket.on('modStartNight', () => {
    const ctx = getCtx();
    if (!isModerator(ctx)) return;
    const { room } = ctx;
    if (!['reveal', 'day'].includes(room.phase)) return;
    room.phase = 'night';
    room.dayCount += 1;
    room.night = { mafiaTarget: null, doctorTarget: null, policeTarget: null };
    room.log.push(`${room.dayCount}번째 밤 시작`);
    broadcast(room);
  });

  socket.on('modEndNight', () => {
    const ctx = getCtx();
    if (!isModerator(ctx) || ctx.room.phase !== 'night') return;
    const { room } = ctx;
    const { mafiaTarget, doctorTarget } = room.night;
    let result;
    if (mafiaTarget && mafiaTarget !== doctorTarget) {
      const victim = room.players.get(mafiaTarget);
      victim.alive = false;
      result = { killed: victim.name, saved: false };
      room.log.push(`밤 결과: ${victim.name} 사망`);
    } else if (mafiaTarget && mafiaTarget === doctorTarget) {
      result = { killed: null, saved: true, savedName: room.players.get(mafiaTarget).name };
      room.log.push(`밤 결과: 의사가 ${result.savedName}을(를) 살림`);
    } else {
      result = { killed: null, saved: false };
      room.log.push('밤 결과: 아무 일도 없었음');
    }
    room.lastNightResult = result;
    room.winner = checkWin(room);
    room.phase = room.winner ? 'ended' : 'day';
    if (room.winner) room.log.push(`게임 종료: ${room.winner === 'mafia' ? '마피아' : '시민'} 승리`);
    broadcast(room);
  });

  socket.on('modStartVote', () => {
    const ctx = getCtx();
    if (!isModerator(ctx) || ctx.room.phase !== 'day') return;
    ctx.room.phase = 'vote';
    ctx.room.votes = new Map();
    ctx.room.log.push('투표 시작');
    broadcast(ctx.room);
  });

  socket.on('modExecute', ({ target }) => {
    const ctx = getCtx();
    if (!isModerator(ctx) || ctx.room.phase !== 'vote') return;
    const { room } = ctx;
    if (target) {
      const t = room.players.get(target);
      if (!t || !t.alive) return;
      t.alive = false;
      room.log.push(`투표 결과: ${t.name} 처형`);
    } else {
      room.log.push('투표 결과: 처형 없음');
    }
    room.votes = new Map();
    room.winner = checkWin(room);
    room.phase = room.winner ? 'ended' : 'day';
    if (room.winner) room.log.push(`게임 종료: ${room.winner === 'mafia' ? '마피아' : '시민'} 승리`);
    broadcast(room);
  });

  socket.on('restartGame', () => {
    const ctx = getCtx();
    if (!ctx || ctx.player.id !== ctx.room.hostId || ctx.room.phase !== 'ended') return;
    const { room } = ctx;
    room.phase = 'lobby';
    room.moderatorId = null;
    room.dayCount = 0;
    room.winner = null;
    room.lastNightResult = null;
    room.votes = new Map();
    room.night = { mafiaTarget: null, doctorTarget: null, policeTarget: null };
    room.log = [];
    for (const p of room.players.values()) {
      p.role = null;
      p.alive = true;
    }
    broadcast(room);
  });

  socket.on('leaveRoom', () => {
    const ctx = getCtx();
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.phase === 'lobby') {
      room.players.delete(player.id);
      if (player.id === room.hostId) {
        const next = [...room.players.keys()][0];
        if (next) room.hostId = next;
        else return rooms.delete(room.code);
      }
    } else {
      player.connected = false;
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const ctx = getCtx();
    if (!ctx) return;
    ctx.player.connected = false;
    broadcast(ctx.room);
  });
});

// 6시간 이상 지난 빈 방 정리
setInterval(() => {
  for (const [code, room] of rooms) {
    if ([...room.players.values()].every((p) => !p.connected)) {
      room._emptyTicks = (room._emptyTicks || 0) + 1;
      if (room._emptyTicks > 12) rooms.delete(code); // 12 * 30분 = 6시간
    } else {
      room._emptyTicks = 0;
    }
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`마피아 서버 실행 중: http://localhost:${PORT}`));

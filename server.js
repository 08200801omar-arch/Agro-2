const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// Explicit home/health routes for hosts such as Render.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const rooms = new Map();

function roomCode() {
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); }
  while (rooms.has(code));
  return code;
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, score: p.score, answered: p.answered
  })).sort((a,b) => b.score-a.score);
}

function emitLobby(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("lobby:update", {
    players: publicPlayers(room),
    total: room.questions.length,
    questionIndex: room.index
  });
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function sendQuestion(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimer(room);
  if (room.index >= room.questions.length) return finishGame(code);

  room.state = "question";
  room.startedAt = Date.now();
  room.question = room.questions[room.index];
  for (const p of room.players.values()) p.answered = false;

  const q = room.question;
  io.to(code).emit("game:question", {
    index: room.index,
    total: room.questions.length,
    tema: q.tema,
    question: q.question,
    answers: q.answers,
    time: q.time
  });

  room.timer = setTimeout(() => revealQuestion(code, null), q.time * 1000);
  emitLobby(code);
}

function revealQuestion(code, forcedWinner) {
  const room = rooms.get(code);
  if (!room || room.state !== "question") return;
  clearTimer(room);
  room.state = "reveal";

  const q = room.question;
  io.to(code).emit("game:reveal", {
    correct: q.correct,
    leaderboard: publicPlayers(room),
    index: room.index,
    total: room.questions.length
  });
}

function finishGame(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimer(room);
  room.state = "finished";
  io.to(code).emit("game:finished", {
    leaderboard: publicPlayers(room)
  });
}

io.on("connection", socket => {
  socket.on("room:create", ({name, count, theme}) => {
    const code = roomCode();
    const all = require("./public/questions.js").QUESTIONS;
    let questions = [...all];
    if (theme && theme !== "all") questions = questions.filter(q => q.tema === theme);
    questions.sort(() => Math.random() - 0.5);
    if (count && count !== "all") questions = questions.slice(0, Math.max(1, Math.min(150, Number(count))));

    const room = {
      hostId: socket.id,
      players: new Map(),
      questions,
      index: 0,
      state: "lobby",
      timer: null,
      startedAt: null,
      question: null
    };
    rooms.set(code, room);
    room.players.set(socket.id, {id:socket.id, name:(name||"Anfitrión").trim().slice(0,24), score:0, answered:false, host:true});
    socket.join(code);
    socket.data.room = code;
    socket.data.host = true;
    socket.emit("room:created", {code});
    emitLobby(code);
  });

  socket.on("room:join", ({code,name}) => {
    code=String(code||"").trim();
    const room=rooms.get(code);
    if (!room) return socket.emit("error:message","No existe esa sala.");
    if (room.state !== "lobby") return socket.emit("error:message","La partida ya comenzó.");
    const clean=(name||"Jugador").trim().slice(0,24) || "Jugador";
    if ([...room.players.values()].some(p=>p.name.toLowerCase()===clean.toLowerCase()))
      return socket.emit("error:message","Ese nombre ya está ocupado.");
    room.players.set(socket.id,{id:socket.id,name:clean,score:0,answered:false,host:false});
    socket.join(code); socket.data.room=code; socket.data.host=false;
    socket.emit("room:joined",{code});
    emitLobby(code);
  });

  socket.on("game:start", () => {
    const code=socket.data.room, room=rooms.get(code);
    if (!room || room.hostId!==socket.id || room.state!=="lobby") return;
    room.index=0; sendQuestion(code);
  });

  socket.on("game:answer", ({choice}) => {
    const code=socket.data.room, room=rooms.get(code);
    if (!room || room.state!=="question") return;
    const p=room.players.get(socket.id);
    if (!p || p.answered) return;
    p.answered=true;
    const q=room.question;
    const elapsed=Math.max(0,Date.now()-room.startedAt);
    const remaining=Math.max(0, q.time*1000-elapsed);
    if (Number(choice)===q.correct) {
      const base=1000;
      const speed=Math.round(500*remaining/(q.time*1000));
      p.score += base+speed;
    }
    socket.emit("answer:accepted",{correct:Number(choice)===q.correct});
    io.to(code).emit("players:answers",{answered:[...room.players.values()].filter(x=>x.answered).length,total:room.players.size});
    if ([...room.players.values()].every(x=>x.answered)) revealQuestion(code,null);
  });

  socket.on("game:next", () => {
    const code=socket.data.room, room=rooms.get(code);
    if (!room || room.hostId!==socket.id || room.state!=="reveal") return;
    room.index++;
    if (room.index>=room.questions.length) finishGame(code);
    else sendQuestion(code);
  });

  socket.on("disconnect", () => {
    const code=socket.data.room, room=rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.hostId===socket.id) {
      clearTimer(room);
      io.to(code).emit("room:closed");
      rooms.delete(code);
    } else {
      emitLobby(code);
    }
  });
});

server.listen(PORT,()=>console.log(`Kahoot Agronomía escuchando en puerto ${PORT}`));

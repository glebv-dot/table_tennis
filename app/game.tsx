"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type DataConnection = {
  open: boolean;
  send: (payload: unknown) => void;
  close: () => void;
  on: {
    (event: "open" | "close" | "error", callback: () => void): void;
    (event: "data", callback: (data: unknown) => void): void;
  };
};
type Peer = {
  connect: (id: string, options?: Record<string, unknown>) => DataConnection;
  destroy: () => void;
  on: {
    (event: "open", callback: (id: string) => void): void;
    (event: "connection", callback: (connection: DataConnection) => void): void;
    (event: "error", callback: () => void): void;
  };
};
type IceServer = { urls: string | string[]; username?: string; credential?: string };
type PeerOptions = { config?: { iceServers: IceServer[] } };
type PeerConstructor = new (id?: string, options?: PeerOptions) => Peer;

declare global { interface Window { Peer?: PeerConstructor } }

// STUN handles simple NATs; the TURN relay is what makes cross-network play
// actually work (mobile data, corporate/symmetric NAT). Without it, peers on
// different networks never open a data channel and the lobby hangs forever.
// These are free public servers — swap in your own TURN creds for production.
const ICE_SERVERS: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

// How long to wait for a peer connection before telling the user it failed,
// instead of leaving them staring at a frozen lobby.
const CONNECT_TIMEOUT_MS = 25000;

let peerLoader: Promise<PeerConstructor> | null = null;
const loadPeer = () => {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!peerLoader) peerLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js";
    script.onload = () => window.Peer ? resolve(window.Peer) : reject(new Error("PeerJS unavailable"));
    script.onerror = () => reject(new Error("PeerJS failed to load"));
    document.head.appendChild(script);
  });
  return peerLoader;
};

type Phase = "lobby" | "connecting" | "waiting" | "playing" | "ended";
type Player = "host" | "guest";
type GameState = {
  ball: { x: number; z: number; vx: number; vz: number };
  paddles: { host: number; guest: number };
  score: { host: number; guest: number };
  serving: Player;
  winner?: Player;
};

const initialState = (): GameState => ({
  ball: { x: 0, z: 0.18, vx: 0.24, vz: 0.56 },
  paddles: { host: 0, guest: 0 },
  score: { host: 0, guest: 0 },
  serving: "host",
});

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const stateRef = useRef<GameState>(initialState());
  const roleRef = useRef<Player>("host");
  const phaseRef = useRef<Phase>("lobby");
  const rafRef = useRef(0);
  const connectTimerRef = useRef<number | undefined>(undefined);
  const keysRef = useRef(new Set<string>());
  const [phase, setPhaseState] = useState<Phase>("lobby");
  const [role, setRole] = useState<Player>("host");
  const [roomUrl, setRoomUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [score, setScore] = useState({ host: 0, guest: 0 });
  const [winner, setWinner] = useState<Player | undefined>();
  const [status, setStatus] = useState("Choose how you want to play");

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const send = useCallback((payload: unknown) => {
    const conn = connRef.current;
    if (conn?.open) conn.send(payload);
  }, []);

  const resetRound = useCallback((server: Player) => {
    const s = stateRef.current;
    s.serving = server;
    s.ball = {
      x: 0,
      z: server === "host" ? 0.18 : 0.82,
      vx: (Math.random() * 0.38 - 0.19) || 0.12,
      vz: server === "host" ? 0.58 : -0.58,
    };
  }, []);

  const finishConnection = useCallback((conn: DataConnection, playerRole: Player) => {
    window.clearTimeout(connectTimerRef.current);
    connRef.current = conn;
    roleRef.current = playerRole;
    setRole(playerRole);
    setStatus("Connected · first to 7 wins");
    setPhase("playing");
    stateRef.current = initialState();
    setScore({ host: 0, guest: 0 });
    setWinner(undefined);

    conn.on("data", (raw) => {
      const msg = raw as { type?: string; x?: number; state?: GameState };
      if (msg.type === "paddle" && playerRole === "host" && typeof msg.x === "number") {
        stateRef.current.paddles.guest = clamp(msg.x, -0.82, 0.82);
      }
      if (msg.type === "state" && playerRole === "guest" && msg.state) {
        stateRef.current = msg.state;
        setScore(msg.state.score);
        if (msg.state.winner) {
          setWinner(msg.state.winner);
          setPhase("ended");
        }
      }
      if (msg.type === "restart" && playerRole === "host") {
        stateRef.current = initialState();
        setScore({ host: 0, guest: 0 });
        setWinner(undefined);
        setPhase("playing");
      }
    });
    conn.on("close", () => {
      setStatus("Your opponent left the table");
      setPhase("waiting");
    });
    conn.on("error", () => {
      setStatus("Connection lost. Try a fresh room.");
      setPhase("waiting");
    });
  }, [setPhase]);

  const createRoom = useCallback(async () => {
    setPhase("connecting");
    setStatus("Opening a table…");
    const PeerClass = await loadPeer();
    const peer = new PeerClass(undefined, { config: { iceServers: ICE_SERVERS } });
    peerRef.current = peer;
    peer.on("open", (id) => {
      const url = new URL(window.location.href);
      url.searchParams.set("room", id);
      setRoomUrl(url.toString());
      window.history.replaceState({}, "", url);
      setStatus("Send the link to your opponent");
      setPhase("waiting");
    });
    peer.on("connection", (conn) => {
      // The incoming connection isn't usable until its channel opens; only then
      // do we start the match, so a failed handshake doesn't strand the host.
      if (conn.open) finishConnection(conn, "host");
      else conn.on("open", () => finishConnection(conn, "host"));
    });
    peer.on("error", () => {
      setStatus("Couldn’t open a room. Please try again.");
      setPhase("lobby");
    });
  }, [finishConnection, setPhase]);

  const joinRoom = useCallback(async (roomId: string) => {
    setPhase("connecting");
    setStatus("Joining the table…");
    const PeerClass = await loadPeer();
    const peer = new PeerClass(undefined, { config: { iceServers: ICE_SERVERS } });
    peerRef.current = peer;
    // If the data channel never opens (unreachable host / blocked network),
    // surface it instead of spinning on "Joining…" forever.
    connectTimerRef.current = window.setTimeout(() => {
      if (phaseRef.current === "playing") return;
      peerRef.current?.destroy();
      peerRef.current = null;
      setStatus("Couldn’t reach the host. Check the link or try a different network.");
      setPhase("lobby");
    }, CONNECT_TIMEOUT_MS);
    peer.on("open", () => {
      const conn = peer.connect(roomId, { reliable: false, serialization: "json" });
      conn.on("open", () => finishConnection(conn, "guest"));
      conn.on("error", () => {
        window.clearTimeout(connectTimerRef.current);
        setStatus("That room is no longer available.");
        setPhase("lobby");
      });
    });
    peer.on("error", () => {
      window.clearTimeout(connectTimerRef.current);
      setStatus("That room is no longer available.");
      setPhase("lobby");
    });
  }, [finishConnection, setPhase]);

  useEffect(() => {
    const room = new URLSearchParams(window.location.search).get("room");
    const joinTimer = room ? window.setTimeout(() => joinRoom(room), 0) : undefined;
    return () => {
      if (joinTimer) window.clearTimeout(joinTimer);
      window.clearTimeout(connectTimerRef.current);
      cancelAnimationFrame(rafRef.current);
      connRef.current?.close();
      peerRef.current?.destroy();
    };
  }, [joinRoom]);

  const movePaddle = useCallback((x: number) => {
    const s = stateRef.current;
    const player = roleRef.current;
    s.paddles[player] = clamp(x, -0.82, 0.82);
    if (player === "guest") send({ type: "paddle", x: s.paddles.guest });
  }, [send]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "a", "d", "A", "D"].includes(e.key)) e.preventDefault();
      keysRef.current.add(e.key.toLowerCase());
    };
    const offKey = (e: KeyboardEvent) => keysRef.current.delete(e.key.toLowerCase());
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", offKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", offKey);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let last = performance.now();
    let networkTick = 0;

    const project = (x: number, z: number, w: number, h: number, flip: boolean) => {
      const depth = flip ? 1 - z : z;
      const topY = h * 0.205;
      const bottomY = h * 0.91;
      const y = topY + Math.pow(depth, 1.32) * (bottomY - topY);
      const half = w * (0.13 + depth * 0.37);
      return { x: w / 2 + x * half, y, scale: 0.35 + depth * 0.9 };
    };

    const draw = (now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const dt = Math.min((now - last) / 1000, 0.03);
      last = now;
      const s = stateRef.current;
      const player = roleRef.current;

      if (phaseRef.current === "playing") {
        const left = keysRef.current.has("arrowleft") || keysRef.current.has("a");
        const right = keysRef.current.has("arrowright") || keysRef.current.has("d");
        if (left || right) movePaddle(s.paddles[player] + (right ? 1 : -1) * dt * 1.55);

        if (player === "host") {
          const ballState = s.ball;
          ballState.x += ballState.vx * dt;
          ballState.z += ballState.vz * dt;
          if (Math.abs(ballState.x) > 0.94) {
            ballState.x = Math.sign(ballState.x) * 0.94;
            ballState.vx *= -1;
          }
          const hitHost = ballState.vz < 0 && ballState.z < 0.075 && ballState.z > -0.02 && Math.abs(ballState.x - s.paddles.host) < 0.29;
          const hitGuest = ballState.vz > 0 && ballState.z > 0.925 && ballState.z < 1.02 && Math.abs(ballState.x - s.paddles.guest) < 0.29;
          if (hitHost || hitGuest) {
            const paddle = hitHost ? s.paddles.host : s.paddles.guest;
            ballState.z = hitHost ? 0.078 : 0.922;
            ballState.vz = (hitHost ? 1 : -1) * Math.min(Math.abs(ballState.vz) * 1.045, 0.92);
            ballState.vx = clamp(ballState.vx + (ballState.x - paddle) * 0.72, -0.7, 0.7);
          }
          if (ballState.z < -0.08 || ballState.z > 1.08) {
            const point: Player = ballState.z < 0 ? "guest" : "host";
            s.score[point] += 1;
            setScore({ ...s.score });
            if (s.score[point] >= 7) {
              s.winner = point;
              setWinner(point);
              send({ type: "state", state: s });
              setPhase("ended");
            } else resetRound(point === "host" ? "guest" : "host");
          }
          networkTick += dt;
          if (networkTick > 1 / 30) {
            send({ type: "state", state: s });
            networkTick = 0;
          }
        }
      }

      // ---- TRON backdrop ----
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, "#04101f"); bg.addColorStop(0.55, "#050b18"); bg.addColorStop(1, "#02040a");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      const glow = ctx.createRadialGradient(w / 2, h * 0.2, 10, w / 2, h * 0.2, w * 0.62);
      glow.addColorStop(0, "rgba(25,231,255,.14)"); glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);

      const flip = player === "guest";
      const a = project(-1, 0, w, h, flip), b = project(1, 0, w, h, flip), c = project(1, 1, w, h, flip), d = project(-1, 1, w, h, flip);

      // Dark table slab.
      const table = ctx.createLinearGradient(0, d.y, 0, a.y);
      table.addColorStop(0, "rgba(8,27,42,.94)"); table.addColorStop(1, "rgba(5,15,26,.94)"); ctx.fillStyle = table;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill();

      // Neon perspective grid across the playfield.
      ctx.save();
      ctx.strokeStyle = "rgba(25,231,255,.26)"; ctx.lineWidth = 1; ctx.shadowColor = "rgba(25,231,255,.5)"; ctx.shadowBlur = 6;
      for (let i = 1; i < 10; i++) {
        const zz = i / 10, l = project(-1, zz, w, h, flip), r = project(1, zz, w, h, flip);
        ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
      }
      for (let i = 1; i < 8; i++) {
        const xx = -1 + (2 * i) / 8, t = project(xx, 0, w, h, flip), bt = project(xx, 1, w, h, flip);
        ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(bt.x, bt.y); ctx.stroke();
      }
      ctx.restore();

      // Glowing table border.
      ctx.save(); ctx.shadowColor = "rgba(25,231,255,.85)"; ctx.shadowBlur = 16;
      ctx.strokeStyle = "rgba(130,246,255,.95)"; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.stroke();
      ctx.restore();

      // Center line.
      const center1 = project(0, 0, w, h, flip), center2 = project(0, 1, w, h, flip);
      ctx.save(); ctx.shadowColor = "rgba(25,231,255,.7)"; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(center1.x, center1.y); ctx.lineTo(center2.x, center2.y); ctx.strokeStyle = "rgba(25,231,255,.5)"; ctx.lineWidth = 1.2; ctx.stroke(); ctx.restore();

      // Net.
      const nl = project(-1.05, 0.5, w, h, flip), nr = project(1.05, 0.5, w, h, flip);
      ctx.beginPath(); ctx.moveTo(nl.x, nl.y - 16); ctx.lineTo(nr.x, nr.y - 16); ctx.lineTo(nr.x, nr.y + 2); ctx.lineTo(nl.x, nl.y + 2); ctx.closePath();
      ctx.fillStyle = "rgba(4,13,23,.72)"; ctx.fill();
      ctx.save(); ctx.shadowColor = "rgba(25,231,255,.7)"; ctx.shadowBlur = 12;
      ctx.strokeStyle = "rgba(130,246,255,.9)"; ctx.lineWidth = 1.4; ctx.stroke(); ctx.restore();

      const drawPaddle = (x: number, z: number, mine: boolean) => {
        const p = project(x, z, w, h, flip); const pw = 74 * p.scale; const ph = 12 * p.scale;
        ctx.save(); ctx.translate(p.x, p.y - ph * 1.35); ctx.shadowColor = mine ? "rgba(25,231,255,.8)" : "rgba(255,138,30,.75)"; ctx.shadowBlur = 22;
        ctx.fillStyle = mine ? "#19e7ff" : "#ff8a1e"; ctx.beginPath(); ctx.roundRect(-pw / 2, -ph / 2, pw, ph, ph / 2); ctx.fill();
        ctx.shadowBlur = 0; ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.beginPath(); ctx.roundRect(-pw / 2 + 3, -ph / 2 + 2, pw - 6, ph * 0.32, ph * 0.16); ctx.fill();
        ctx.restore();
      };
      drawPaddle(s.paddles.host, 0.035, player === "host"); drawPaddle(s.paddles.guest, 0.965, player === "guest");
      const ball = project(s.ball.x, s.ball.z, w, h, flip);
      const lift = Math.sin(clamp(s.ball.z, 0, 1) * Math.PI) * h * 0.09 + 20 * ball.scale;
      ctx.fillStyle = "rgba(0,0,0,.32)"; ctx.beginPath(); ctx.ellipse(ball.x, ball.y, 13 * ball.scale, 5 * ball.scale, 0, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.shadowColor = "rgba(25,231,255,.95)"; ctx.shadowBlur = 24; ctx.fillStyle = "#eaffff";
      ctx.beginPath(); ctx.arc(ball.x, ball.y - lift, 7 * ball.scale, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [movePaddle, resetRound, send, setPhase]);

  const pointFromPointer = (clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) movePaddle(((clientX - rect.left) / rect.width - 0.5) * 2.05);
  };
  const copyLink = async () => {
    await navigator.clipboard.writeText(roomUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1800);
  };
  const restart = () => {
    if (role === "host") { stateRef.current = initialState(); setScore({ host: 0, guest: 0 }); setWinner(undefined); setPhase("playing"); }
    else send({ type: "restart" });
  };
  const leave = () => {
    window.clearTimeout(connectTimerRef.current);
    connRef.current?.close(); peerRef.current?.destroy(); connRef.current = null; peerRef.current = null; stateRef.current = initialState();
    window.history.replaceState({}, "", window.location.pathname); setRoomUrl(""); setScore({ host: 0, guest: 0 });
    setWinner(undefined); setStatus("Choose how you want to play"); setPhase("lobby");
  };

  const yourScore = role === "host" ? score.host : score.guest;
  const theirScore = role === "host" ? score.guest : score.host;
  const won = winner === role;

  return (
    <main className="game-shell">
      <canvas ref={canvasRef} className="game-canvas" onPointerMove={(e) => phase === "playing" && pointFromPointer(e.clientX)} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pointFromPointer(e.clientX); }} aria-label="First-person table tennis game" />
      <header className="topbar">
        <button className="brand" onClick={leave}><i /> RALLY<span>ROOM</span></button>
        {phase === "playing" || phase === "ended" ? <div className="scoreboard"><span>YOU <b>{yourScore}</b></span><em>FIRST TO 7</em><span><b>{theirScore}</b> RIVAL</span></div> : <div className="online"><i /> PEER-TO-PEER</div>}
        {phase !== "lobby" && <button className="leave" onClick={leave}>Leave table</button>}
      </header>

      {(phase === "lobby" || phase === "connecting" || phase === "waiting") && <section className="lobby-card">
        <p className="eyebrow"><span /> LIVE TABLE 01</p>
        <h1>One table.<br /><strong>Two players.</strong></h1>
        <p className="lede">First-person table tennis, played straight from the browser. Open a room and send one link.</p>
        {phase === "lobby" && <button className="primary" onClick={createRoom}>Create a private room <span>↗</span></button>}
        {phase === "connecting" && <div className="loading"><i /><span>{status}</span></div>}
        {phase === "waiting" && <div className="invite-box"><span className="invite-label">INVITE LINK</span><div><span>{roomUrl.replace(/^https?:\/\//, "")}</span><button onClick={copyLink}>{copied ? "COPIED" : "COPY"}</button></div><div className="invite-foot"><p><i /> Waiting for player two…</p><button className="cancel-room" onClick={leave}>Cancel</button></div></div>}
        <div className="how"><span>MOVE</span><kbd>A</kbd><kbd>D</kbd><span>OR DRAG / MOVE POINTER</span></div><small>{status}</small>
      </section>}

      {phase === "playing" && <div className="play-hud"><div className="role-tag"><span /> {role === "host" ? "NEAR SIDE" : "FAR SIDE"}</div><div className="hint">MOVE YOUR PADDLE <b>←</b><b>→</b></div></div>}
      {phase === "ended" && <section className="result-card"><p>{won ? "MATCH POINT" : "FINAL SCORE"}</p><h2>{won ? "You own the table." : "Good rally."}</h2><div className="final-score"><b>{yourScore}</b><span>—</span><b>{theirScore}</b></div><button className="primary" onClick={restart}>Play again <span>↻</span></button><button className="text-button" onClick={leave}>Leave the room</button></section>}
      <footer><span>NO SIGN-UP · NO DOWNLOAD</span><span>RALLYROOM / 2026</span></footer>
    </main>
  );
}

(() => {
  "use strict";

  // ---------- Setup ----------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const W = canvas.width;   // 480
  const H = canvas.height;  // 800

  const HORIZON_Y = 230;
  const BOTTOM_Y = 760;
  const LANE_X_BOTTOM = [110, 240, 370];
  const LANE_X_HORIZON = [216, 240, 264];
  const LANE_HALF_WIDTH_BOTTOM = 58;

  const PLAYER_BASE_Y = 690;

  const CFG = {
    baseSpeed: 0.42,        // z-units per second at start
    maxSpeed: 1.25,
    speedRampPerSec: 0.006, // how fast speed ramps up
    jumpHeight: 150,        // apex height in px
    jumpApexTime: 0.26,     // time in seconds to reach apex (natural, no fast-fall)
    fastFallMultiplier: 3.4,// extra gravity applied once fast-fall is triggered
    slideDuration: 0.5,
    laneLerp: 10,           // how snappy lane switching is
    spawnIntervalBase: 1.05,
    spawnIntervalMin: 0.62,
    hitWindowNear: 0.05,
    hitWindowFar: 0.12,
    trainClimbLenZ: 0.34,   // how much of the "track" a climbable train's roof covers
    roofHeight: 150,        // height player rides at while on top of a train
  };

  // v0 and gravity derived so a normal (non-fast-fall) jump reaches
  // CFG.jumpHeight at CFG.jumpApexTime, matching the old canned arc's feel.
  const GRAVITY = (CFG.jumpHeight * 2) / (CFG.jumpApexTime * CFG.jumpApexTime);
  const JUMP_V0 = GRAVITY * CFG.jumpApexTime;

  const scoreEl = document.getElementById("score");
  const bestValEl = document.getElementById("bestVal");
  const startScreen = document.getElementById("startScreen");
  const gameOverScreen = document.getElementById("gameOverScreen");
  const finalScoreEl = document.getElementById("finalScore");
  const newBestMsg = document.getElementById("newBestMsg");
  const startBtn = document.getElementById("startBtn");
  const restartBtn = document.getElementById("restartBtn");

  const HIGH_SCORE_KEY = "subwayRush.highScore";
  let highScore = 0;
  try {
    highScore = parseInt(localStorage.getItem(HIGH_SCORE_KEY) || "0", 10) || 0;
  } catch (e) {
    highScore = 0;
  }
  bestValEl.textContent = highScore;

  // ---------- Audio (simple synth, no assets) ----------
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }
  function beep(freq, duration, type = "square", gain = 0.06, delay = 0) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration);
  }
  const sfx = {
    jump: () => beep(520, 0.12, "square", 0.05),
    slide: () => beep(220, 0.12, "square", 0.05),
    coin: () => { beep(880, 0.08, "sine", 0.05); beep(1320, 0.09, "sine", 0.05, 0.05); },
    crash: () => { beep(140, 0.3, "sawtooth", 0.08); beep(80, 0.4, "sawtooth", 0.07, 0.05); },
    switch: () => beep(360, 0.06, "square", 0.03),
    fastFall: () => beep(180, 0.09, "square", 0.06),
    climb: () => { beep(440, 0.07, "square", 0.05); beep(660, 0.09, "square", 0.05, 0.06); },
    dismount: () => beep(300, 0.08, "square", 0.04),
  };

  // ---------- Helpers ----------
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function laneXAt(lane, t) {
    // t: 0 = at horizon (far), 1 = at bottom (near)
    return lerp(LANE_X_HORIZON[lane], LANE_X_BOTTOM[lane], t);
  }
  function laneHalfWidthAt(t) {
    return lerp(6, LANE_HALF_WIDTH_BOTTOM, t);
  }
  function yAt(t) {
    return lerp(HORIZON_Y, BOTTOM_Y, Math.pow(t, 1.6));
  }
  function scaleAt(t) {
    return lerp(0.22, 1.35, Math.pow(t, 1.15));
  }

  // ---------- Game State ----------
  let state = "start"; // start | playing | gameover
  let player, obstacles, coins, particles;
  let speed, elapsed, score, spawnTimer, distanceScore, bonusScore;
  let lastTime = 0;
  let shake = 0;

  function resetGame() {
    player = {
      lane: 1,
      targetLane: 1,
      x: LANE_X_BOTTOM[1],
      mode: "run",   // run | jump | slide
      layer: "ground", // ground | top (riding a train roof)
      timer: 0,
      animT: 0,
      jumpLift: 0,
      velocityY: 0,
      fastFalling: false,
      rideLane: null,
      rideTimer: 0,
    };
    obstacles = [];
    coins = [];
    particles = [];
    speed = CFG.baseSpeed;
    elapsed = 0;
    score = 0;
    distanceScore = 0;
    bonusScore = 0;
    spawnTimer = 0.6;
    shake = 0;
  }

  function dismountRoof() {
    // hop off a train roof: keep it airborne so low obstacles are still dodged
    // on the way down, reusing the normal jump gravity to fall naturally.
    player.layer = "ground";
    player.mode = "jump";
    player.jumpLift = CFG.roofHeight;
    player.velocityY = 0;
    player.fastFalling = false;
    player.rideLane = null;
    sfx.dismount();
  }

  // ---------- Input ----------
  function tryJump() {
    if (state !== "playing") return;
    if (player.layer === "top") return; // already up on a roof
    if (player.mode === "run") {
      player.mode = "jump";
      player.timer = 0;
      player.velocityY = JUMP_V0;
      player.jumpLift = 0;
      player.fastFalling = false;
      sfx.jump();
    }
  }
  function trySlide() {
    if (state !== "playing") return;
    if (player.layer === "top") return; // running on a roof, nothing to slide under
    if (player.mode === "run") {
      player.mode = "slide";
      player.timer = 0;
      sfx.slide();
    } else if (player.mode === "jump" && !player.fastFalling) {
      // pressed down mid-air: cancel any remaining rise and slam down early
      player.fastFalling = true;
      if (player.velocityY > 0) player.velocityY = 0;
      sfx.fastFall();
    }
  }
  function moveLane(dir) {
    if (state !== "playing") return;
    const nl = clamp(player.targetLane + dir, 0, 2);
    if (nl !== player.targetLane) {
      if (player.layer === "top" && nl !== player.rideLane) {
        dismountRoof(); // bail off the side of the train early
      }
      player.targetLane = nl;
      sfx.switch();
    }
  }

  window.addEventListener("keydown", (e) => {
    ensureAudio();
    switch (e.key) {
      case "ArrowLeft":
      case "a":
      case "A":
        e.preventDefault();
        if (state === "start") beginGame();
        else moveLane(-1);
        break;
      case "ArrowRight":
      case "d":
      case "D":
        e.preventDefault();
        if (state === "start") beginGame();
        else moveLane(1);
        break;
      case "ArrowUp":
      case "w":
      case "W":
      case " ":
        e.preventDefault();
        if (state === "start") beginGame();
        else if (state === "gameover") beginGame();
        else tryJump();
        break;
      case "ArrowDown":
      case "s":
      case "S":
        e.preventDefault();
        if (state === "playing") trySlide();
        break;
      case "Enter":
        if (state === "start") beginGame();
        else if (state === "gameover") beginGame();
        break;
    }
  });

  // Touch swipe
  let touchStartX = 0, touchStartY = 0, touchActive = false;
  canvas.addEventListener("touchstart", (e) => {
    ensureAudio();
    const t = e.changedTouches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchActive = true;
  }, { passive: true });

  canvas.addEventListener("touchend", (e) => {
    if (!touchActive) return;
    touchActive = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    const adx = Math.abs(dx), ady = Math.abs(dy);

    if (state === "start") { beginGame(); return; }
    if (state === "gameover") { return; }

    const THRESH = 24;
    if (Math.max(adx, ady) < THRESH) return;

    if (adx > ady) {
      moveLane(dx > 0 ? 1 : -1);
    } else {
      if (dy < 0) tryJump();
      else trySlide();
    }
  }, { passive: true });

  canvas.addEventListener("click", () => {
    if (state === "start") beginGame();
  });

  // On-screen buttons
  document.getElementById("btnLeft").addEventListener("touchstart", (e) => { e.preventDefault(); ensureAudio(); moveLane(-1); }, { passive: false });
  document.getElementById("btnRight").addEventListener("touchstart", (e) => { e.preventDefault(); ensureAudio(); moveLane(1); }, { passive: false });
  document.getElementById("btnJump").addEventListener("touchstart", (e) => { e.preventDefault(); ensureAudio(); tryJump(); }, { passive: false });
  document.getElementById("btnSlide").addEventListener("touchstart", (e) => { e.preventDefault(); ensureAudio(); trySlide(); }, { passive: false });
  document.getElementById("btnLeft").addEventListener("click", () => { ensureAudio(); moveLane(-1); });
  document.getElementById("btnRight").addEventListener("click", () => { ensureAudio(); moveLane(1); });
  document.getElementById("btnJump").addEventListener("click", () => { ensureAudio(); tryJump(); });
  document.getElementById("btnSlide").addEventListener("click", () => { ensureAudio(); trySlide(); });

  startBtn.addEventListener("click", () => { ensureAudio(); beginGame(); });
  restartBtn.addEventListener("click", () => { ensureAudio(); beginGame(); });

  // ---------- Spawning ----------
  function spawnWave() {
    const lanes = [0, 1, 2];
    const roll = Math.random();

    if (roll < 0.18) {
      spawnClimbableTrainWave();
    } else if (roll < 0.66) {
      // 1-2 obstacle lanes, rest coins/open
      const blockedCount = Math.random() < 0.35 ? 2 : 1;
      const shuffled = lanes.slice().sort(() => Math.random() - 0.5);
      const blocked = shuffled.slice(0, blockedCount);
      const typeRoll = Math.random();
      const type = typeRoll < 0.4 ? "train" : (typeRoll < 0.7 ? "low" : "high");

      blocked.forEach((lane) => {
        obstacles.push({ lane, type, z: 1, resolved: false });
      });

      const openLanes = lanes.filter((l) => !blocked.includes(l));
      if (openLanes.length && Math.random() < 0.8) {
        const coinLane = openLanes[Math.floor(Math.random() * openLanes.length)];
        spawnCoinLine(coinLane, 1, 4 + Math.floor(Math.random() * 3));
      }
    } else {
      // pure coin pattern across a lane, or an arc for a jump
      const lane = lanes[Math.floor(Math.random() * 3)];
      if (Math.random() < 0.3) {
        // put a low barrier before it to make jumping natural, plus coins in arc
        obstacles.push({ lane, type: "low", z: 1, resolved: false });
      }
      spawnCoinLine(lane, 1, 5 + Math.floor(Math.random() * 4));
    }
  }

  function spawnClimbableTrainWave() {
    // a special train with a boardable roof: jump onto it as it arrives to
    // ride its roof instead of switching lanes to dodge it
    const lane = Math.floor(Math.random() * 3);
    obstacles.push({ lane, type: "train", climbable: true, z: 1, resolved: false });

    const openLanes = [0, 1, 2].filter((l) => l !== lane);
    if (Math.random() < 0.6) {
      const coinLane = openLanes[Math.floor(Math.random() * openLanes.length)];
      spawnCoinLine(coinLane, 1, 4 + Math.floor(Math.random() * 3));
    }
  }

  function spawnCoinLine(lane, startZ, count) {
    const step = 0.045;
    for (let i = 0; i < count; i++) {
      coins.push({ lane, z: startZ + i * step, collected: false });
    }
  }

  // ---------- Update ----------
  function update(dt) {
    elapsed += dt;
    speed = Math.min(CFG.maxSpeed, CFG.baseSpeed + elapsed * CFG.speedRampPerSec);

    // player lane lerp
    const targetX = LANE_X_BOTTOM[player.targetLane];
    player.x = lerp(player.x, targetX, Math.min(1, CFG.laneLerp * dt));
    player.lane = player.targetLane;
    player.animT += dt * (8 + speed * 6);

    if (player.layer === "top") {
      // riding a train roof: hold at a fixed elevation until the roof runs out
      player.rideTimer -= dt;
      if (player.rideTimer <= 0) {
        dismountRoof();
      }
    } else if (player.mode === "jump") {
      const g = GRAVITY * (player.fastFalling ? CFG.fastFallMultiplier : 1);
      player.velocityY -= g * dt;
      player.jumpLift += player.velocityY * dt;
      if (player.jumpLift <= 0) {
        player.jumpLift = 0;
        player.velocityY = 0;
        player.fastFalling = false;
        player.mode = "run";
      }
    } else if (player.mode === "slide") {
      player.timer += dt;
      if (player.timer >= CFG.slideDuration) {
        player.mode = "run";
        player.timer = 0;
      }
    }

    // spawn
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnWave();
      const interval = Math.max(CFG.spawnIntervalMin, CFG.spawnIntervalBase - elapsed * 0.01);
      spawnTimer = interval * (0.85 + Math.random() * 0.3);
    }

    // obstacles
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      o.z -= speed * dt;

      if (!o.resolved && o.z <= 0.16 && o.z >= 0.03 && o.lane === player.lane && player.layer !== "top") {
        let hit = false;
        if (o.type === "train") {
          if (o.climbable && player.mode === "jump") {
            player.layer = "top";
            player.mode = "run";
            player.jumpLift = 0;
            player.velocityY = 0;
            player.fastFalling = false;
            player.rideLane = o.lane;
            player.rideTimer = CFG.trainClimbLenZ / Math.max(speed, 0.15);
            bonusScore += 20;
            sfx.climb();
          } else {
            hit = true;
          }
        } else if (o.type === "low") {
          hit = player.mode !== "jump";
        } else if (o.type === "high") {
          hit = player.mode !== "slide";
        }
        if (hit) {
          o.resolved = true;
          triggerGameOver();
          return;
        } else {
          o.resolved = true;
        }
      }

      if (o.z < -0.05) obstacles.splice(i, 1);
    }

    // coins
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      c.z -= speed * dt;
      if (!c.collected && c.z <= 0.14 && c.z >= 0.02 && c.lane === player.lane) {
        c.collected = true;
        spawnCoinBurst(c);
        sfx.coin();
      }
      if (c.z < -0.05) coins.splice(i, 1);
    }

    // particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 400 * dt;
      if (p.life <= 0) particles.splice(i, 1);
    }

    distanceScore += speed * dt * 18;
    score = Math.floor(distanceScore + coinTotal() + bonusScore);
    scoreEl.textContent = score;

    if (shake > 0) shake = Math.max(0, shake - dt * 3);
  }

  let coinTotalCount = 0;
  function coinTotal() { return coinTotalCount * 10; }

  function spawnCoinBurst(c) {
    coinTotalCount += 1;
    const t = 1 - c.z;
    const x = laneXAt(c.lane, t);
    const y = yAt(t) - 40 * scaleAt(t);
    for (let i = 0; i < 8; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 60 + Math.random() * 90;
      particles.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 40,
        life: 0.4 + Math.random() * 0.2,
        maxLife: 0.6,
        size: 2 + Math.random() * 2,
        color: "#ffd23f",
      });
    }
  }

  function triggerGameOver() {
    state = "gameover";
    shake = 1;
    sfx.crash();
    const finalScore = Math.floor(distanceScore + coinTotal() + bonusScore);
    finalScoreEl.textContent = finalScore;
    if (finalScore > highScore) {
      highScore = finalScore;
      try { localStorage.setItem(HIGH_SCORE_KEY, String(highScore)); } catch (e) {}
      newBestMsg.classList.remove("hidden");
    } else {
      newBestMsg.classList.add("hidden");
    }
    bestValEl.textContent = highScore;
    gameOverScreen.classList.remove("hidden");
  }

  function beginGame() {
    coinTotalCount = 0;
    resetGame();
    state = "playing";
    startScreen.classList.add("hidden");
    gameOverScreen.classList.add("hidden");
  }

  // ---------- Drawing ----------
  function drawBackground() {
    const skyGrad = ctx.createLinearGradient(0, 0, 0, HORIZON_Y);
    skyGrad.addColorStop(0, "#2b3a67");
    skyGrad.addColorStop(1, "#4a6fa5");
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, HORIZON_Y);

    // distant skyline
    ctx.fillStyle = "rgba(20,25,45,0.55)";
    for (let i = 0; i < 8; i++) {
      const bw = 30 + (i % 3) * 14;
      const bh = 40 + ((i * 37) % 70);
      const bx = (i * 65 - ((elapsed * 12) % 65)) % (W + 80) - 40;
      ctx.fillRect(bx, HORIZON_Y - bh, bw, bh);
    }

    const groundGrad = ctx.createLinearGradient(0, HORIZON_Y, 0, H);
    groundGrad.addColorStop(0, "#374357");
    groundGrad.addColorStop(1, "#181c28");
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, HORIZON_Y, W, H - HORIZON_Y);

    // horizon line glow
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, HORIZON_Y);
    ctx.lineTo(W, HORIZON_Y);
    ctx.stroke();
  }

  function drawTrack() {
    // lane boundary lines (outer edges + dividers), converging to horizon
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 3;
    const boundaries = [-1.5, -0.5, 0.5, 1.5]; // in lane-half-width units from center lane
    for (const b of boundaries) {
      ctx.beginPath();
      const farX = LANE_X_HORIZON[1] + b * 8;
      const nearX = LANE_X_BOTTOM[1] + b * LANE_HALF_WIDTH_BOTTOM;
      ctx.moveTo(farX, HORIZON_Y);
      ctx.lineTo(nearX, BOTTOM_Y + 10);
      ctx.stroke();
    }

    // moving ties/dashes across full width
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 4;
    const dashCount = 10;
    const off = (elapsed * speed * 1.4) % 1;
    for (let i = 0; i < dashCount; i++) {
      let t = (i / dashCount + off) % 1;
      const y = yAt(t);
      const halfW = lerp(6, LANE_HALF_WIDTH_BOTTOM * 3.05, Math.pow(t, 1.6));
      const cx = lerp(LANE_X_HORIZON[1], LANE_X_BOTTOM[1], t);
      ctx.globalAlpha = 0.15 + t * 0.35;
      ctx.beginPath();
      ctx.moveTo(cx - halfW, y);
      ctx.lineTo(cx + halfW, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawTrainCar(lane, t, climbable, isFront) {
    if (t < 0 || t > 1.02) return;
    const y = yAt(t);
    const x = laneXAt(lane, t);
    const s = scaleAt(t);

    ctx.save();
    ctx.translate(x, y);

    const w = 96 * s, h = 190 * s;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(-w / 2, -6 * s, w, 10 * s);

    const grad = ctx.createLinearGradient(0, -h, 0, 0);
    if (climbable) {
      grad.addColorStop(0, "#3fc6d9");
      grad.addColorStop(1, "#146678");
    } else {
      grad.addColorStop(0, "#e0453f");
      grad.addColorStop(1, "#9c1f1a");
    }
    ctx.fillStyle = grad;
    roundRect(-w / 2, -h, w, h, 10 * s);
    ctx.fill();

    ctx.fillStyle = "#cfe8ff";
    const winW = w * 0.7, winH = h * 0.22;
    roundRect(-winW / 2, -h * 0.82, winW, winH, 4 * s);
    ctx.fill();

    ctx.fillStyle = climbable ? "#c8f9ff" : "#ffd23f";
    ctx.fillRect(-w * 0.4, -h * 0.15, w * 0.8, 8 * s);

    if (climbable) {
      // roof walkway strip hints that the top is a path
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(-w * 0.42, -h - 4 * s, w * 0.84, 4 * s);
    }

    if (climbable && isFront) {
      // jump-here marker above the front car
      ctx.fillStyle = "#ffd23f";
      ctx.font = `700 ${16 * s}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("↑", 0, -h - 14 * s);
    }

    ctx.restore();
  }

  function drawObstacle(o) {
    const t = 1 - o.z;
    if (t < 0 || t > 1.02) return;

    if (o.type === "train") {
      if (o.climbable) {
        drawTrainCar(o.lane, t - 0.12, true, false);
        drawTrainCar(o.lane, t - 0.06, true, false);
        drawTrainCar(o.lane, t, true, true);
      } else {
        drawTrainCar(o.lane, t, false, false);
      }
      return;
    }

    const y = yAt(t);
    const x = laneXAt(o.lane, t);
    const s = scaleAt(t);

    ctx.save();
    ctx.translate(x, y);

    if (o.type === "low") {
      const w = 92 * s, h = 46 * s;
      const grad = ctx.createLinearGradient(0, -h, 0, 0);
      grad.addColorStop(0, "#ffcf4d");
      grad.addColorStop(1, "#d99a00");
      ctx.fillStyle = grad;
      roundRect(-w / 2, -h, w, h, 6 * s);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 3 * s;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * w * 0.3, -h);
        ctx.lineTo(i * w * 0.3 + 8 * s, 0);
        ctx.stroke();
      }
    } else if (o.type === "high") {
      const w = 110 * s, barH = 22 * s, postH = 130 * s;

      // metal side posts with a highlight edge
      ctx.fillStyle = "#6b7280";
      ctx.fillRect(-7 * s, -postH, 13 * s, postH);
      ctx.fillRect(w / 2 - 6 * s, -postH, 13 * s, postH);
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillRect(-7 * s, -postH, 3 * s, postH);
      ctx.fillRect(w / 2 - 6 * s, -postH, 3 * s, postH);

      // black/yellow hazard-stripe crossbar, clipped to its rounded shape
      const bx = -w / 2, by = -postH;
      ctx.save();
      roundRect(bx, by, w, barH, 5 * s);
      ctx.clip();
      ctx.fillStyle = "#181818";
      ctx.fillRect(bx, by, w, barH);
      ctx.fillStyle = "#ffcf1f";
      const stripeW = 13 * s;
      for (let sx = -barH; sx < w + barH; sx += stripeW * 2) {
        ctx.beginPath();
        ctx.moveTo(bx + sx, by + barH);
        ctx.lineTo(bx + sx + barH, by);
        ctx.lineTo(bx + sx + barH + stripeW, by);
        ctx.lineTo(bx + sx + stripeW, by + barH);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 2 * s;
      roundRect(bx, by, w, barH, 5 * s);
      ctx.stroke();

      // hanging warning sign to sell "duck under"
      const signY = -postH + barH + 22 * s;
      ctx.fillStyle = "#3a3a3a";
      ctx.fillRect(-1.5 * s, -postH + barH, 3 * s, 22 * s);
      ctx.save();
      ctx.translate(0, signY);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#ffcf1f";
      ctx.fillRect(-11 * s, -11 * s, 22 * s, 22 * s);
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 2 * s;
      ctx.strokeRect(-11 * s, -11 * s, 22 * s, 22 * s);
      ctx.restore();
      ctx.fillStyle = "#181818";
      ctx.font = `800 ${14 * s}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("!", 0, signY);
      ctx.textBaseline = "alphabetic";
    }

    ctx.restore();
  }

  function drawCoin(c) {
    if (c.collected) return;
    const t = 1 - c.z;
    if (t < 0 || t > 1.02) return;
    const y = yAt(t) - 40 * scaleAt(t);
    const x = laneXAt(c.lane, t);
    const s = scaleAt(t);
    const wob = Math.sin(elapsed * 6 + c.lane * 2 + c.z * 10) * 4 * s;

    ctx.save();
    ctx.translate(x, y + wob);
    const r = 14 * s;
    const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 1, 0, 0, r);
    grad.addColorStop(0, "#fff6c8");
    grad.addColorStop(0.5, "#ffd23f");
    grad.addColorStop(1, "#c98e00");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(150,100,0,0.6)";
    ctx.lineWidth = Math.max(1, 2 * s);
    ctx.stroke();
    ctx.restore();
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayer() {
    const x = player.x;
    let y = PLAYER_BASE_Y;
    let squash = 1;
    let jumpLift = 0;

    if (player.layer === "top") {
      jumpLift = CFG.roofHeight;
    } else if (player.mode === "jump") {
      jumpLift = player.jumpLift;
    } else if (player.mode === "slide") {
      squash = 0.55;
    }

    y -= jumpLift;

    // shadow
    ctx.save();
    ctx.globalAlpha = clamp(0.45 - jumpLift * 0.0015, 0.08, 0.45);
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(x, PLAYER_BASE_Y + 18, 26, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(x, y);

    const bodyH = 92 * squash;
    const legPhase = Math.sin(player.animT);

    // legs
    ctx.strokeStyle = "#2b2b2b";
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    if (player.mode === "slide") {
      ctx.beginPath();
      ctx.moveTo(-20, 0);
      ctx.lineTo(24, 6);
      ctx.stroke();
    } else if (player.mode === "jump") {
      ctx.beginPath();
      ctx.moveTo(-8, -bodyH * 0.05);
      ctx.lineTo(-18, 18);
      ctx.moveTo(8, -bodyH * 0.05);
      ctx.lineTo(20, 10);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -bodyH * 0.1);
      ctx.lineTo(10 * legPhase, 26);
      ctx.moveTo(0, -bodyH * 0.1);
      ctx.lineTo(-10 * legPhase, 26);
      ctx.stroke();
    }

    // torso (hoodie)
    const torsoGrad = ctx.createLinearGradient(0, -bodyH, 0, -bodyH * 0.15);
    torsoGrad.addColorStop(0, "#ff8a3d");
    torsoGrad.addColorStop(1, "#e8621f");
    ctx.fillStyle = torsoGrad;
    roundRect(-19, -bodyH, 38, bodyH * 0.75, 12);
    ctx.fill();

    // arms
    ctx.strokeStyle = "#e8621f";
    ctx.lineWidth = 10;
    if (player.mode === "jump") {
      ctx.beginPath();
      ctx.moveTo(-16, -bodyH * 0.7);
      ctx.lineTo(-30, -bodyH * 0.95);
      ctx.moveTo(16, -bodyH * 0.7);
      ctx.lineTo(30, -bodyH * 0.95);
      ctx.stroke();
    } else if (player.mode === "run") {
      ctx.beginPath();
      ctx.moveTo(-16, -bodyH * 0.65);
      ctx.lineTo(-16 - 8 * legPhase, -bodyH * 0.3);
      ctx.moveTo(16, -bodyH * 0.65);
      ctx.lineTo(16 + 8 * -legPhase, -bodyH * 0.3);
      ctx.stroke();
    }

    // head
    ctx.fillStyle = "#f3b98a";
    ctx.beginPath();
    ctx.arc(0, -bodyH - 14, 16, 0, Math.PI * 2);
    ctx.fill();

    // cap
    ctx.fillStyle = "#1f8fd6";
    ctx.beginPath();
    ctx.arc(0, -bodyH - 20, 16, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-16, -bodyH - 20, 32, 6);
    ctx.fillRect(2, -bodyH - 16, 20, 6);

    ctx.restore();
  }

  function drawRoofRide() {
    // a moving platform under the player's feet while they ride a train roof
    const x = player.x;
    const y = PLAYER_BASE_Y - CFG.roofHeight;
    const w = 100;

    ctx.save();
    ctx.translate(x, y + 14);
    const grad = ctx.createLinearGradient(0, -6, 0, 10);
    grad.addColorStop(0, "#5fd6e6");
    grad.addColorStop(1, "#1f7c8c");
    ctx.fillStyle = grad;
    roundRect(-w / 2, -6, w, 16, 6);
    ctx.fill();

    // scrolling rivet marks for a sense of motion
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    const off = (elapsed * speed * 6) % 20;
    for (let i = -2; i <= 2; i++) {
      const rx = i * 20 - off;
      if (rx > -w / 2 && rx < w / 2) {
        ctx.beginPath();
        ctx.arc(rx, 2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render() {
    ctx.save();
    if (shake > 0) {
      const mag = shake * 10;
      ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
    }

    drawBackground();
    drawTrack();

    const sortedObstacles = obstacles.slice().sort((a, b) => b.z - a.z);
    const sortedCoins = coins.slice().sort((a, b) => b.z - a.z);

    for (const c of sortedCoins) drawCoin(c);
    for (const o of sortedObstacles) drawObstacle(o);

    if (player.layer === "top") drawRoofRide();
    drawPlayer();
    drawParticles();

    ctx.restore();
  }

  // ---------- Loop ----------
  function frame(ts) {
    if (!lastTime) lastTime = ts;
    let dt = (ts - lastTime) / 1000;
    dt = Math.min(dt, 0.05);
    lastTime = ts;

    if (state === "playing") {
      update(dt);
    }
    render();

    requestAnimationFrame(frame);
  }

  resetGame();
  render();
  requestAnimationFrame(frame);
})();

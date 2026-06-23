/* ════════════════════════════════════════════════════════════════════════
   GAME-ENGINE v2
   Gesten:
     - Offene Hand  -> Schild  (durchgehend aktiv solange Geste gehalten wird,
                                 zeigt sichtbaren Kreis um den Spieler,
                                 blockt gegnerische Projektile + reduziert
                                 Nahkampf-Schaden)
     - Faust        -> Fernkampf (Schuss auf den nächsten Gegner, Cooldown)
     - Peace        -> Nahkampf  (Angriff in kurzer Reichweite, Cooldown)
   Gegner besitzen exakt dieselben Fähigkeiten (Schuss + Nahkampf) und werden
   über Zeit + nach jeder besiegten Welle immer stärker/schneller/aggressiver.
   ════════════════════════════════════════════════════════════════════════ */

(function () {

  let ctx, canvasW, canvasH, handConnections, fingerTips;
  let lastTime = 0;
  let state = 'playing'; // 'playing' | 'gameover'

  /* ─── HUD-DOM-Referenzen ─────────────────────────────────────────────── */
  const playerHpFill = document.getElementById('player-hp-fill');
  const scoreEl       = document.getElementById('score-value');
  const enemyCountEl  = document.getElementById('enemy-count');
  const gestureBadge  = document.getElementById('gesture-badge');
  const gameOverPanel = document.getElementById('gameover-panel');
  const finalScoreEl  = document.getElementById('final-score');
  const restartBtn    = document.getElementById('restart-btn');

  /* ─── Spiel-Variablen ─────────────────────────────────────────────────── */
  let player, enemies, projectiles, particles;
  let score, wave, elapsed, difficulty;

  /* ════════════════════════════ KONSTANTEN ═════════════════════════════ */
  const SHIELD_RADIUS      = 64;
  const MELEE_RANGE        = 95;
  const MELEE_DAMAGE       = 22;
  const MELEE_COOLDOWN     = 550;
  const SHOOT_COOLDOWN     = 480;
  const SHOOT_DAMAGE       = 14;
  const PROJECTILE_SPEED   = 0.55; // px/ms
  const PROJECTILE_RADIUS  = 7;

  const ENEMY_SHOOT_RANGE  = 420;

  /* ════════════════════════════ PLAYER ═════════════════════════════════ */
  function createPlayer() {
    return {
      x: canvasW / 2, y: canvasH / 2,
      targetX: canvasW / 2, targetY: canvasH / 2,
      radius: 34,
      hp: 100, maxHp: 100,
      isBlocking: false,
      shootCooldown: 0,
      meleeCooldown: 0,
      attackFlash: 0,
      lastGesture: 'none',
      facingX: 0, facingY: -1 // letzte Bewegungsrichtung, Fallback-Schussrichtung
    };
  }

  /* ════════════════════════════ ENEMY ══════════════════════════════════ */
  function spawnEnemy() {
    const edge = Math.floor(Math.random() * 4);
    let x, y;
    if (edge === 0) { x = 0; y = Math.random() * canvasH; }
    else if (edge === 1) { x = canvasW; y = Math.random() * canvasH; }
    else if (edge === 2) { x = Math.random() * canvasW; y = 0; }
    else { x = Math.random() * canvasW; y = canvasH; }

    const scale = difficulty; // 0, 1, 2, ...

    return {
      x, y,
      radius: 30,
      hp: 55 + scale * 12,
      maxHp: 55 + scale * 12,
      speed: 65 + scale * 7,
      meleeRange: MELEE_RANGE - 15,
      meleeDamage: 14 + scale * 2.5,
      meleeCooldown: 0,
      meleeCooldownTotal: Math.max(450, 950 - scale * 40),
      shootRange: ENEMY_SHOOT_RANGE,
      shootDamage: 9 + scale * 1.8,
      shootCooldown: Math.random() * 600, // versetzter Start
      shootCooldownTotal: Math.max(500, 1300 - scale * 60),
      attackFlash: 0,
      alive: true
    };
  }

  function resetGame() {
    score = 0;
    wave = 1;
    elapsed = 0;
    difficulty = 0;

    player = createPlayer();
    projectiles = [];
    particles = [];
    enemies = [spawnEnemy()]; // erst NACH difficulty=0, sonst NaN-Werte

    state = 'playing';
    gameOverPanel.classList.add('hidden');
  }

  /* ════════════════════════════ UPDATE ═════════════════════════════════ */
  function update(dt) {
    if (state !== 'playing') return;

    elapsed += dt;
    // Schwierigkeit steigt kontinuierlich mit der Zeit (alle 12s +1) UND pro Welle
    difficulty = wave - 1 + Math.floor(elapsed / 12000);

    const input = window.HandInput.latest;

    /* ── Spielerbewegung (geglättet) ─────────────────────────────────── */
    if (input.detected) {
      player.targetX = input.x * canvasW;
      player.targetY = input.y * canvasH;
    }

    const followSpeed = 22; // höher = straffer/schneller folgend
    const lerpFactor = Math.min(1, followSpeed * (dt / 1000));
    const prevX = player.x, prevY = player.y;

    player.x += (player.targetX - player.x) * lerpFactor;
    player.y += (player.targetY - player.y) * lerpFactor;

    player.x = Math.max(player.radius, Math.min(canvasW - player.radius, player.x));
    player.y = Math.max(player.radius, Math.min(canvasH - player.radius, player.y));

    const mvx = player.x - prevX, mvy = player.y - prevY;
    if (Math.hypot(mvx, mvy) > 0.3) {
      const len = Math.hypot(mvx, mvy);
      player.facingX = mvx / len;
      player.facingY = mvy / len;
    }

    /* ── Timer runterzählen ──────────────────────────────────────────── */
    player.shootCooldown = Math.max(0, player.shootCooldown - dt);
    player.meleeCooldown = Math.max(0, player.meleeCooldown - dt);
    player.attackFlash   = Math.max(0, player.attackFlash - dt);

    /* ── Gesten verarbeiten ──────────────────────────────────────────── */
    const gesture = input.detected ? input.gesture : 'none';
    player.isBlocking = gesture === 'open'; // Schild durchgehend aktiv

    const gestureJustEntered = gesture !== player.lastGesture;

    // Faust = Schuss (Fernkampf) – feuert durchgehend im festen Intervall,
    // solange die Hand geschlossen ist. Die Feuerrate hängt NUR vom
    // Cooldown ab, nicht davon wie schnell die Geste gewechselt wurde.
    if (gesture === 'fist' && player.shootCooldown <= 0) {
      doPlayerShoot();
    }

    // Peace = Nahkampf (weiterhin nur beim Wechsel in die Geste, Cooldown)
    if (gesture === 'peace' && gestureJustEntered && player.meleeCooldown <= 0) {
      doPlayerMelee();
    }

    player.lastGesture = gesture;

    /* ── Gegner-KI (Verfolgen, Schuss, Nahkampf) ─────────────────────── */
    for (const enemy of enemies) {
      if (!enemy.alive) continue;

      enemy.meleeCooldown = Math.max(0, enemy.meleeCooldown - dt);
      enemy.shootCooldown  = Math.max(0, enemy.shootCooldown - dt);
      enemy.attackFlash    = Math.max(0, enemy.attackFlash - dt);

      const dx = player.x - enemy.x;
      const dy = player.y - enemy.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = dx / dist, ny = dy / dist;

      if (dist > enemy.meleeRange) {
        enemy.x += nx * enemy.speed * (dt / 1000);
        enemy.y += ny * enemy.speed * (dt / 1000);
      }

      if (dist <= enemy.meleeRange && enemy.meleeCooldown <= 0) {
        enemy.meleeCooldown = enemy.meleeCooldownTotal;
        enemy.attackFlash = 180;
        applyDamageToPlayer(enemy.meleeDamage, enemy.x, enemy.y, true);
      } else if (dist <= enemy.shootRange && enemy.shootCooldown <= 0) {
        enemy.shootCooldown = enemy.shootCooldownTotal;
        enemy.attackFlash = 140;
        projectiles.push({
          x: enemy.x, y: enemy.y,
          vx: nx * PROJECTILE_SPEED, vy: ny * PROJECTILE_SPEED,
          owner: 'enemy', damage: enemy.shootDamage, color: '#ff4081'
        });
      }
    }

    /* ── Projektile bewegen + Kollision ──────────────────────────────── */
    for (const p of projectiles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    projectiles = projectiles.filter(p => {
      if (p.x < -20 || p.x > canvasW + 20 || p.y < -20 || p.y > canvasH + 20) return false;

      if (p.owner === 'enemy') {
        const distToPlayer = Math.hypot(p.x - player.x, p.y - player.y);
        if (player.isBlocking && distToPlayer <= SHIELD_RADIUS) {
          spawnParticle(p.x, p.y, '#00e5ff');
          return false; // vom Schild geblockt
        }
        if (distToPlayer <= player.radius) {
          applyDamageToPlayer(p.damage, p.x, p.y, false);
          return false;
        }
      } else { // owner === 'player'
        for (const enemy of enemies) {
          if (!enemy.alive) continue;
          const distToEnemy = Math.hypot(p.x - enemy.x, p.y - enemy.y);
          if (distToEnemy <= enemy.radius) {
            damageEnemy(enemy, p.damage);
            spawnParticle(p.x, p.y, '#ff4081');
            return false;
          }
        }
      }
      return true;
    });

    /* ── Tote Gegner entfernen, neue Welle spawnen ───────────────────── */
    enemies = enemies.filter(e => e.alive);
    if (enemies.length === 0) {
      wave++;
      const count = 1 + Math.floor(wave / 2);
      for (let i = 0; i < count; i++) enemies.push(spawnEnemy());
    }

    /* ── Partikel ─────────────────────────────────────────────────────── */
    particles = particles.filter(p => p.life > 0);
    for (const p of particles) { p.life -= dt; p.y -= 0.04 * dt; }

    /* ── Game Over Check ─────────────────────────────────────────────── */
    if (player.hp <= 0) {
      state = 'gameover';
      finalScoreEl.textContent = score;
      gameOverPanel.classList.remove('hidden');
    }

    updateHUD(gesture);
  }

  function applyDamageToPlayer(dmg, srcX, srcY, isMelee) {
    const reduced = player.isBlocking ? dmg * (isMelee ? 0.35 : 0) : dmg;
    if (reduced > 0) {
      player.hp = Math.max(0, player.hp - reduced);
      spawnParticle(player.x, player.y, player.isBlocking ? '#00e5ff' : '#ff4081');
    } else {
      spawnParticle(player.x, player.y, '#00e5ff');
    }
  }

  function damageEnemy(enemy, dmg) {
    enemy.hp -= dmg;
    if (enemy.hp <= 0) {
      enemy.alive = false;
      score += 10;
    }
  }

  function doPlayerShoot() {
    player.shootCooldown = SHOOT_COOLDOWN;
    player.attackFlash = 140;

    // Ziel: nächster lebender Gegner, sonst letzte Blickrichtung
    let target = null, bestDist = Infinity;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const d = Math.hypot(enemy.x - player.x, enemy.y - player.y);
      if (d < bestDist) { bestDist = d; target = enemy; }
    }

    let vx, vy;
    if (target) {
      const dx = target.x - player.x, dy = target.y - player.y;
      const len = Math.hypot(dx, dy) || 1;
      vx = (dx / len) * PROJECTILE_SPEED;
      vy = (dy / len) * PROJECTILE_SPEED;
    } else {
      vx = player.facingX * PROJECTILE_SPEED;
      vy = player.facingY * PROJECTILE_SPEED;
    }

    projectiles.push({
      x: player.x, y: player.y, vx, vy,
      owner: 'player', damage: SHOOT_DAMAGE, color: '#00e5ff'
    });
  }

  function doPlayerMelee() {
    player.meleeCooldown = MELEE_COOLDOWN;
    player.attackFlash = 160;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const dist = Math.hypot(player.x - enemy.x, player.y - enemy.y);
      if (dist <= MELEE_RANGE + enemy.radius) {
        damageEnemy(enemy, MELEE_DAMAGE);
        spawnParticle(enemy.x, enemy.y, '#ff4081');
      }
    }
  }

  function spawnParticle(x, y, color) {
    particles.push({ x, y, color, life: 380, maxLife: 380 });
  }

  function updateHUD(gesture) {
    playerHpFill.style.width = `${Math.max(0, player.hp)}%`;
    scoreEl.textContent = score;
    enemyCountEl.textContent = enemies.filter(e => e.alive).length;

    const labels = {
      fist: 'Faust · Schuss',
      open: 'Offene Hand · Schild',
      peace: 'Peace · Nahkampf',
      none: '–'
    };
    gestureBadge.textContent = labels[gesture] || '–';
    gestureBadge.dataset.gesture = gesture;
  }

  /* ════════════════════════════ RENDER ═════════════════════════════════ */
  function render() {
    ctx.clearRect(0, 0, canvasW, canvasH);

    const input = window.HandInput.latest;

    if (input.image) {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(input.image, -canvasW, 0, canvasW, canvasH);
      ctx.restore();
    }

    ctx.fillStyle = 'rgba(8, 8, 14, 0.45)';
    ctx.fillRect(0, 0, canvasW, canvasH);

    if (input.landmarks) drawSkeleton(input.landmarks);

    for (const enemy of enemies) if (enemy.alive) drawEnemy(enemy);
    for (const p of projectiles) drawProjectile(p);

    drawPlayer();

    for (const p of particles) drawParticle(p);

    if (state === 'gameover') {
      ctx.fillStyle = 'rgba(5,5,10,0.55)';
      ctx.fillRect(0, 0, canvasW, canvasH);
    }
  }

  function drawSkeleton(landmarks) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
    for (const [a, b] of handConnections) {
      ctx.beginPath();
      ctx.moveTo(landmarks[a].x * canvasW, landmarks[a].y * canvasH);
      ctx.lineTo(landmarks[b].x * canvasW, landmarks[b].y * canvasH);
      ctx.stroke();
    }
    landmarks.forEach((lm, i) => {
      ctx.beginPath();
      ctx.arc(lm.x * canvasW, lm.y * canvasH, fingerTips.includes(i) ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(124, 58, 255, 0.4)';
      ctx.fill();
    });
  }

  function drawPlayer() {
    // Schild-Kreis
    if (player.isBlocking) {
      ctx.beginPath();
      ctx.arc(player.x, player.y, SHIELD_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.85)';
      ctx.lineWidth = 4;
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(0, 229, 255, 0.08)';
      ctx.fill();
    }

    ctx.save();
    if (player.attackFlash > 0 && !player.isBlocking) {
      ctx.shadowColor = '#ff4081';
      ctx.shadowBlur = 24;
    }
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(124, 58, 255, 0.9)';
    ctx.fill();
    ctx.restore();

    // Nahkampf-Reichweite kurz anzeigen
    if (player.attackFlash > 0 && player.lastGesture === 'peace') {
      ctx.beginPath();
      ctx.arc(player.x, player.y, MELEE_RANGE, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 64, 129, ${player.attackFlash / 160})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    drawHpRing(player.x, player.y, player.radius + 10, player.hp / player.maxHp, '#00e5ff');
  }

  function drawEnemy(enemy) {
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2);
    ctx.fillStyle = enemy.attackFlash > 0 ? '#ff4081' : '#3a1f4d';
    ctx.fill();
    ctx.strokeStyle = '#ff4081';
    ctx.lineWidth = 2;
    ctx.stroke();

    drawHpRing(enemy.x, enemy.y, enemy.radius + 8, enemy.hp / enemy.maxHp, '#ff4081');
  }

  function drawProjectile(p) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, PROJECTILE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawHpRing(x, y, radius, ratio, color) {
    ctx.beginPath();
    ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, ratio));
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function drawParticle(p) {
    const alpha = p.life / p.maxLife;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6 * alpha + 2, 0, Math.PI * 2);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* ════════════════════════════ LOOP ═══════════════════════════════════ */
  function loop(timestamp) {
    const dt = lastTime ? timestamp - lastTime : 16.6;
    lastTime = timestamp;

    update(Math.min(dt, 50));
    render();

    requestAnimationFrame(loop);
  }

  /* ════════════════════════════ PUBLIC API ═════════════════════════════ */
  window.Game = {
    start(canvasEl, connections, tips) {
      ctx = canvasEl.getContext('2d');
      canvasW = canvasEl.width;
      canvasH = canvasEl.height;
      handConnections = connections;
      fingerTips = tips;

      window.addEventListener('resize', () => {
        canvasW = canvasEl.width;
        canvasH = canvasEl.height;
      });

      resetGame();
      requestAnimationFrame(loop);
    }
  };

  restartBtn.addEventListener('click', resetGame);

})();
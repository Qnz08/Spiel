/* ════════════════════════════════════════════════════════════════════════
   INPUT-LAYER
   Aufgabe dieser Datei: MediaPipe Hands initialisieren, pro Frame die
   Handposition + Geste bestimmen und in window.HandInput.latest ablegen.
   Diese Datei zeichnet NICHTS auf den Canvas – das macht ausschließlich
   game.js (Render-Layer). So bleibt Input / Logik / Rendering getrennt.
   ════════════════════════════════════════════════════════════════════════ */

const video      = document.getElementById('video');
const canvas     = document.getElementById('canvas');
const permScreen = document.getElementById('permission-screen');
const loadScreen = document.getElementById('loading-screen');
const startBtn   = document.getElementById('start-btn');

/* Globaler Input-Zustand – wird von game.js gelesen */
window.HandInput = {
  latest: {
    detected:  false,
    x: 0.5, y: 0.5,        // normalisierte Palm-Position (0..1), bereits gespiegelt
    gesture: 'none',         // 'fist' | 'open' | 'peace' | 'none'
    landmarks: null,         // gespiegelte Landmarks fürs Skelett-Rendering
    image: null               // aktuelles Kamera-Frame (für Hintergrund)
  }
};

/* ─── Finger-Indices ──────────────────────────────────────────────────── */
const FINGER_TIPS    = [4, 8, 12, 16, 20];
const FINGER_KNUCKLE = [2, 6, 10, 14, 18];

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17]
];

/* ─── Pro Finger: ausgestreckt ja/nein ────────────────────────────────── */
function getFingerStates(landmarks) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const palmBase  = landmarks[17];
  const handScale = dist(landmarks[0], landmarks[9]);

  const states = [false, false, false, false, false];

  // Daumen: robust gegen Rotation – Spitze vs. Grundgelenk relativ zur Handfläche
  states[0] = dist(landmarks[4], palmBase) > dist(landmarks[2], palmBase) + 0.15 * handScale;

  // restliche 4 Finger: Spitze höher (kleineres y) als das PIP-Gelenk
  for (let i = 1; i < 5; i++) {
    states[i] = landmarks[FINGER_TIPS[i]].y < landmarks[FINGER_KNUCKLE[i]].y - 0.02;
  }
  return states;
}

/* ─── Geste aus Finger-Status ableiten ────────────────────────────────── */
function classifyGesture(states) {
  const extended = states.filter(Boolean).length;

  if (extended <= 1) return 'fist';
  if (extended >= 4) return 'open';
  if (states[1] && states[2] && !states[3] && !states[4]) return 'peace';
  return 'none';
}

/* ─── Geste glätten (Debounce) – verhindert Flackern durch Jitter ─────── */
const gestureHistory = [];
const GESTURE_HISTORY_LEN = 4;

function stabilizeGesture(rawGesture) {
  gestureHistory.push(rawGesture);
  if (gestureHistory.length > GESTURE_HISTORY_LEN) gestureHistory.shift();

  const counts = {};
  for (const g of gestureHistory) counts[g] = (counts[g] || 0) + 1;

  let best = 'none', bestCount = 0;
  for (const g in counts) {
    if (counts[g] > bestCount) { best = g; bestCount = counts[g]; }
  }
  return bestCount >= Math.ceil(GESTURE_HISTORY_LEN * 0.6) ? best : 'none';
}

/* ─── MediaPipe Ergebnis-Callback ─────────────────────────────────────── */
function onResults(results) {
  const hands = results.multiHandLandmarks;
  const input = window.HandInput.latest;

  input.image = results.image;

  if (!hands || hands.length === 0) {
    input.detected = false;
    input.gesture  = stabilizeGesture('none');
    input.landmarks = null;
    return;
  }

  const raw = hands[0];
  const mirrored = raw.map(lm => ({ x: 1 - lm.x, y: lm.y, z: lm.z }));

  const states  = getFingerStates(mirrored);
  const rawGest = classifyGesture(states);

  input.detected  = true;
  input.gesture   = stabilizeGesture(rawGest);
  input.landmarks = mirrored;
  input.x = mirrored[9].x; // Mittelfinger-MCP als Palm-Referenzpunkt
  input.y = mirrored[9].y;
}

/* ─── Canvas-Größe an Fenster anpassen ────────────────────────────────── */
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

/* ─── Start ────────────────────────────────────────────────────────────── */
startBtn.addEventListener('click', async () => {
  permScreen.style.display = 'none';
  loadScreen.classList.remove('hidden');

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });

  video.srcObject = stream;
  await video.play();

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const hands = new Hands({
    locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands:            1,
    modelComplexity:        1,
    minDetectionConfidence: 0.75,
    minTrackingConfidence:  0.6
  });

  hands.onResults(onResults);

  const camera = new Camera(video, {
    onFrame: async () => { await hands.send({ image: video }); },
    width:  1280,
    height: 720
  });

  await camera.start();
  loadScreen.classList.add('hidden');

  // Game-Engine erst starten, wenn die Kamera läuft
  window.Game.start(canvas, HAND_CONNECTIONS, FINGER_TIPS);
});

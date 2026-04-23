// The Data Twist — BLE connection manager
// Connects to 2x Circuit Playground Bluefruit via Web Bluetooth (Nordic UART Service)
//
// Requirements:
//   - Chrome or Edge only (Web Bluetooth is not supported in Safari/Firefox)
//   - Page must be served over HTTPS (GitHub Pages satisfies this)
//   - connectCPB() must be called from a direct user gesture (button click)
//
// Spin flow:
//   t=0s  spin clicked → statement shown, countdown starts, boards idle
//   t=5s  "GO" sent to CPBs → response window opens, boards pulse white
//   t=10s window closes → CPBs send final direction → response cards shown

'use strict';

// Nordic UART Service UUIDs (lowercase for Web Bluetooth API)
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // CPB → browser (notify)
const NUS_RX      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // browser → CPB (write)

const READING_DELAY_S  = 5;   // seconds before GO is sent
const TOTAL_COUNTDOWN_S = 10; // total countdown shown on screen

// Direction metadata
const DIRECTION_META = {
  N: { label: 'Strongly Agree',    color: '#22c55e', emoji: '⬆️' },
  S: { label: 'Strongly Disagree', color: '#ef4444', emoji: '⬇️' },
  E: { label: 'Somewhat Agree',    color: '#eab308', emoji: '➡️' },
  W: { label: 'Somewhat Disagree', color: '#3b82f6', emoji: '⬅️' },
};

// All participant slots
const SLOTS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];

// State per slot: { device, rxChar }
const connections = { p1: null, p2: null, p3: null, p4: null, p5: null, p6: null, p7: null, p8: null };

// Countdown state
let countdownInterval = null;

// Per-round response tracking
const roundResponses = {};
SLOTS.forEach(s => { roundResponses[s] = null; });

// Trace data: streaming direction samples per slot
// Each entry: { t: seconds_since_arm, dir: 'N'|'S'|'E'|'W'|null }
const traceData = {};
SLOTS.forEach(s => { traceData[s] = []; });
let traceStartTime = null;

// Streaming char → direction mapping (lowercase/special = stream, uppercase = final answer)
const STREAM_DIRS = { 'a': 'N', 'b': 'S', 'c': 'E', 'd': 'W', '_': null };

// ---------------------------------------------------------------------------
// BLE connection
// ---------------------------------------------------------------------------

async function connectCPB(slot) {
  const card = document.getElementById(`connect-${slot}`);

  if (!navigator.bluetooth) {
    alert('Web Bluetooth not supported — use Chrome or Edge');
    return;
  }

  card.classList.add('connecting');

  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
  } catch (err) {
    card.classList.remove('connecting');
    return;
  }

  try {
    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    const txChar  = await service.getCharacteristic(NUS_TX);
    const rxChar  = await service.getCharacteristic(NUS_RX);

    await txChar.startNotifications();
    txChar.addEventListener('characteristicvaluechanged', (event) => {
      const raw = new TextDecoder().decode(event.target.value).trim();
      for (const ch of raw) {
        if ('NSEW'.includes(ch)) handleDirection(slot, ch);       // final answer
        else if (ch === '-') handleNoAnswer(slot);                 // final no-answer
        else if (ch in STREAM_DIRS) recordTrace(slot, STREAM_DIRS[ch]); // streaming sample
      }
    });

    device.addEventListener('gattserverdisconnected', () => {
      connections[slot] = null;
      card.classList.remove('connected', 'connecting');
    });

    connections[slot] = { device, rxChar };
    card.classList.remove('connecting');
    card.classList.add('connected');

  } catch (err) {
    card.classList.remove('connecting');
    console.warn(`Connect ${slot} failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// Sending commands to CPBs
// ---------------------------------------------------------------------------

async function sendToCPB(slot, message) {
  const conn = connections[slot];
  if (!conn) { console.log(`sendToCPB(${slot}): no connection`); return; }
  try {
    const data = new TextEncoder().encode(message + '\n');
    // Try write-without-response first, fall back to writeValue
    if (conn.rxChar.properties.writeWithoutResponse) {
      await conn.rxChar.writeValueWithoutResponse(data);
    } else {
      await conn.rxChar.writeValue(data);
    }
    console.log(`Sent "${message}" to ${slot}`);
  } catch (err) {
    console.warn(`Send to ${slot} failed:`, err);
  }
}

async function sendToAllCPBs(message) {
  await Promise.all(SLOTS.map(s => sendToCPB(s, message)));
}

// ---------------------------------------------------------------------------
// Spin + countdown
// ---------------------------------------------------------------------------

function startSpin() {
  // Clear previous responses and round data
  SLOTS.forEach(s => { clearResponse(s); roundResponses[s] = null; traceData[s] = []; });
  traceStartTime = null;

  // Stop any in-progress countdown
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  const countdownEl = document.getElementById('countdown');
  console.log('startSpin — countdownEl:', countdownEl);
  let remaining = TOTAL_COUNTDOWN_S;

  updateCountdown(countdownEl, remaining, false);

  // t=0s: ARM CPBs → lights on, no sound yet; start trace recording
  traceStartTime = Date.now();
  sendToAllCPBs('ARM');

  // t=5s: GO → response window opens, direction detection + sound enabled
  setTimeout(() => sendToAllCPBs('GO'), READING_DELAY_S * 1000);

  countdownInterval = setInterval(() => {
    remaining--;
    const inResponseWindow = remaining < (TOTAL_COUNTDOWN_S - READING_DELAY_S);
    updateCountdown(countdownEl, remaining, inResponseWindow);

    // Send BEEP every second during response window so both boards beep in sync
    if (inResponseWindow && remaining > 0) {
      sendToAllCPBs('BEEP');
    }

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      updateCountdown(countdownEl, 0, false);
      // Give 800ms for final BLE responses to arrive, then trigger visualization
      setTimeout(triggerVisualization, 800);
    }
  }, 1000);
}

function updateCountdown(el, seconds, active) {
  if (!el) return;
  if (seconds <= 0) {
    el.textContent = '';
    return;
  }
  el.textContent = seconds;
  el.style.color  = active ? '#ef4444' : '#6b7280';
  el.style.fontWeight = active ? 'bold' : 'normal';
}

// ---------------------------------------------------------------------------
// Direction handling
// ---------------------------------------------------------------------------

function handleDirection(slot, dir) {
  roundResponses[slot] = dir;
  const meta = DIRECTION_META[dir];
  if (!meta) return;
  const el = document.getElementById(`response-${slot}`);
  if (!el) return;
  el.innerHTML = `
    <div style="
      background: ${meta.color};
      color: #fff;
      border-radius: 0.5rem;
      padding: 1rem 1.5rem;
      font-size: 1.4rem;
      font-weight: bold;
      display: inline-block;
      margin: 0.25rem;
    ">${meta.emoji} ${meta.label}</div>`;
}

function handleNoAnswer(slot) {
  roundResponses[slot] = '-';
  const el = document.getElementById(`response-${slot}`);
  if (!el) return;
  el.innerHTML = `
    <div style="
      background: #9ca3af;
      color: #fff;
      border-radius: 0.5rem;
      padding: 1rem 1.5rem;
      font-size: 1.4rem;
      font-weight: bold;
      display: inline-block;
      margin: 0.25rem;
    ">— No answer</div>`;
}

function clearResponse(slot) {
  const el = document.getElementById(`response-${slot}`);
  if (el) el.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Trace recording
// ---------------------------------------------------------------------------

function recordTrace(slot, dir) {
  if (!traceStartTime) return;
  const t = (Date.now() - traceStartTime) / 1000;
  traceData[slot].push({ t, dir });
}

// ---------------------------------------------------------------------------
// Visualization — color flash + flowing traces
// ---------------------------------------------------------------------------

function triggerVisualization() {
  const counts = { N: 0, S: 0, E: 0, W: 0 };
  SLOTS.forEach(s => {
    const r = roundResponses[s];
    if (r && r !== '-' && counts[r] !== undefined) counts[r]++;
  });

  // Find dominant direction (null if tie or all no-answer)
  const maxCount = Math.max(...Object.values(counts));
  let dominantDir = null;
  let dominantColor = null;
  if (maxCount > 0) {
    dominantDir = Object.keys(counts).find(k => counts[k] === maxCount);
    dominantColor = DIRECTION_META[dominantDir].color;
  }

  // Skip color flash — go straight to canvas visualization
  showVizOverlay(dominantColor, dominantDir);
}

function showVizOverlay(dominantColor, dominantDir) {
  const overlay = document.getElementById('viz-overlay');
  overlay.classList.add('viz-overlay--active');

  // Dismiss on click or space
  const dismiss = (e) => {
    if (e.type === 'keydown' && e.code !== 'Space') return;
    if (e.type === 'keydown') e.preventDefault();
    overlay.classList.remove('viz-overlay--active');
    document.removeEventListener('keydown', dismiss);
    overlay.removeEventListener('click', dismiss);
  };
  overlay.addEventListener('click', dismiss);
  document.addEventListener('keydown', dismiss);

  renderTraces(dominantColor, dominantDir);
}

function dirColor(dir) {
  if (dir === 'N') return '#22c55e';
  if (dir === 'S') return '#ef4444';
  if (dir === 'E') return '#eab308';
  if (dir === 'W') return '#3b82f6';
  return '#cbd5e1'; // neutral — light gray
}


function renderTraces(dominantColor, dominantDir) {
  const chartEl = document.getElementById('viz-chart');
  if (!chartEl) return;
  chartEl.innerHTML = '';

  const W = chartEl.clientWidth || 740;
  const H = Math.round(W * 0.57);
  const STEP = 8;
  const TOTAL_MS = 10000;
  const PF_N = 48; // interpolation points per stroke fed to Perfect Freehand

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.cssText = 'display:block; border-radius:8px; background:#f8f5f0;';
  chartEl.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // Build strokes and participant starting points
  const participants = [];

  SLOTS.forEach((slot) => {
    const entries = traceData[slot];
    if (!entries || entries.length === 0) return;

    const sx = 60 + Math.random() * (W - 120);
    const sy = 60 + Math.random() * (H - 120);

    // Per-sample positions
    const samples = [];
    let x = sx, y = sy, lastDir = null;
    entries.forEach(({ t, dir }) => {
      const isNeutral = dir === null;
      const drawDir = isNeutral ? lastDir : dir;
      if (!isNeutral) lastDir = dir;
      const px = x, py = y;
      if (!isNeutral && drawDir) {
        if (drawDir === 'N') y -= STEP;
        else if (drawDir === 'S') y += STEP;
        else if (drawDir === 'E') x += STEP;
        else if (drawDir === 'W') x -= STEP;
        x = Math.max(16, Math.min(W - 16, x));
        y = Math.max(16, Math.min(H - 16, y));
      }
      // neutral samples stay at (x, y) — no movement
      samples.push({ x1: px, y1: py, x2: x, y2: y, drawDir, isNeutral, t });
    });

    // Group into brush strokes by consecutive drawDir
    const strokes = [];
    let gi = 0;
    while (gi < samples.length) {
      const gDir = samples[gi].drawDir;
      let gj = gi;
      const gNeutral = samples[gi].isNeutral;
      while (gj < samples.length && samples[gj].drawDir === gDir && samples[gj].isNeutral === gNeutral) gj++;
      if (gNeutral) {
        // Neutral: brush held stationary — white paint pools at current position
        strokes.push({
          type: 'blob',
          cx: samples[gi].x2, cy: samples[gi].y2,
          dir: gDir, // last known direction for brush orientation
          count: gj - gi,
          delay: (samples[gi].t / 10) * TOTAL_MS,
          duration: Math.max(150, ((samples[gj - 1].t - samples[gi].t) / 10) * TOTAL_MS),
        });
      } else if (gDir !== null) {
        const x1 = samples[gi].x1, y1 = samples[gi].y1;
        const x2 = samples[gj - 1].x2, y2 = samples[gj - 1].y2;
        const perp = (Math.random() - 0.5) * 70;
        strokes.push({
          type: 'stroke',
          color: dirColor(gDir),
          delay: (samples[gi].t / 10) * TOTAL_MS,
          duration: Math.max(150, ((samples[gj - 1].t - samples[gi].t) / 10) * TOTAL_MS),
          x1, y1, x2, y2,
          cpx: (x1 + x2) / 2 + (gDir === 'N' || gDir === 'S' ? perp : 0),
          cpy: (y1 + y2) / 2 + (gDir === 'E' || gDir === 'W' ? perp : 0),
        });
      }
      gi = gj;
    }

    participants.push({ label: `P${slot.slice(1)}`, sx, sy, strokes });
  });

  // Pre-compute [x, y, pressure] arrays for each stroke (bezier-sampled)
  function buildPFPoints(x1, y1, cpx, cpy, x2, y2, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const bx = (1-t)*(1-t)*x1 + 2*(1-t)*t*cpx + t*t*x2;
      const by = (1-t)*(1-t)*y1 + 2*(1-t)*t*cpy + t*t*y2;
      // Pressure: starts full, stays wide, trails off at the end — like a real brush stroke
      const pressure = Math.pow(1 - t * t * t, 0.4);
      pts.push([bx, by, pressure]);
    }
    return pts;
  }

  // Draw a Perfect Freehand outline as a filled path
  function drawPFStroke(pfPts, color, alpha, size, composite) {
    if (!window.getStroke || pfPts.length < 2) return;
    const outline = window.getStroke(pfPts, {
      size,
      thinning: 0.3,
      smoothing: 0.6,
      streamline: 0.4,
      start: { cap: true, taper: false },
      end:   { cap: true, taper: size * 4, easing: t => t * t },
    });
    if (!outline || outline.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    if (composite) ctx.globalCompositeOperation = composite;
    ctx.beginPath();
    ctx.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const allStrokes = participants.flatMap(p =>
    p.strokes.map(s => s.type === 'blob' ? s : {
      ...s,
      pts: buildPFPoints(s.x1, s.y1, s.cpx, s.cpy, s.x2, s.y2, PF_N),
    })
  );
  const maxEnd = allStrokes.length ? Math.max(...allStrokes.map(s => s.delay + s.duration)) : TOTAL_MS;

  const startTime = performance.now();

  function animate(now) {
    const elapsed = now - startTime;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f8f5f0';
    ctx.fillRect(0, 0, W, H);

    allStrokes.forEach((s) => {
      if (elapsed < s.delay) return;
      const progress = Math.min(1, (elapsed - s.delay) / s.duration);

      if (s.type === 'blob') {
        // Brush tip pressed flat — short PF stroke in last direction, growing as paint pools
        if (!window.getStroke) return;
        const size = (4 + s.count * 0.5) * progress;
        // Unit vector in last direction (default downward if no prior direction)
        const dvx = s.dir === 'E' ? 1 : s.dir === 'W' ? -1 : 0;
        const dvy = s.dir === 'S' ? 1 : s.dir === 'N' ? -1 : 1;
        const len = size * 0.6; // short — just the brush tip width
        const blobPts = [
          [s.cx - dvx * len, s.cy - dvy * len, 1],
          [s.cx,             s.cy,             1],
          [s.cx + dvx * len, s.cy + dvy * len, 1],
        ];
        const outline = window.getStroke(blobPts, {
          size,
          thinning: 0,       // uniform width — flat brush tip, no taper
          smoothing: 0.8,
          streamline: 0.5,
          simulatePressure: false,
        });
        if (!outline || outline.length < 2) return;
        ctx.save();
        ctx.globalAlpha = 0.88;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = size * 0.8;
        ctx.beginPath();
        ctx.moveTo(outline[0][0], outline[0][1]);
        for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        return;
      }

      const limit = Math.max(2, Math.round(progress * PF_N));
      const pfPts = s.pts.slice(0, limit + 1);

      // Soft glow under the stroke
      ctx.save();
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 32;
      drawPFStroke(pfPts, s.color, 0.08, 54, 'multiply');
      ctx.restore();

      // Main body — multiply blending for watercolor overlaps
      drawPFStroke(pfPts, s.color, 0.45, 24, 'multiply');

      // Crisp hairline on top
      drawPFStroke(pfPts, s.color, 0.88, 3.5, null);
    });

    // Dots and labels on top
    participants.forEach(({ label, sx, sy }) => {
      ctx.save();
      ctx.fillStyle = '#4a4a4a';
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '600 11px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#4a4a4a';
      ctx.fillText(label, sx, sy - 9);
      ctx.restore();
    });

    if (elapsed < maxEnd + 300) {
      requestAnimationFrame(animate);
    } else {
      // Stroke animation done — flood canvas with dominant color from its origin
      if (dominantColor && dominantDir) startFlood();
    }
  }

  // Dominant color sweeps in from its directional origin, multiply-blended over strokes
  function startFlood() {
    const FLOOD_MS = 10000;
    const EDGE = 60; // soft gradient leading edge width
    const snapshot = ctx.getImageData(0, 0, W, H); // freeze final stroke state
    const floodStart = performance.now();

    function easeInOut(t) { return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t; }

    function animateFlood(now) {
      const t = easeInOut(Math.min(1, (now - floodStart) / FLOOD_MS));

      // Restore clean stroke frame each tick so multiply never accumulates
      ctx.putImageData(snapshot, 0, 0);

      ctx.save();
      ctx.globalCompositeOperation = 'color';
      ctx.globalAlpha = t; // gradually reaches full hue tint over 10s

      if (dominantDir === 'N') {
        // Green — sweeps from bottom upward
        const filled = H * t;
        const edgeY = H - filled;
        const grad = ctx.createLinearGradient(0, edgeY, 0, edgeY + EDGE);
        grad.addColorStop(0, dominantColor + '00');
        grad.addColorStop(1, dominantColor);
        ctx.fillStyle = dominantColor;
        ctx.fillRect(0, edgeY + EDGE, W, filled);
        ctx.fillStyle = grad;
        ctx.fillRect(0, edgeY, W, EDGE);

      } else if (dominantDir === 'S') {
        // Red — sweeps from top downward
        const filled = H * t;
        const grad = ctx.createLinearGradient(0, filled - EDGE, 0, filled);
        grad.addColorStop(0, dominantColor);
        grad.addColorStop(1, dominantColor + '00');
        ctx.fillStyle = dominantColor;
        ctx.fillRect(0, 0, W, filled - EDGE);
        ctx.fillStyle = grad;
        ctx.fillRect(0, filled - EDGE, W, EDGE);

      } else if (dominantDir === 'E') {
        // Yellow — sweeps from left rightward
        const filled = W * t;
        const grad = ctx.createLinearGradient(filled - EDGE, 0, filled, 0);
        grad.addColorStop(0, dominantColor);
        grad.addColorStop(1, dominantColor + '00');
        ctx.fillStyle = dominantColor;
        ctx.fillRect(0, 0, filled - EDGE, H);
        ctx.fillStyle = grad;
        ctx.fillRect(filled - EDGE, 0, EDGE, H);

      } else if (dominantDir === 'W') {
        // Blue — sweeps from right leftward
        const filled = W * t;
        const startX = W - filled;
        const grad = ctx.createLinearGradient(startX, 0, startX + EDGE, 0);
        grad.addColorStop(0, dominantColor + '00');
        grad.addColorStop(1, dominantColor);
        ctx.fillStyle = dominantColor;
        ctx.fillRect(startX + EDGE, 0, filled, H);
        ctx.fillStyle = grad;
        ctx.fillRect(startX, 0, EDGE, H);
      }

      ctx.restore();
      if (t < 1) requestAnimationFrame(animateFlood);
    }

    requestAnimationFrame(animateFlood);
  }

  requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------------
// Wire up buttons once DOM is ready
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  SLOTS.forEach(slot => {
    const btn = document.getElementById(`connect-${slot}`);
    if (btn) btn.addEventListener('click', () => connectCPB(slot));
  });

  // Hide BLE panel when not on Compass orientation
  const gameBtn  = document.getElementById('orient button');
  const blePanel = document.getElementById('ble-panel');
  if (gameBtn && blePanel) {
    gameBtn.addEventListener('click', () => {
      setTimeout(() => {
        const heading = document.getElementById('orientation')?.querySelector('h2')?.textContent || '';
        blePanel.style.display = heading === 'COMPASS' ? '' : 'none';
      }, 0);
    });
  }

  // Intercept spin button to trigger countdown + GO
  const spinBtn = document.getElementById('spin button');
  if (spinBtn) {
    spinBtn.addEventListener('click', startSpin);
  }
});
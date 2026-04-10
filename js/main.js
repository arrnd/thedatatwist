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

// State per slot: { device, rxChar }
const connections = { p1: null, p2: null };

// Countdown state
let countdownInterval = null;

// ---------------------------------------------------------------------------
// BLE connection
// ---------------------------------------------------------------------------

async function connectCPB(slot) {
  const statusEl = document.getElementById(`status-${slot}`);
  const btnEl    = document.getElementById(`connect-${slot}`);

  if (!navigator.bluetooth) {
    statusEl.textContent = 'Web Bluetooth not supported — use Chrome or Edge';
    statusEl.style.color = '#ef4444';
    return;
  }

  statusEl.textContent = 'Searching…';
  statusEl.style.color = '';

  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
  } catch (err) {
    statusEl.textContent = err.name === 'NotFoundError' ? 'Cancelled' : `Error: ${err.message}`;
    statusEl.style.color = '#ef4444';
    return;
  }

  statusEl.textContent = 'Connecting…';

  try {
    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    const txChar  = await service.getCharacteristic(NUS_TX);
    const rxChar  = await service.getCharacteristic(NUS_RX);

    await txChar.startNotifications();
    txChar.addEventListener('characteristicvaluechanged', (event) => {
      const raw = new TextDecoder().decode(event.target.value).trim();
      for (const ch of raw) {
        if ('NSEW'.includes(ch)) handleDirection(slot, ch);
        if (ch === '-') handleNoAnswer(slot);
      }
    });

    device.addEventListener('gattserverdisconnected', () => {
      connections[slot] = null;
      statusEl.textContent = 'Disconnected';
      statusEl.style.color = '#ef4444';
      btnEl.textContent = `Connect Participant ${slot === 'p1' ? 1 : 2}`;
      clearResponse(slot);
    });

    connections[slot] = { device, rxChar };
    statusEl.textContent = `Connected: ${device.name || 'CPB'}`;
    statusEl.style.color = '#22c55e';
    btnEl.textContent = `Disconnect P${slot === 'p1' ? 1 : 2}`;

  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
    statusEl.style.color = '#ef4444';
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
  await Promise.all([sendToCPB('p1', message), sendToCPB('p2', message)]);
}

// ---------------------------------------------------------------------------
// Spin + countdown
// ---------------------------------------------------------------------------

function startSpin() {
  // Clear previous responses
  clearResponse('p1');
  clearResponse('p2');

  // Stop any in-progress countdown
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  const countdownEl = document.getElementById('countdown');
  console.log('startSpin — countdownEl:', countdownEl);
  let remaining = TOTAL_COUNTDOWN_S;

  updateCountdown(countdownEl, remaining, false);

  // At t=5s send GO to CPBs
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
// Wire up buttons once DOM is ready
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const btn1 = document.getElementById('connect-p1');
  const btn2 = document.getElementById('connect-p2');
  if (btn1) btn1.addEventListener('click', () => connectCPB('p1'));
  if (btn2) btn2.addEventListener('click', () => connectCPB('p2'));

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
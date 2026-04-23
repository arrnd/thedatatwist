# The Data Twist — Circuit Playground Bluefruit firmware
# CircuitPython | Wrist-mount, arm-throw tilt detection
#
# Direction mapping (CPB worn face-up on wrist, USB port toward elbow):
#   Tilt up    → Y axis negative → N (strongly agree)    → green
#   Tilt down  → Y axis positive → S (strongly disagree) → red
#   Tilt right → X axis positive → E (somewhat agree)    → yellow
#   Tilt left  → X axis negative → W (somewhat disagree) → blue
#   Board flat  → Z dominant → no answer → white pulse (idle: off)
#
# Flow:
#   IDLE    — board does nothing, LEDs off (participants walk freely)
#   ARMED   — browser sent "ARM" (spin clicked), LEDs pulse white, no sound/detection
#   READING — browser sent "GO" (5s before end), direction detection + sound enabled
#   LOCKED  — window closed, board sends last detected direction
#             (or "-" for no answer), holds that color until next ARM

import time
import board
from adafruit_circuitplayground import cp
from adafruit_ble import BLERadio
from adafruit_ble.advertising.standard import ProvideServicesAdvertisement
from adafruit_ble.services.nordic import UARTService

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

THRESHOLD         = 6.0  # m/s² — minimum acceleration to register a direction
RESPONSE_WINDOW_S = 5.0  # seconds participants have to lock in after GO
STREAM_INTERVAL_S = 0.05  # how often to stream current direction to browser (matches loop rate)

# Streaming chars (lowercase/special to distinguish from final answer N/S/E/W/-)
STREAM_CHARS = {"N": "a", "S": "b", "E": "c", "W": "d", None: "_"}

# Color table: direction → (R, G, B)
COLORS = {
    "N": (0, 255, 0),    # green  — strongly agree
    "S": (255, 0, 0),    # red    — strongly disagree
    "E": (255, 200, 0),  # yellow — somewhat agree
    "W": (0, 0, 255),    # blue   — somewhat disagree
}

# Tone table: direction → (frequency_hz, duration_s)
TONES = {
    "N": (880, 0.15),
    "S": (220, 0.15),
    "E": (660, 0.15),
    "W": (440, 0.15),
}

WHITE      = (80, 80, 80)   # idle-armed pulse color
WHITE_DIM  = (20, 20, 20)

# ---------------------------------------------------------------------------
# BLE setup
# ---------------------------------------------------------------------------

ble = BLERadio()
ble.name = "DataTwist"   # change to "DataTwist2" on the second CPB
uart = UARTService()
advertisement = ProvideServicesAdvertisement(uart)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def pixels_set(color):
    cp.pixels.fill(color)

def pixels_off():
    cp.pixels.fill((0, 0, 0))

def detect_direction(ax, ay, az):
    """Return 'N'/'S'/'E'/'W' or None based on dominant gravity axis."""
    abs_ax, abs_ay, abs_az = abs(ax), abs(ay), abs(az)
    dominant = max(abs_ax, abs_ay, abs_az)
    if dominant < THRESHOLD:
        return None
    if dominant == abs_az:
        return None          # flat — neutral
    elif dominant == abs_ay:
        return "N" if ay < 0 else "S"
    else:
        return "E" if ax > 0 else "W"

def read_uart_line():
    """Return a stripped string if a full line is available, else None."""
    if uart.in_waiting:
        try:
            return uart.readline().decode("utf-8").strip()
        except Exception:
            return None
    return None

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

IDLE    = "idle"
ARMED   = "armed"
READING = "reading"
LOCKED  = "locked"

state          = IDLE
window_start   = 0.0
current_dir    = None   # direction currently being shown during READING
pulse_bright   = True
pulse_tick     = 0.0
stream_tick    = 0.0

pixels_off()
print("DataTwist CPB ready — advertising BLE…")
ble.start_advertising(advertisement)

while True:
    now = time.monotonic()

    # ---- Handle BLE connect/disconnect ----
    if not ble.connected:
        if state != IDLE:
            state = IDLE
            current_dir = None
            pixels_off()
        time.sleep(0.1)
        continue

    # ---- Read incoming BLE command ----
    cmd = read_uart_line()
    if cmd == "ARM" and state in (IDLE, LOCKED):
        pixels_off()
        state        = ARMED
        current_dir  = None
        pulse_bright = True
        pulse_tick   = now
        stream_tick  = now
        print("ARM received — lights on, waiting for GO")

    elif cmd == "GO" and state == ARMED:
        state        = READING
        window_start = now
        current_dir  = None
        pulse_bright = True
        pulse_tick   = now
        print("GO received — response window open")

    # ---- State machine ----
    if state == IDLE:
        pixels_off()

    elif state == LOCKED:
        pass  # hold last color until ARM resets

    elif state == ARMED:
        # Direction detection active so participants can position themselves,
        # but no sound — that only starts once GO is received
        ax, ay, az = cp.acceleration
        direction = detect_direction(ax, ay, az)

        if direction != current_dir:
            current_dir = direction
            if direction:
                pixels_set(COLORS[direction])
            else:
                pixels_set(WHITE if pulse_bright else WHITE_DIM)

        # White pulse when flat/no direction
        if not direction and (now - pulse_tick) >= 0.5:
            pulse_bright = not pulse_bright
            pixels_set(WHITE if pulse_bright else WHITE_DIM)
            pulse_tick = now

        # Stream current direction to browser every 500ms
        if (now - stream_tick) >= STREAM_INTERVAL_S:
            uart.write(STREAM_CHARS.get(current_dir, "_").encode("utf-8"))
            stream_tick = now

    elif state == READING:
        elapsed = now - window_start
        ax, ay, az = cp.acceleration
        direction = detect_direction(ax, ay, az)

        # Update live color + beep when direction changes
        if direction != current_dir:
            current_dir = direction
            if direction:
                pixels_set(COLORS[direction])
                cp.play_tone(TONES[direction][0], TONES[direction][1])
            else:
                pixels_set(WHITE if pulse_bright else WHITE_DIM)

        # Stream current direction to browser every 500ms
        if (now - stream_tick) >= STREAM_INTERVAL_S:
            uart.write(STREAM_CHARS.get(current_dir, "_").encode("utf-8"))
            stream_tick = now

        # Beep on BEEP command from browser (browser drives timing)
        if cmd == "BEEP" and current_dir:
            cp.play_tone(TONES[current_dir][0], TONES[current_dir][1])

        # White pulse when no direction held
        if not direction and (now - pulse_tick) >= 0.5:
            pulse_bright = not pulse_bright
            pixels_set(WHITE if pulse_bright else WHITE_DIM)
            pulse_tick = now

        # Window expired — lock in answer, hold color until next ARM
        if elapsed >= RESPONSE_WINDOW_S:
            answer = current_dir  # None = no answer
            if answer:
                pixels_set(COLORS[answer])
                cp.play_tone(TONES[answer][0], TONES[answer][1])
                uart.write((answer + "\n").encode("utf-8"))
                print(f"Locked: {answer}")
            else:
                pixels_off()
                uart.write(b"-\n")   # signal no answer
                print("Locked: no answer")

            state = LOCKED  # hold color until coordinator hits spin again

    time.sleep(0.05)  # ~20 Hz
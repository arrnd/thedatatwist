# The Data Twist: Technical Design Document

## 1. Compass Wearables

### Hardware

Each participant wears a **Circuit Playground Bluefruit (CPB)**, a circular microcontroller board by Adafruit. It integrates an accelerometer for tilt detection, NeoPixel LEDs for real-time color feedback, a piezo speaker for synchronized audio cues, and Bluetooth Low Energy (BLE) for wireless communication with the coordinator's laptop.

The board is worn face-up on the wrist like a watch, USB port facing the elbow. This orientation maps arm tilts to compass directions:

| Gesture | Direction | Meaning | Color |
|---|---|---|---|
| Tilt arm upward | North | Strongly Agree | Green |
| Tilt arm downward | South | Strongly Disagree | Red |
| Tilt arm right | East | Somewhat Agree | Yellow |
| Tilt arm left | West | Somewhat Disagree | Blue |
| Board flat | Neutral | No response | Grey |

Up to 8 boards (DataTwist1 through DataTwist8) can be connected simultaneously.

---

### Firmware

The firmware runs on CircuitPython and operates as a four-state machine:

**IDLE** is the default state when the board is powered on or between rounds. LEDs are off and the board is advertising over BLE but not detecting any input.

**ARMED** is triggered when the coordinator clicks spin. LEDs pulse white to signal that the round is about to begin. The board starts streaming direction samples to the browser every 50ms.

**READING** begins 5 seconds into the countdown when the board receives a GO command. Direction detection and audio feedback are enabled. Participants actively tilt their boards to indicate their response.

**LOCKED** is the final state reached when the 10-second window closes. The board sends its last detected direction as a definitive answer and holds its color until the next round.

---

### BLE Communication

The board communicates with the browser over the Nordic UART Service, a standard BLE protocol for serial data. The browser sends commands to the board, and the board streams back direction samples and final answers.

Commands are sent automatically by the browser during a round. ARM is sent the moment the coordinator clicks spin. GO is sent automatically 5 seconds later when the response window opens. BEEP is sent every second during the response window so all boards produce their audio cue in sync, regardless of any BLE timing differences between boards.

During ARMED and READING, the board sends one direction character every 50ms, allowing the browser to record a continuous motion trace for the visualization. At lock-in, the board sends a single uppercase letter representing the participant's final answer.

Each board is configured with a static Bluetooth MAC address at startup. This prevents the chip's default address rotation from creating duplicate entries in Chrome's Bluetooth device picker.

---

## 2. Canvas Visualization

The visualization runs automatically after every Compass round, triggered when the countdown ends. It is displayed full-screen and dismissed by the coordinator before the next statement.

### Brush Strokes

The visualization replays each participant's 10-second motion history as a sequence of painterly brush strokes on a canvas. Each direction the participant tilted their board becomes a stroke in the corresponding color, curving organically across the canvas. The strokes are generated using **Perfect Freehand**, a library designed specifically for natural-looking variable-width brush marks.

Consecutive samples in the same direction are grouped into a single stroke. Each stroke starts wide and tapers to a point at the end, like a real brush dragged across paper. Multiple strokes overlap with a multiply blend, creating a watercolor-like layering effect.

When a participant holds their board flat (neutral), no movement is recorded. This is rendered as a stationary grey blob at the current position, growing in size the longer the board stays flat, as if the brush is being held still and ink is pooling.

### Color Flood

After the brush strokes finish animating, the dominant response color sweeps across the canvas from its directional origin over 10 seconds. Green rises from the bottom, red falls from the top, yellow sweeps from the left, and blue from the right. The sweep uses a color blend mode that shifts the hue of the brush strokes toward the dominant color while giving the background a pastel tint, so the motion history remains visible through the wash.

When multiple directions tie, the canvas is divided into equal vertical strips, one per color, with yellow always at the left border and blue always at the right.

---

## 3. Website Sequential Redesign

### Previous Design

The original site was a single scrollable page with all controls visible at once. During a live performance this created visual clutter and required the coordinator to navigate multiple UI elements simultaneously.

### New Design

The redesigned site is a **full-screen slideshow** where one slide occupies the entire screen at a time. The coordinator advances slides using on-screen arrow buttons or keyboard arrow keys, following a linear flow that matches the natural sequence of the performance.

### Slide Flow

**Slide 1: Welcome** shows the project title and event date. It serves as the opening screen before the session begins.

**Slide 2: Game Setup** displays the selected game's title, choreographic designers, orientation instructions, and rules. The coordinator can cycle through all six games using the next game button. Clicking play advances to the next slide.

**Slide 3: Connect** (Compass only) shows eight pairing cards, one per participant board. Each card is clicked to open the Bluetooth picker and connect that board. This slide is skipped entirely for non-Compass games.

**Slide 4: Play** is the active screen during each round. It shows the visual key image alongside the spin button, body part if applicable, statement, and countdown. For the Compass game, the canvas visualization appears automatically at the end of each round.

### Data Loading

Game content (names, designers, orientation descriptions, and rules) is loaded dynamically from a Google Sheet at page load. Statements are loaded from a separate sheet. This means game content can be updated or new statements can be added without touching the code.

---

## 4. Technology Stack

| Layer | Technology |
|---|---|
| Microcontroller | Adafruit Circuit Playground Bluefruit |
| Firmware | CircuitPython 10.1.4 |
| Wireless | Bluetooth Low Energy via Web Bluetooth API |
| Frontend | HTML, CSS, JavaScript with Bootstrap 5 |
| Data | D3.js loading CSV from Google Sheets |
| Visualization | HTML5 Canvas with Perfect Freehand |
| Hosting | GitHub Pages or localhost |
| Browser | Chrome or Edge required |

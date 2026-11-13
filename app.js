/*
 * AR Volleyball - Under Pass Challenge
 * Frontend: GitHub Pages (HTTPS)
 * AI: MediaPipe Tasks Vision (Pose Landmarker)
 * Backend: Google Apps Script JSONP endpoint
 */

const CONFIG = Object.freeze({
  API_URL: "PASTE_YOUR_APPS_SCRIPT_WEB_APP_EXEC_URL_HERE",
  GAME_SECONDS: 180,
  CALIBRATION_MS: 1600,
  MODEL_TIMEOUT_MS: 30000,
  API_TIMEOUT_MS: 12000,
  // ปรับความเข้มงวดหลังทดลองกับผู้เล่นจริง
  MIN_ELBOW_ANGLE: 128,
  MAX_WRIST_TO_SHOULDER_RATIO: 0.58,
  MIN_LANDMARK_VISIBILITY: 0.50,
  SHOW_SKELETON: true
});

const MODEL_CANDIDATES = [
  {
    bundle: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  },
  {
    bundle: "https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
    wasm: "https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm"
  }
];

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const $ = (id) => document.getElementById(id);

const ui = {
  home: $("homeScreen"),
  game: $("gameScreen"),
  result: $("resultScreen"),
  video: $("webcam"),
  canvas: $("overlay"),
  score: $("score"),
  timer: $("timer"),
  phase: $("phaseLabel"),
  statusTitle: $("statusTitle"),
  statusText: $("statusText"),
  progress: $("calibrationProgress"),
  tip: $("tipBubble"),
  feedback: $("feedback"),
  playerName: $("playerName"),
  errorModal: $("errorModal"),
  leaderboardModal: $("leaderboardModal")
};

const ctx = ui.canvas.getContext("2d", { alpha: true });

let cameraStream = null;
let poseLandmarker = null;
let wasmBasePath = null;
let modelLoadPromise = null;
let gameLoopId = null;
let running = false;
let finishing = false;
let phase = "home"; // home | calibrating | playing | result

let score = 0;
let combo = 0;
let gameStartedAt = 0;
let previousAnimationAt = 0;
let previousVideoTime = -1;
let previousDetectionAt = 0;
let calibrationMs = 0;
let lastScoreAt = 0;
let currentPose = null;
let currentUnder = { good: false, reason: "มองกล้องให้เห็นแขนทั้งสองข้าง" };
let ball = null;
let canvasCssWidth = 0;
let canvasCssHeight = 0;
let canvasDpr = 1;

bindEvents();
renderInitialTimer();

function bindEvents() {
  $("startBtn").addEventListener("click", startGame);
  $("exitBtn").addEventListener("click", () => finishGame(false));
  $("playAgainBtn").addEventListener("click", returnHome);
  $("leaderboardBtn").addEventListener("click", showLeaderboard);
  $("resultLeaderboardBtn").addEventListener("click", showLeaderboard);
  $("closeLeaderboard").addEventListener("click", () => ui.leaderboardModal.classList.add("hidden"));
  $("closeError").addEventListener("click", () => ui.errorModal.classList.add("hidden"));

  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("orientationchange", () => {
    window.setTimeout(resizeCanvas, 250);
  });

  document.addEventListener("visibilitychange", () => {
    // หยุดเมื่อผู้เล่นสลับแอป เพื่อลดปัญหากล้องค้างและเวลาเดินต่อโดยไม่เห็นเกม
    if (document.hidden && running) {
      finishGame(false);
    }
  });
}

function showScreen(target) {
  [ui.home, ui.game, ui.result].forEach((screen) => screen.classList.add("hidden"));
  target.classList.remove("hidden");
}

function setStatus(title, text) {
  ui.statusTitle.textContent = title;
  ui.statusText.textContent = text;
}

function showError(title, message) {
  $("errorTitle").textContent = title;
  $("errorText").textContent = message;
  ui.errorModal.classList.remove("hidden");
}

function renderInitialTimer() {
  ui.timer.textContent = formatTime(CONFIG.GAME_SECONDS);
}

function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/* Start is called directly from a user click. Request camera before any long AI download. */
async function startGame() {
  if (running || phase === "calibrating" || phase === "playing") return;

  const name = ui.playerName.value.trim();
  if (!name) {
    showError("กรุณากรอกชื่อผู้เล่น", "กรอกชื่อหรือรหัสผู้เล่นก่อนเริ่มเกม");
    return;
  }

  $("startBtn").disabled = true;
  ui.errorModal.classList.add("hidden");
  showScreen(ui.game);
  phase = "calibrating";

  resetGameState();
  resizeCanvas();
  setStatus("กำลังขอใช้กล้อง 📷", "โปรดกด Allow เมื่อ Safari ถามสิทธิ์การใช้งานกล้อง");

  try {
    await startCamera();
    setStatus("กล้องพร้อมแล้ว", "กำลังโหลดระบบ AI ตรวจจับท่าทาง...");

    await loadPoseModel();

    running = true;
    previousAnimationAt = performance.now();
    previousVideoTime = -1;
    previousDetectionAt = 0;
    setStatus("เตรียมท่าอันเดอร์ 🤝", "ประสานมือ เหยียดแขน และค้างท่าเพื่อปรับเทียบ");
    ui.tip.textContent = "💡 ให้กล้องเห็นไหล่ ข้อศอก และข้อมือทั้งสองข้าง";
    gameLoopId = requestAnimationFrame(gameLoop);
  } catch (error) {
    console.error("[AR Volleyball] Start failed:", error);
    stopCamera();
    running = false;
    phase = "home";
    showScreen(ui.home);
    $("startBtn").disabled = false;
    showError(getFriendlyErrorTitle(error), getFriendlyErrorMessage(error));
  }
}

function resetGameState() {
  score = 0;
  combo = 0;
  calibrationMs = 0;
  lastScoreAt = 0;
  gameStartedAt = 0;
  currentPose = null;
  currentUnder = { good: false, reason: "มองกล้องให้เห็นแขนทั้งสองข้าง" };
  ball = null;

  ui.score.textContent = "0";
  ui.timer.textContent = formatTime(CONFIG.GAME_SECONDS);
  ui.phase.textContent = "CALIBRATION";
  ui.progress.style.width = "0%";
  ui.feedback.classList.add("hidden");
}

/* CAMERA */
async function startCamera() {
  if (!window.isSecureContext) {
    throw new Error("INSECURE_CONTEXT");
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    throw new Error("CAMERA_API_UNAVAILABLE");
  }

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: "user" },
      width: { ideal: 960 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    }
  };

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    // Fallback for devices that reject the preferred resolution.
    if (error.name === "OverconstrainedError") {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user" }
      });
    } else {
      throw error;
    }
  }

  ui.video.srcObject = cameraStream;
  ui.video.setAttribute("playsinline", "");
  ui.video.muted = true;

  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("CAMERA_START_TIMEOUT")), 12000);
    ui.video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    ui.video.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("VIDEO_ELEMENT_ERROR"));
    };
  });

  await ui.video.play();
  resizeCanvas();
}

/* MEDIAPIPE: Dynamic import is awaited here. No window.vision race condition. */
async function loadPoseModel() {
  if (poseLandmarker) return;
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    let module = null;
    let lastImportError = null;

    for (const candidate of MODEL_CANDIDATES) {
      try {
        module = await withTimeout(
          import(candidate.bundle),
          CONFIG.MODEL_TIMEOUT_MS,
          "หมดเวลารอโหลด MediaPipe JavaScript จาก CDN"
        );
        wasmBasePath = candidate.wasm;
        break;
      } catch (error) {
        console.warn("MediaPipe CDN failed:", candidate.bundle, error);
        lastImportError = error;
      }
    }

    if (!module) {
      throw new Error(
        "โหลด MediaPipe ไม่สำเร็จจาก CDN ทั้งสองแหล่ง กรุณาตรวจสอบอินเทอร์เน็ตหรือเครือข่ายที่บล็อก CDN " +
        (lastImportError?.message || "")
      );
    }

    const { FilesetResolver, PoseLandmarker } = module;
    if (!FilesetResolver || !PoseLandmarker) {
      throw new Error("MediaPipe module ไม่มี FilesetResolver หรือ PoseLandmarker");
    }

    const vision = await withTimeout(
      FilesetResolver.forVisionTasks(wasmBasePath),
      CONFIG.MODEL_TIMEOUT_MS,
      "หมดเวลารอโหลด MediaPipe WASM"
    );

    poseLandmarker = await withTimeout(
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.55,
        minPosePresenceConfidence: 0.55,
        minTrackingConfidence: 0.55
      }),
      CONFIG.MODEL_TIMEOUT_MS,
      "หมดเวลารอโหลดโมเดลตรวจจับร่างกาย"
    );
  })();

  try {
    await modelLoadPromise;
  } catch (error) {
    modelLoadPromise = null; // permit retry after a network failure
    throw error;
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => window.setTimeout(() => reject(new Error(message)), ms))
  ]);
}

/* CANVAS AND VIDEO COORDINATES */
function resizeCanvas() {
  const rect = ui.game.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  canvasCssWidth = rect.width;
  canvasCssHeight = rect.height;
  canvasDpr = Math.min(window.devicePixelRatio || 1, 2);

  ui.canvas.width = Math.round(canvasCssWidth * canvasDpr);
  ui.canvas.height = Math.round(canvasCssHeight * canvasDpr);
  ui.canvas.style.width = `${canvasCssWidth}px`;
  ui.canvas.style.height = `${canvasCssHeight}px`;
  ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
}

/*
 * CSS video is mirrored and object-fit: cover.
 * MediaPipe coordinates are mapped to the same visible, mirrored viewport.
 */
function mapPoint(landmark) {
  const sourceWidth = ui.video.videoWidth || canvasCssWidth;
  const sourceHeight = ui.video.videoHeight || canvasCssHeight;
  const scale = Math.max(canvasCssWidth / sourceWidth, canvasCssHeight / sourceHeight);
  const shownWidth = sourceWidth * scale;
  const shownHeight = sourceHeight * scale;
  const offsetX = (canvasCssWidth - shownWidth) / 2;
  const offsetY = (canvasCssHeight - shownHeight) / 2;

  return {
    x: (1 - landmark.x) * shownWidth + offsetX,
    y: landmark.y * shownHeight + offsetY
  };
}

/* MAIN GAME LOOP */
function gameLoop(timestamp) {
  if (!running) return;

  const dt = Math.min(Math.max((timestamp - previousAnimationAt) / 1000, 0), 0.05);
  previousAnimationAt = timestamp;

  if (ui.video.readyState >= 2 && ui.video.currentTime !== previousVideoTime) {
    previousVideoTime = ui.video.currentTime;

    try {
      const result = poseLandmarker.detectForVideo(ui.video, timestamp);
      currentPose = result.landmarks?.[0] || null;
      currentUnder = currentPose
        ? evaluateUnderPass(currentPose)
        : { good: false, reason: "ไม่พบร่างกาย กรุณาถอยให้เห็นช่วงบนและแขน" };

      handleCalibration(timestamp);
    } catch (error) {
      console.error("Pose detection error:", error);
      setStatus("AI ตรวจจับสะดุด", "ลองจัดแสงหรือขยับให้อยู่ในภาพกล้อง");
    }
  }

  if (phase === "playing") {
    const elapsed = (timestamp - gameStartedAt) / 1000;
    const remaining = Math.max(0, CONFIG.GAME_SECONDS - elapsed);
    ui.timer.textContent = formatTime(remaining);
    if (remaining <= 0) {
      finishGame(true);
      return;
    }
    updateBall(dt);
  }

  renderFrame();
  gameLoopId = requestAnimationFrame(gameLoop);
}

/* UNDER-PASS POSTURE APPROXIMATION */
function evaluateUnderPass(pose) {
  const leftShoulder = pose[11];
  const rightShoulder = pose[12];
  const leftElbow = pose[13];
  const rightElbow = pose[14];
  const leftWrist = pose[15];
  const rightWrist = pose[16];

  const required = [
    leftShoulder, rightShoulder, leftElbow,
    rightElbow, leftWrist, rightWrist
  ];

  if (required.some(point => !point)) {
    return { good: false, reason: "ให้เห็นไหล่ ข้อศอก และข้อมือทั้งสองข้าง" };
  }

  const visible = required.every(point => {
    const confidence = point.visibility ?? point.presence ?? 1;
    return confidence >= CONFIG.MIN_LANDMARK_VISIBILITY;
  });

  if (!visible) {
    return { good: false, reason: "แขนถูกบังหรืออยู่นอกภาพ กรุณาจัดตำแหน่งใหม่" };
  }

  const shoulderWidth = distance(leftShoulder, rightShoulder);
  if (shoulderWidth < 0.06) {
    return { good: false, reason: "กรุณาถอยให้เห็นช่วงไหล่ชัดเจน" };
  }

  const leftAngle = calculateAngle(leftShoulder, leftElbow, leftWrist);
  const rightAngle = calculateAngle(rightShoulder, rightElbow, rightWrist);
  const wristsDistance = distance(leftWrist, rightWrist);
  const wristRatio = wristsDistance / shoulderWidth;

  const armsExtended =
    leftAngle >= CONFIG.MIN_ELBOW_ANGLE &&
    rightAngle >= CONFIG.MIN_ELBOW_ANGLE;

  const handsTogether = wristRatio <= CONFIG.MAX_WRIST_TO_SHOULDER_RATIO;
  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const wristY = (leftWrist.y + rightWrist.y) / 2;
  const handsInFront = wristY > shoulderY - 0.025;
  const wristsLevel = Math.abs(leftWrist.y - rightWrist.y) < 0.18;

  const leftForearmMid = midpoint(mapPoint(leftElbow), mapPoint(leftWrist));
  const rightForearmMid = midpoint(mapPoint(rightElbow), mapPoint(rightWrist));
  const platform = {
    a: leftForearmMid,
    b: rightForearmMid,
    center: midpoint(leftForearmMid, rightForearmMid)
  };

  let reason = "ท่าอันเดอร์พร้อมแล้ว";
  if (!handsTogether) reason = "ประสานมือทั้งสองข้างให้ใกล้กัน";
  else if (!armsExtended) reason = "เหยียดแขนให้ตรงขึ้น";
  else if (!handsInFront) reason = "ยื่นแขนไว้ด้านหน้าลำตัว";
  else if (!wristsLevel) reason = "จัดแนวข้อมือทั้งสองข้างให้ใกล้ระดับเดียวกัน";

  return {
    good: handsTogether && armsExtended && handsInFront && wristsLevel,
    reason,
    platform,
    leftAngle,
    rightAngle,
    wristRatio
  };
}

function handleCalibration(timestamp) {
  if (phase !== "calibrating") return;

  const frameDelta = previousDetectionAt
    ? Math.min(timestamp - previousDetectionAt, 100)
    : 0;
  previousDetectionAt = timestamp;

  if (currentUnder.good) {
    calibrationMs += frameDelta;
  } else {
    calibrationMs = Math.max(0, calibrationMs - frameDelta * 1.8);
  }

  const progress = Math.min(100, Math.round((calibrationMs / CONFIG.CALIBRATION_MS) * 100));
  ui.progress.style.width = `${progress}%`;
  setStatus(
    currentUnder.good ? "ท่าดีมาก! กำลังปรับเทียบ 🤝" : "เตรียมท่าอันเดอร์",
    currentUnder.reason
  );

  if (calibrationMs >= CONFIG.CALIBRATION_MS) {
    phase = "playing";
    ui.phase.textContent = "MATCH ON";
    ui.tip.textContent = "🏐 รับลูกด้วยแนวท่อนแขน ไม่ใช่ยื่นมือแตะลูก";
    setStatus("เริ่มการแข่งขันแล้ว!", "รับลูกที่ตกลงมาโดยรักษาท่าอันเดอร์");
    gameStartedAt = timestamp;
    previousAnimationAt = timestamp;
    spawnBall();
  }
}

/* RENDER OVERLAY */
function renderFrame() {
  ctx.clearRect(0, 0, canvasCssWidth, canvasCssHeight);

  if (currentPose && CONFIG.SHOW_SKELETON) {
    drawSkeleton(currentPose);
  }

  if (ball) drawVolleyball(ball.x, ball.y, ball.radius);
}

function drawSkeleton(pose) {
  const pairs = [[11,13],[13,15],[12,14],[14,16],[11,12]];
  const good = currentUnder.good;

  ctx.save();
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.strokeStyle = good ? "rgba(45,255,161,.9)" : "rgba(120,195,255,.78)";

  pairs.forEach(([a,b]) => {
    const p1 = mapPoint(pose[a]);
    const p2 = mapPoint(pose[b]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  });

  [11,12,13,14,15,16].forEach(index => {
    const p = mapPoint(pose[index]);
    ctx.beginPath();
    ctx.fillStyle = good ? "#4dffb0" : "#ffdf65";
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
  });

  if (currentUnder.platform) {
    const {a,b} = currentUnder.platform;
    ctx.strokeStyle = good ? "rgba(45,255,161,.9)" : "rgba(255,221,100,.65)";
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(a.x,a.y);
    ctx.lineTo(b.x,b.y);
    ctx.stroke();
  }
  ctx.restore();
}

/* VOLLEYBALL */
function spawnBall() {
  const width = canvasCssWidth;
  const height = canvasCssHeight;
  const platformCenter = currentUnder.platform?.center;
  const targetX = platformCenter
    ? platformCenter.x
    : width * 0.5;

  const radius = Math.max(23, Math.min(width, height) * 0.047);
  const variation = (Math.random() - 0.5) * width * 0.20;

  ball = {
    x: clamp(targetX + variation, radius + 12, width - radius - 12),
    y: -radius - 5,
    vx: (Math.random() - 0.5) * 24,
    vy: 75 + Math.min(score * 3, 100),
    radius,
    scored: false
  };
}

function updateBall(dt) {
  if (!ball) return;

  const gravity = 430;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.vy += gravity * dt;

  if (!ball.scored && currentUnder.good && currentUnder.platform && ball.vy > 0) {
    const {a,b} = currentUnder.platform;
    const tolerance = ball.radius + 30;
    const hitDistance = pointToSegmentDistance(ball.x, ball.y, a.x, a.y, b.x, b.y);

    if (hitDistance <= tolerance) {
      registerHit();
      return;
    }
  }

  if (ball.scored && ball.y < -ball.radius * 2) {
    spawnBall();
    return;
  }

  if (ball.y > canvasCssHeight + ball.radius * 2) {
    combo = 0;
    $("combo").textContent = "x0";
    ui.tip.textContent = "ลองอีกครั้ง! จัดแนวท่อนแขนให้ตรงกับลูกบอล";
    spawnBall();
  }
}

function registerHit() {
  if (!ball || ball.scored) return;

  ball.scored = true;
  ball.vy = -Math.max(300, canvasCssHeight * 0.52);
  ball.vx += (Math.random() - 0.5) * 70;

  score += 1;
  combo += 1;
  ui.score.textContent = String(score);
  $("combo").textContent = `x${combo}`;
  ui.tip.textContent = combo >= 3
    ? `🔥 ${combo} COMBO! สุดยอดมาก`
    : "✨ รับลูกสำเร็จ! +1 คะแนน";

  showFeedback(combo >= 3 ? `GREAT! +1` : "NICE! +1");
}

function drawVolleyball(x, y, radius) {
  ctx.save();
  ctx.translate(x, y);

  // soft shadow
  ctx.beginPath();
  ctx.ellipse(5, radius * 0.85, radius * 0.82, radius * 0.22, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.fill();

  const gradient = ctx.createRadialGradient(-radius*.32, -radius*.35, radius*.08, 0, 0, radius);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(.72, "#edf2f7");
  gradient.addColorStop(1, "#aab7c9");

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, radius - 1, 0, Math.PI * 2);
  ctx.clip();

  ctx.strokeStyle = "#68778d";
  ctx.lineWidth = Math.max(2, radius * .075);

  ctx.beginPath();
  ctx.moveTo(-radius*.92, -radius*.18);
  ctx.bezierCurveTo(-radius*.25, -radius*.85, radius*.3, -radius*.82, radius*.92, -.05*radius);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-radius*.6, radius*.78);
  ctx.bezierCurveTo(-radius*.15, radius*.05, radius*.48, radius*.1, radius*.82, radius*.72);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-radius*.75, -radius*.65);
  ctx.bezierCurveTo(-radius*.25, -.05*radius, -radius*.15, radius*.4, radius*.35, radius*.92);
  ctx.stroke();

  ctx.restore();

  ctx.beginPath();
  ctx.arc(-radius*.3, -radius*.35, radius*.13, 0, Math.PI*2);
  ctx.fillStyle = "rgba(255,255,255,.75)";
  ctx.fill();

  ctx.restore();
}

function showFeedback(text) {
  ui.feedback.textContent = text;
  ui.feedback.classList.remove("hidden", "pop");
  void ui.feedback.offsetWidth;
  ui.feedback.classList.add("pop");
  window.setTimeout(() => ui.feedback.classList.add("hidden"), 700);
}

/* TIMER AND CLEANUP */
function stopCamera() {
  running = false;
  if (gameLoopId) cancelAnimationFrame(gameLoopId);
  gameLoopId = null;

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  ui.video.pause();
  ui.video.srcObject = null;
}

async function finishGame(saveResult) {
  if (finishing) return;
  finishing = true;
  stopCamera();
  phase = saveResult ? "result" : "home";

  if (!saveResult) {
    finishing = false;
    $("startBtn").disabled = false;
    showScreen(ui.home);
    return;
  }

  $("finalScore").textContent = String(score);
  $("resultName").textContent = ui.playerName.value.trim();
  $("saveStatus").textContent = "กำลังบันทึกคะแนน...";
  showScreen(ui.result);

  try {
    await apiJSONP({
      action: "save",
      name: ui.playerName.value.trim(),
      score: String(score)
    });
    $("saveStatus").textContent = "✅ บันทึกคะแนนเรียบร้อย";
  } catch (error) {
    console.error("Save score failed:", error);
    $("saveStatus").textContent = "⚠️ จบเกมแล้ว แต่บันทึกคะแนนไม่สำเร็จ";
  } finally {
    finishing = false;
    $("startBtn").disabled = false;
  }
}

function returnHome() {
  showScreen(ui.home);
  phase = "home";
  $("startBtn").disabled = false;
  renderInitialTimer();
  ui.progress.style.width = "0%";
}

/* GOOGLE APPS SCRIPT JSONP API */
function apiJSONP(params) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.API_URL || !CONFIG.API_URL.startsWith("https://script.google.com/")) {
      reject(new Error("กรุณาตั้งค่า API_URL ใน app.js ให้เป็น URL /exec ของ Apps Script"));
      return;
    }

    const callbackName = `arvCallback_${Date.now()}_${Math.floor(Math.random()*100000)}`;
    const query = new URLSearchParams({
      ...params,
      callback: callbackName
    });
    const script = document.createElement("script");
    let settled = false;

    const timeout = window.setTimeout(() => {
      cleanup(new Error("หมดเวลารอ Google Apps Script API"));
    }, CONFIG.API_TIMEOUT_MS);

    function cleanup(error, data) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
      if (error) reject(error);
      else if (data && data.ok === false) reject(new Error(data.error || "API error"));
      else resolve(data);
    }

    window[callbackName] = data => cleanup(null, data);
    script.onerror = () => cleanup(new Error("โหลด Apps Script API ไม่สำเร็จ ตรวจสอบ URL และสิทธิ์ Deploy"));

    script.src = `${CONFIG.API_URL}?${query.toString()}`;
    document.body.appendChild(script);
  });
}

async function showLeaderboard() {
  ui.leaderboardModal.classList.remove("hidden");
  const list = $("leaderboardList");
  list.innerHTML = "<li>กำลังโหลดคะแนน...</li>";

  try {
    const response = await apiJSONP({action:"leaderboard"});
    const rows = response.rows || [];
    if (!rows.length) {
      list.innerHTML = "<li>ยังไม่มีคะแนนการแข่งขัน</li>";
      return;
    }

    list.innerHTML = rows.map((row, index) => {
      const safeName = escapeHTML(row.name);
      const safeScore = Number(row.score) || 0;
      return `<li><b>#${index + 1}</b> ${safeName}<span>${safeScore}</span></li>`;
    }).join("");
  } catch (error) {
    console.error("Leaderboard failed:", error);
    list.innerHTML = "<li>โหลดอันดับไม่สำเร็จ กรุณาตรวจสอบ Apps Script API</li>";
  }
}

/* ERROR MESSAGES */
function getFriendlyErrorTitle(error) {
  if (error.name === "NotAllowedError" || error.message === "INSECURE_CONTEXT") return "เข้าใช้กล้องไม่ได้";
  if (error.message.includes("MediaPipe")) return "โหลดระบบ AI ไม่สำเร็จ";
  if (error.message.includes("โมเดล") || error.message.includes("WASM")) return "เตรียม AI ไม่สำเร็จ";
  return "เริ่มเกมไม่สำเร็จ";
}

function getFriendlyErrorMessage(error) {
  if (error.message === "INSECURE_CONTEXT") {
    return "เว็บไซต์ต้องเปิดผ่าน HTTPS เช่น GitHub Pages";
  }
  if (error.message === "CAMERA_API_UNAVAILABLE") {
    return "เบราว์เซอร์นี้ไม่รองรับการเปิดกล้อง กรุณาใช้ Safari รุ่นปัจจุบันบน iPhone หรือ Chrome บน Android";
  }
  if (error.name === "NotAllowedError") {
    return "เบราว์เซอร์ปฏิเสธการใช้กล้อง กรุณาตรวจสอบ Settings ของ Safari > Camera และอนุญาตเว็บไซต์นี้";
  }
  if (error.name === "NotFoundError") return "ไม่พบกล้องในอุปกรณ์";
  if (error.name === "NotReadableError") return "กล้องอาจกำลังถูกใช้งานโดยแอปอื่น กรุณาปิดแอปกล้องแล้วลองใหม่";
  if (error.name === "OverconstrainedError") return "กล้องไม่รองรับค่าความละเอียดที่ร้องขอ ลองใช้กล้องหรือเบราว์เซอร์อื่น";
  return error.message || "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ กรุณาลองใหม่";
}

/* MATH HELPERS */
function distance(a,b) {
  return Math.hypot(a.x-b.x, a.y-b.y);
}

function midpoint(a,b) {
  return {x:(a.x+b.x)/2, y:(a.y+b.y)/2};
}

function calculateAngle(a,b,c) {
  const ba = {x:a.x-b.x,y:a.y-b.y};
  const bc = {x:c.x-b.x,y:c.y-b.y};
  const denominator = Math.hypot(ba.x,ba.y) * Math.hypot(bc.x,bc.y);
  if (!denominator) return 0;
  const cosine = clamp((ba.x*bc.x + ba.y*bc.y)/denominator,-1,1);
  return Math.acos(cosine) * 180 / Math.PI;
}

function pointToSegmentDistance(px,py,x1,y1,x2,y2) {
  const dx=x2-x1, dy=y2-y1;
  const lengthSquared=dx*dx+dy*dy;
  if (!lengthSquared) return Math.hypot(px-x1,py-y1);
  const t=clamp(((px-x1)*dx+(py-y1)*dy)/lengthSquared,0,1);
  const nearestX=x1+t*dx, nearestY=y1+t*dy;
  return Math.hypot(px-nearestX,py-nearestY);
}

function clamp(value,min,max) {
  return Math.min(max,Math.max(min,value));
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[char]);
}

window.addEventListener("beforeunload", stopCamera);

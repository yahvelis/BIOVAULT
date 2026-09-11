/* ============================================================
   BIOVAULT — front-end logic
   Runs entirely in the browser. Face descriptors and the audit
   log are stored in localStorage — nothing leaves the device.
   ============================================================ */

const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js/weights";
const USERS_KEY = "biovault_users";
const LOG_KEY = "biovault_log";
const SAMPLES_NEEDED = 5;

let modelsReady = false;
let stream = null;
let pendingSamples = [];
let threshold = 0.5;

/* ---------------- storage helpers ---------------- */

function getUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; }
  catch { return []; }
}
function saveUsers(users) { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }

function getLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; }
  catch { return []; }
}
function saveLog(log) { localStorage.setItem(LOG_KEY, JSON.stringify(log)); }

function logEvent({ user, mode, distance, result }) {
  const log = getLog();
  log.unshift({
    timestamp: new Date().toLocaleString("es-MX"),
    user: user || "DESCONOCIDO",
    mode,
    distance: distance === null ? "—" : distance.toFixed(3),
    threshold: threshold.toFixed(2),
    result,
  });
  saveLog(log.slice(0, 200));
  renderLog();
}

/* ---------------- diagrams (drawn once, static content) ---------------- */

function renderPipeline() {
  const stages = [
    "Cámara", "Preproceso", "Detección", "Extracción",
    "Comparación", "Decisión",
  ];
  const w = 700, h = 190, boxW = 96, boxH = 40, gap = 22;
  const y = 30;
  let x = 10;
  let nodes = "";
  let edges = "";

  stages.forEach((label, i) => {
    nodes += `<g class="pl-node"><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="3"/>
      <text x="${x + boxW / 2}" y="${y + boxH / 2 + 4}" text-anchor="middle">${label}</text></g>`;
    if (i < stages.length - 1) {
      const x2 = x + boxW + gap;
      edges += `<path class="pl-edge" d="M${x + boxW} ${y + boxH / 2} L${x2} ${y + boxH / 2}"/>`;
    }
    x += boxW + gap;
  });

  // branch: decision -> accept / reject
  const lastX = x - boxW - gap;
  const branchY1 = y + boxH + 55;
  const branchY2 = y + boxH + 55;
  edges += `<path class="pl-edge pl-edge--accept" d="M${lastX + boxW / 2 - 20} ${y + boxH} C ${lastX + boxW / 2 - 40} ${y + boxH + 40}, ${lastX - 60} ${branchY1 - 10}, ${lastX - 60} ${branchY1}"/>`;
  edges += `<path class="pl-edge pl-edge--reject" d="M${lastX + boxW / 2 + 20} ${y + boxH} C ${lastX + boxW / 2 + 40} ${y + boxH + 40}, ${lastX + 156} ${branchY2 - 10}, ${lastX + 156} ${branchY2}"/>`;

  nodes += `<g class="pl-node pl-node--accept"><rect x="${lastX - 108}" y="${branchY1}" width="${boxW}" height="${boxH}" rx="3"/>
    <text x="${lastX - 108 + boxW / 2}" y="${branchY1 + boxH / 2 + 4}" text-anchor="middle">Desbloquear</text></g>`;
  nodes += `<g class="pl-node pl-node--reject"><rect x="${lastX + 108}" y="${branchY2}" width="${boxW}" height="${boxH}" rx="3"/>
    <text x="${lastX + 108 + boxW / 2}" y="${branchY2 + boxH / 2 + 4}" text-anchor="middle">Bloquear</text></g>`;

  const auditY = branchY1 + boxH + 45;
  nodes += `<g class="pl-node"><rect x="${lastX - 48 + boxW/2 - 48}" y="${auditY}" width="${boxW}" height="${boxH}" rx="3"/>
    <text x="${lastX - 48 + boxW/2 - 48 + boxW/2}" y="${auditY + boxH/2 + 4}" text-anchor="middle">Auditoría</text></g>`;
  edges += `<path class="pl-edge" d="M${lastX - 108 + boxW/2} ${branchY1 + boxH} L${lastX - 48 + boxW/2 - 48 + boxW/2} ${auditY}"/>`;
  edges += `<path class="pl-edge" d="M${lastX + 108 + boxW/2} ${branchY2 + boxH} L${lastX - 48 + boxW/2 - 48 + boxW/2 + 10} ${auditY}"/>`;

  const svg = `<svg viewBox="0 0 ${w} ${auditY + boxH + 20}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="pl-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 z" fill="var(--text-faint)"/>
      </marker>
    </defs>
    ${edges}
    ${nodes}
  </svg>`;

  document.getElementById("pipeline-diagram").innerHTML = svg;
}

function renderDialTicks() {
  const group = document.querySelector(".dial-ticks");
  if (!group) return;
  let ticks = "";
  for (let i = 0; i < 36; i++) {
    const angle = (i / 36) * Math.PI * 2;
    const r1 = 200, r2 = i % 3 === 0 ? 188 : 195;
    const x1 = 210 + r1 * Math.cos(angle), y1 = 210 + r1 * Math.sin(angle);
    const x2 = 210 + r2 * Math.cos(angle), y2 = 210 + r2 * Math.sin(angle);
    ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--border)" stroke-width="1"/>`;
  }
  group.innerHTML = ticks;
}

/* ---------------- camera + models ---------------- */

async function loadModels() {
  const statusEl = document.getElementById("model-status");
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    modelsReady = true;
    statusEl.textContent = "Modelos listos. Activa la cámara para comenzar.";
  } catch (err) {
    statusEl.textContent = "No se pudieron cargar los modelos. Revisa tu conexión.";
    console.error(err);
  }
}

async function toggleCamera() {
  const btn = document.getElementById("btn-camera");
  const video = document.getElementById("video");
  const placeholder = document.getElementById("camera-placeholder");

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    placeholder.style.display = "flex";
    btn.textContent = "Activar cámara";
    return;
  }

  if (!modelsReady) {
    document.getElementById("model-status").textContent = "Espera a que terminen de cargar los modelos…";
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 } });
    video.srcObject = stream;
    placeholder.style.display = "none";
    btn.textContent = "Desactivar cámara";
    startDetectionLoop();
  } catch (err) {
    document.getElementById("model-status").textContent = "Permiso de cámara denegado o no disponible.";
    console.error(err);
  }
}

function startDetectionLoop() {
  const video = document.getElementById("video");
  const canvas = document.getElementById("overlay");

  const loop = async () => {
    if (!stream) return;
    if (video.readyState === 4) {
      canvas.width = video.clientWidth;
      canvas.height = video.clientHeight;
      const detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks();
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (detection) {
        const box = detection.detection.box;
        const scaleX = canvas.width / video.videoWidth;
        const scaleY = canvas.height / video.videoHeight;
        ctx.strokeStyle = "#c08a4e";
        ctx.lineWidth = 2;
        const bx = box.x * scaleX, by = box.y * scaleY, bw = box.width * scaleX, bh = box.height * scaleY;
        const c = 14;
        // corner brackets instead of a full rectangle
        drawCorner(ctx, bx, by, c, "tl");
        drawCorner(ctx, bx + bw, by, c, "tr");
        drawCorner(ctx, bx, by + bh, c, "bl");
        drawCorner(ctx, bx + bw, by + bh, c, "br");
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
}

function drawCorner(ctx, x, y, len, corner) {
  ctx.beginPath();
  if (corner === "tl") { ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y); }
  if (corner === "tr") { ctx.moveTo(x - len, y); ctx.lineTo(x, y); ctx.lineTo(x, y + len); }
  if (corner === "bl") { ctx.moveTo(x, y - len); ctx.lineTo(x, y); ctx.lineTo(x + len, y); }
  if (corner === "br") { ctx.moveTo(x - len, y); ctx.lineTo(x, y); ctx.lineTo(x, y - len); }
  ctx.stroke();
}

async function captureDescriptor() {
  const video = document.getElementById("video");
  if (!stream) {
    setResult("reject", "Activa la cámara primero.", {});
    return null;
  }
  const detection = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    setResult("reject", "No se detectó ningún rostro.", {});
    return null;
  }
  return Array.from(detection.descriptor);
}

/* ---------------- tabs ---------------- */

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add("is-active");
      setResult("idle", "Esperando…", {});
    });
  });
}

/* ---------------- register ---------------- */

async function handleRegisterSample() {
  const name = document.getElementById("reg-name").value.trim();
  if (!name) { setResult("reject", "Escribe un nombre antes de capturar.", {}); return; }

  const descriptor = await captureDescriptor();
  if (!descriptor) return;

  pendingSamples.push(descriptor);
  const progressEl = document.getElementById("reg-progress");
  progressEl.textContent = `${pendingSamples.length} / ${SAMPLES_NEEDED} muestras capturadas`;
  setResult("idle", `Muestra ${pendingSamples.length} capturada`, {});

  document.getElementById("btn-save-user").disabled = pendingSamples.length < SAMPLES_NEEDED;
}

function handleSaveUser() {
  const name = document.getElementById("reg-name").value.trim();
  if (!name || pendingSamples.length < SAMPLES_NEEDED) return;

  const dims = pendingSamples[0].length;
  const avg = new Array(dims).fill(0);
  pendingSamples.forEach((d) => d.forEach((v, i) => (avg[i] += v / pendingSamples.length)));

  const users = getUsers();
  const existingIdx = users.findIndex((u) => u.name.toLowerCase() === name.toLowerCase());
  const entry = { name, descriptor: avg, createdAt: new Date().toISOString() };
  if (existingIdx >= 0) users[existingIdx] = entry; else users.push(entry);
  saveUsers(users);

  pendingSamples = [];
  document.getElementById("reg-progress").textContent = `0 / ${SAMPLES_NEEDED} muestras capturadas`;
  document.getElementById("btn-save-user").disabled = true;
  document.getElementById("reg-name").value = "";
  setResult("accept", `Plantilla guardada para "${name}"`, {});
  refreshUserSelect();
}

function refreshUserSelect() {
  const select = document.getElementById("verify-user");
  const users = getUsers();
  select.innerHTML = users.length
    ? users.map((u) => `<option value="${u.name}">${u.name}</option>`).join("")
    : `<option disabled selected>No hay usuarios registrados</option>`;
}

/* ---------------- verify 1:1 ---------------- */

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

async function handleVerify() {
  const users = getUsers();
  const name = document.getElementById("verify-user").value;
  const user = users.find((u) => u.name === name);
  if (!user) { setResult("reject", "Selecciona un usuario registrado.", {}); return; }

  const descriptor = await captureDescriptor();
  if (!descriptor) return;

  const distance = euclidean(descriptor, user.descriptor);
  const accepted = distance <= threshold;

  setResult(
    accepted ? "accept" : "reject",
    accepted ? `Acceso autorizado — ${user.name}` : `Acceso rechazado — no coincide con ${user.name}`,
    { distance, threshold }
  );
  logEvent({ user: user.name, mode: "1:1", distance, result: accepted ? "ACEPTADO" : "RECHAZADO" });
  setVaultState(accepted);
}

/* ---------------- identify 1:N ---------------- */

async function handleIdentify() {
  const users = getUsers();
  if (!users.length) { setResult("reject", "No hay plantillas registradas todavía.", {}); return; }

  const descriptor = await captureDescriptor();
  if (!descriptor) return;

  let best = null, bestDist = Infinity;
  users.forEach((u) => {
    const d = euclidean(descriptor, u.descriptor);
    if (d < bestDist) { bestDist = d; best = u; }
  });

  const accepted = bestDist <= threshold;
  setResult(
    accepted ? "accept" : "reject",
    accepted ? `Identificado como ${best.name}` : `Desconocido (más cercano: ${best.name})`,
    { distance: bestDist, threshold }
  );
  logEvent({
    user: accepted ? best.name : "DESCONOCIDO",
    mode: "1:N",
    distance: bestDist,
    result: accepted ? "ACEPTADO" : "RECHAZADO",
  });
  setVaultState(accepted);
}

/* ---------------- result panel + vault ---------------- */

function setResult(kind, text, { distance, threshold: t } = {}) {
  const statusEl = document.getElementById("result-status");
  const metaEl = document.getElementById("result-meta");
  statusEl.className = "result__status" + (kind === "accept" ? " is-accept" : kind === "reject" ? " is-reject" : "");
  statusEl.textContent = text;
  metaEl.innerHTML = "";
  if (typeof distance === "number") {
    metaEl.innerHTML = `<span>distancia: ${distance.toFixed(3)}</span><span>umbral: ${t.toFixed(2)}</span>`;
  }
}

function setVaultState(unlocked) {
  const badge = document.getElementById("vault-badge");
  badge.textContent = unlocked ? "DESBLOQUEADO" : "BLOQUEADO";
  badge.classList.toggle("is-open", unlocked);
  document.querySelectorAll(".file").forEach((f) => {
    f.classList.toggle("is-unlocked", unlocked);
    f.querySelector(".file__icon").textContent = unlocked ? "📄" : "🔒";
  });
  if (!unlocked) return;
  clearTimeout(window.__vaultTimer);
  window.__vaultTimer = setTimeout(() => {
    badge.textContent = "BLOQUEADO";
    badge.classList.remove("is-open");
    document.querySelectorAll(".file").forEach((f) => {
      f.classList.remove("is-unlocked");
      f.querySelector(".file__icon").textContent = "🔒";
    });
  }, 12000);
}

/* ---------------- audit log ---------------- */

function renderLog() {
  const body = document.getElementById("audit-body");
  const log = getLog();
  if (!log.length) {
    body.innerHTML = `<tr class="audit__empty"><td colspan="6">Aún no hay eventos registrados.</td></tr>`;
    return;
  }
  body.innerHTML = log
    .map(
      (e) => `<tr>
        <td>${e.timestamp}</td>
        <td>${e.user}</td>
        <td>${e.mode}</td>
        <td>${e.distance}</td>
        <td>${e.threshold}</td>
        <td class="${e.result === "ACEPTADO" ? "is-accept" : "is-reject"}">${e.result}</td>
      </tr>`
    )
    .join("");
}

function exportCsv() {
  const log = getLog();
  const header = "timestamp,user,mode,distance,threshold,result\n";
  const rows = log
    .map((e) => [e.timestamp, e.user, e.mode, e.distance, e.threshold, e.result].join(","))
    .join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "access_log.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function clearData() {
  if (!confirm("Esto borrará todos los usuarios registrados y el registro de auditoría en este navegador. ¿Continuar?")) return;
  localStorage.removeItem(USERS_KEY);
  localStorage.removeItem(LOG_KEY);
  refreshUserSelect();
  renderLog();
  setVaultState(false);
  setResult("idle", "Datos borrados.", {});
}

/* ---------------- init ---------------- */

function init() {
  renderPipeline();
  renderDialTicks();
  setupTabs();
  refreshUserSelect();
  renderLog();
  loadModels();

  document.getElementById("btn-camera").addEventListener("click", toggleCamera);
  document.getElementById("btn-register").addEventListener("click", handleRegisterSample);
  document.getElementById("btn-save-user").addEventListener("click", handleSaveUser);
  document.getElementById("btn-verify").addEventListener("click", handleVerify);
  document.getElementById("btn-identify").addEventListener("click", handleIdentify);
  document.getElementById("btn-export").addEventListener("click", exportCsv);
  document.getElementById("btn-clear").addEventListener("click", clearData);

  const slider = document.getElementById("threshold");
  const thresholdValue = document.getElementById("threshold-value");
  slider.addEventListener("input", () => {
    threshold = parseFloat(slider.value);
    thresholdValue.textContent = threshold.toFixed(2);
  });
}

document.addEventListener("DOMContentLoaded", init);

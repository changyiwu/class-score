/**
 * 幸運抽籤
 * 移植自 class-tools-2 的「幸運大抽籤」：轉盤／拉霸／翻牌三種模式、一次抽 N 位、不重複抽。
 * 名單改接目前開啟的班級，抽出後可直接替中籤座號加分——走 app.js 的 changeScore，
 * 與學生卡片上的 ＋ 是同一條路（樂觀更新、寫入 _Log、失敗自動復原）。
 *
 * 抽籤名單（已抽出的座號）、紀錄與設定存在 localStorage，重新整理、登出後都還在。
 * ⚠️ localStorage 只存座號與時間戳，絕不存姓名：教室大螢幕是任何人都走得到的裝置，
 * 姓名一律在登入後由 state.students 即時組字。登出只清記憶體快取與畫面，不刪 localStorage。
 */

// 多位中籤時，指針每掃一格的動畫與停留時間（沿用 class-tools-2 的節奏）
const RAFFLE_SWEEP_STEP_MS = 320;
const RAFFLE_SWEEP_HOLD_MS = 420;
const RAFFLE_SLOT_SPIN_MS = 4000;
const RAFFLE_SLOT_ITEM_PX = 120;   // 必須與 .raffle-slot-item 的高度一致
const RAFFLE_WHEEL_SIZE = 400;     // 轉盤的邏輯尺寸；canvas 以兩倍解析度繪製，大螢幕上字才不糊
const RAFFLE_HISTORY_LIMIT = 100;   // 每個班級保留的紀錄筆數
const RAFFLE_MODES = ["wheel", "slot", "cards"];
const RAFFLE_STORAGE_KEY = "class_score_raffle_v1";

// 中籤後加分鈕一次加幾分（後端單次上限 ±10）
const RAFFLE_BONUS_POINTS = 1;

// 抽籤音效：不想要就改成 false
const RAFFLE_SOUND_ENABLED = true;
const RAFFLE_TICK_MIN_GAP_MS = 35; // 轉盤高速時每一幀都可能跨格，不節流會疊成一片雜音

// 中籤慶祝的星星配色，沿用加分動畫的 PRAISE_TINTS 再多一個紫色
const RAFFLE_BURST_TINTS = PRAISE_TINTS.concat(["#a78bfa"]);
const RAFFLE_BURST_COUNT = 24;

const raffle = {
    mode: "wheel",
    drawCount: 1,
    exclude: false,
    // 班級名稱 -> { drawn: [已抽出的座號], history: [{ seat, at }] }。
    // 用無原型物件：班級可以叫 constructor，普通物件會取到原型上的函式
    byClass: Object.create(null),
    className: null,    // 目前視窗對應的班級
    pool: [],           // 這一輪還抽得到的座號
    isDrawing: false,   // 動畫進行中或中籤畫面還開著，此時鎖住所有控制項
    winners: [],        // { index, seat, awarded, card }
    pendingPicks: [],   // 神秘翻牌已翻開、尚未湊滿人數的卡牌 { index, seat }
    wheelAngle: 0,
    wheelSlices: [],    // 轉盤格子對應的 pool 索引（亂數排列）
    wheelColors: [],
    sweepPicked: [],    // 指針已掃到的格子位置，畫面上高亮用
    epoch: 0,           // 關閉視窗或登出就 +1，作廢還在排隊的動畫與計時器
    frame: null,
    timers: new Set()
};

let raffleTickLastAt = 0;

document.addEventListener("DOMContentLoaded", setupRaffleListeners);

function setupRaffleListeners() {
    const openBtn = document.getElementById("btn-raffle");
    if (!openBtn) return;
    openBtn.addEventListener("click", openRaffle);

    document.querySelectorAll("[data-raffle-mode]").forEach(btn => {
        btn.addEventListener("click", () => setRaffleMode(btn.dataset.raffleMode));
    });

    const countInput = document.getElementById("raffle-draw-count");
    countInput.addEventListener("change", () => {
        raffle.drawCount = clampRaffleDrawCount(countInput.value);
        countInput.value = raffle.drawCount;
        resetRaffleCardPicks();
        updateRaffleHint();
        saveRaffleStore();
    });

    document.getElementById("raffle-exclude").addEventListener("change", (e) => {
        raffle.exclude = e.target.checked;
        saveRaffleStore();
    });

    document.getElementById("btn-raffle-start").addEventListener("click", startRaffleDraw);
    document.getElementById("btn-raffle-reset").addEventListener("click", resetRafflePool);
    document.getElementById("btn-raffle-clear-history").addEventListener("click", clearRaffleHistory);
    document.getElementById("btn-raffle-done").addEventListener("click", closeRaffleWinner);
    document.getElementById("btn-raffle-bonus-all").addEventListener("click", () => {
        awardRaffleBonus(raffle.winners.map(w => w.seat));
    });
    document.getElementById("raffle-bonus-all-text").textContent = `全部加 ${RAFFLE_BONUS_POINTS} 分`;
}

// ==================== 小工具 ==================== */

// 排程都經過這兩個函式，關閉視窗時 epoch 一變，舊的回呼就不會再動到畫面
function raffleLater(fn, ms) {
    const epoch = raffle.epoch;
    const id = setTimeout(() => {
        raffle.timers.delete(id);
        if (epoch === raffle.epoch) fn();
    }, ms);
    raffle.timers.add(id);
}

function raffleFrame(fn) {
    const epoch = raffle.epoch;
    raffle.frame = requestAnimationFrame(ts => {
        if (epoch === raffle.epoch) fn(ts);
    });
}

function isRaffleReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function raffleCssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function shuffleRaffle(items) {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function raffleStudent(seat) {
    return state.students.find(s => s.seat === seat) || null;
}

// 姓名維持預設的「學生N」時只顯示座號，與學生卡片的規則一致
function raffleHasCustomName(student) {
    return !!student && !!student.name && student.name !== `學生${student.seat}`;
}

// 轉盤、拉霸、紀錄用的單行文字。姓名來自試算表，一律以 textContent／fillText 輸出
function raffleLabel(seat) {
    const student = raffleStudent(seat);
    return raffleHasCustomName(student) ? `${seat} ${student.name}` : `${seat} 號`;
}

function raffleEntry() {
    return raffle.byClass[raffle.className] || null;
}

// 紀錄會跨天保留：今天的只顯示時間，其他天的加上日期
function raffleTimeLabel(at) {
    const d = new Date(at);
    const pad = n => String(n).padStart(2, "0");
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === new Date().toDateString()
        ? `${time}:${pad(d.getSeconds())}`
        : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

// ==================== localStorage ==================== */

const isRaffleSeat = seat => typeof seat === "number" || (typeof seat === "string" && seat !== "");

// 每次開視窗都從 localStorage 重讀，壞掉或被瀏覽器封鎖就當作沒有紀錄，不影響抽籤本身
function loadRaffleStore() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(RAFFLE_STORAGE_KEY) || "null");
    } catch (e) {
        saved = null;
    }
    const data = saved && typeof saved === "object" ? saved : {};

    raffle.mode = RAFFLE_MODES.indexOf(data.mode) !== -1 ? data.mode : "wheel";
    raffle.drawCount = parseInt(data.drawCount, 10) || 1;
    raffle.exclude = data.exclude === true;
    raffle.byClass = Object.create(null);

    const classes = data.classes && typeof data.classes === "object" ? data.classes : {};
    Object.keys(classes).forEach(className => {
        const item = classes[className];
        if (!item || typeof item !== "object") return;
        raffle.byClass[className] = {
            drawn: Array.isArray(item.drawn) ? item.drawn.filter(isRaffleSeat) : [],
            history: Array.isArray(item.history)
                ? item.history
                    .filter(h => h && isRaffleSeat(h.seat) && Number.isFinite(h.at))
                    .map(h => ({ seat: h.seat, at: h.at }))
                    .slice(0, RAFFLE_HISTORY_LIMIT)
                : []
        };
    });
}

// 只寫座號與時間戳。姓名是個資，不可以寫進來（見檔案開頭說明）
function saveRaffleStore() {
    const classes = {};
    Object.keys(raffle.byClass).forEach(className => {
        const entry = raffle.byClass[className];
        classes[className] = {
            drawn: entry.drawn.slice(),
            history: entry.history.map(h => ({ seat: h.seat, at: h.at }))
        };
    });

    try {
        localStorage.setItem(RAFFLE_STORAGE_KEY, JSON.stringify({
            mode: raffle.mode,
            drawCount: raffle.drawCount,
            exclude: raffle.exclude,
            classes
        }));
    } catch (e) {
        // 空間已滿或被封鎖：這一次登入內仍照常運作，只是不會留到下次
    }
}

// ==================== 開啟與狀態 ==================== */

function openRaffle() {
    closeHeaderMenu();

    const className = state.currentClass;
    if (!className || className === "__new__") {
        showToast("請先切換到要抽籤的班級", "error");
        return;
    }
    if (state.studentsClass !== className) {
        showToast("班級資料載入中，請稍候再試", "error");
        return;
    }
    if (state.students.length === 0) {
        showToast("此班級沒有學生資料，無法抽籤", "error");
        return;
    }

    loadRaffleStore();
    syncRaffleClass(className);
    document.getElementById("raffle-class-name").textContent = className;
    openModal("modal-raffle");

    applyRaffleMode();
    renderRaffleHistory();
    renderRafflePoolStatus();
    renderRaffleArena();
    updateRaffleHint();
}

// 每次開視窗都依「目前的學生名單」重算這一輪的 pool：
// 試算表刪掉的座號不會再被抽到，新增的座號自動加入
function syncRaffleClass(className) {
    let entry = raffle.byClass[className];
    if (!entry) {
        entry = raffle.byClass[className] = { drawn: [], history: [] };
    }
    const drawn = new Set(entry.drawn);

    raffle.className = className;
    raffle.pool = state.students.map(s => s.seat).filter(seat => !drawn.has(seat));
    raffle.winners = [];
    raffle.pendingPicks = [];
    rebuildRaffleWheel();
    updateRaffleDrawCountLimit();
}

function applyRaffleMode() {
    document.querySelectorAll("[data-raffle-mode]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.raffleMode === raffle.mode);
    });
    document.getElementById("raffle-arena-wheel").classList.toggle("hidden", raffle.mode !== "wheel");
    document.getElementById("raffle-arena-slot").classList.toggle("hidden", raffle.mode !== "slot");
    document.getElementById("raffle-arena-cards").classList.toggle("hidden", raffle.mode !== "cards");
    document.getElementById("raffle-exclude").checked = raffle.exclude;
}

function setRaffleMode(mode) {
    if (raffle.isDrawing || RAFFLE_MODES.indexOf(mode) === -1) return;
    raffle.mode = mode;
    raffle.pendingPicks = [];
    applyRaffleMode();
    renderRaffleArena();
    updateRaffleHint();
    saveRaffleStore();
}

// 抽籤中（含中籤畫面還開著）鎖住會改變名單或模式的控制項
function setRaffleDrawing(on) {
    raffle.isDrawing = on;
    ["btn-raffle-start", "btn-raffle-reset", "raffle-draw-count"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = on;
    });
    document.querySelectorAll("[data-raffle-mode]").forEach(btn => { btn.disabled = on; });
}

function clampRaffleDrawCount(value) {
    const max = Math.max(1, raffle.pool.length);
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(Math.max(parsed, 1), max);
}

function updateRaffleDrawCountLimit() {
    const input = document.getElementById("raffle-draw-count");
    raffle.drawCount = clampRaffleDrawCount(raffle.drawCount);
    if (!input) return;
    input.max = Math.max(1, raffle.pool.length);
    input.value = raffle.drawCount;
}

function getRaffleDrawCount() {
    const input = document.getElementById("raffle-draw-count");
    raffle.drawCount = clampRaffleDrawCount(input ? input.value : raffle.drawCount);
    if (input) input.value = raffle.drawCount;
    return raffle.drawCount;
}

function resetRaffleCardPicks() {
    raffle.pendingPicks = [];
    document.querySelectorAll("#raffle-arena-cards .raffle-flip-card.flipped").forEach(card => {
        card.classList.remove("flipped");
    });
}

function updateRaffleHint() {
    const hint = document.getElementById("raffle-hint");
    if (!hint) return;

    let text = "";
    if (raffle.className && raffle.pool.length === 0) {
        text = "這一輪已經全部抽完了，按「重置名單」再抽一輪";
    } else if (raffle.mode === "cards" && raffle.pool.length > 0) {
        const target = raffle.drawCount;
        text = target > 1
            ? `神秘翻牌：請翻開 ${target} 張卡牌（還需 ${Math.max(0, target - raffle.pendingPicks.length)} 張）`
            : "神秘翻牌：點任一張問號卡牌，翻開中籤者";
    }

    hint.textContent = text;
    hint.classList.toggle("hidden", !text);
}

function renderRafflePoolStatus() {
    const el = document.getElementById("raffle-pool-status");
    if (!el) return;
    el.textContent = raffle.className
        ? `這一輪還剩 ${raffle.pool.length} / ${state.students.length} 人`
        : "";
}

function renderRaffleHistory() {
    const container = document.getElementById("raffle-history");
    if (!container) return;
    container.replaceChildren();

    const entry = raffleEntry();
    if (!entry || entry.history.length === 0) {
        const empty = document.createElement("div");
        empty.className = "raffle-history-empty";
        empty.textContent = "尚無抽籤紀錄";
        container.appendChild(empty);
        return;
    }

    entry.history.forEach(item => {
        const row = document.createElement("div");
        row.className = "raffle-history-item";
        const name = document.createElement("span");
        name.className = "raffle-history-name";
        name.textContent = raffleLabel(item.seat); // 姓名不在 localStorage，顯示時才組字
        const time = document.createElement("span");
        time.className = "raffle-history-time";
        time.textContent = raffleTimeLabel(item.at);
        row.append(name, time);
        container.appendChild(row);
    });
}

function clearRaffleHistory() {
    const entry = raffleEntry();
    if (!entry) return;
    entry.history = [];
    renderRaffleHistory();
    saveRaffleStore();
}

function resetRafflePool() {
    if (raffle.isDrawing || !raffle.className) return;
    const entry = raffleEntry();
    if (entry) entry.drawn = [];

    raffle.pool = state.students.map(s => s.seat);
    raffle.pendingPicks = [];
    rebuildRaffleWheel();
    updateRaffleDrawCountLimit();
    renderRaffleArena();
    renderRafflePoolStatus();
    updateRaffleHint();
    saveRaffleStore();
    showToast("抽籤名單已重置", "success");
}

// ==================== 1. 幸運大轉盤 ==================== */

function rebuildRaffleWheel() {
    // 轉盤上的排列用亂數打散，指針連續掃過的格子才等同於隨機取樣
    raffle.wheelSlices = shuffleRaffle(raffle.pool.map((_, index) => index));
    raffle.sweepPicked = [];
    raffle.wheelColors = raffle.wheelSlices.map((_, index) => {
        const hue = (index * (360 / Math.max(1, raffle.wheelSlices.length))) % 360;
        return `hsl(${hue}, 75%, 60%)`;
    });
}

function getRaffleWheelContext() {
    const canvas = document.getElementById("raffle-wheel-canvas");
    const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
    if (!ctx) return null;
    const k = canvas.width / RAFFLE_WHEEL_SIZE;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    return ctx;
}

function drawRaffleWheel() {
    const ctx = getRaffleWheelContext();
    if (!ctx) return;

    const size = RAFFLE_WHEEL_SIZE;
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 15;
    const accent = raffleCssVar("--accent-blue", "#06b6d4");
    const textMain = raffleCssVar("--text-primary", "#f8fafc");
    const font = "'Outfit', 'Noto Sans TC', sans-serif";

    ctx.clearRect(0, 0, size, size);

    if (raffle.wheelSlices.length !== raffle.pool.length) rebuildRaffleWheel();
    const len = raffle.wheelSlices.length;

    if (len === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = raffleCssVar("--text-secondary", "#94a3b8");
        ctx.font = `18px ${font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("這一輪已全部抽完", cx, cy);
        return;
    }

    const arcSize = (Math.PI * 2) / len;
    const fontSize = len <= 16 ? 17 : (len <= 30 ? 14 : 12);
    const sweeping = raffle.sweepPicked.length > 0;

    for (let i = 0; i < len; i++) {
        const angle = raffle.wheelAngle + i * arcSize;
        const picked = raffle.sweepPicked.indexOf(i) !== -1;

        // 掃描中未中的格子淡出，讓已掃到的中籤格子跳出來
        ctx.globalAlpha = sweeping && !picked ? 0.3 : 1;
        ctx.fillStyle = raffle.wheelColors[i % raffle.wheelColors.length];
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, angle, angle + arcSize);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = picked ? accent : "rgba(18, 22, 33, 0.4)";
        ctx.lineWidth = picked ? 4 : 1.5;
        ctx.stroke();

        ctx.save();
        ctx.fillStyle = "#121621"; // 亮色格子上用深色字
        ctx.font = `bold ${fontSize}px ${font}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.translate(cx, cy);
        ctx.rotate(angle + arcSize / 2);
        // 第四個參數是最大寬度：長姓名會被壓扁而不是蓋到中心圓
        ctx.fillText(raffleLabel(raffle.pool[raffle.wheelSlices[i]]), radius - 22, 0, radius - 70);
        ctx.restore();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#1a1f2c";
    ctx.beginPath();
    ctx.arc(cx, cy, 35, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = textMain;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fill();
}

function clearRaffleWheel() {
    const ctx = getRaffleWheelContext();
    if (ctx) ctx.clearRect(0, 0, RAFFLE_WHEEL_SIZE, RAFFLE_WHEEL_SIZE);
}

function spinRaffleWheel() {
    raffle.winners = [];
    raffle.sweepPicked = [];

    // 減少動態效果：直接停在隨機角度，不轉
    if (isRaffleReducedMotion()) {
        raffle.wheelAngle += Math.random() * Math.PI * 2;
        drawRaffleWheel();
        sweepRaffleWheelWinners();
        return;
    }

    let speed = Math.random() * 0.3 + 0.4; // 每幀轉幾弧度
    const friction = 0.985;
    const sliceAngle = (Math.PI * 2) / raffle.pool.length;
    let lastAngle = raffle.wheelAngle;

    function anim() {
        raffle.wheelAngle += speed;
        speed *= friction;

        if (Math.floor(raffle.wheelAngle / sliceAngle) !== Math.floor(lastAngle / sliceAngle)) {
            playRaffleSound("tick");
        }
        lastAngle = raffle.wheelAngle;
        drawRaffleWheel();

        if (speed > 0.0015) {
            raffleFrame(anim);
        } else {
            sweepRaffleWheelWinners();
        }
    }

    anim();
}

function getRafflePointerSlice() {
    const len = raffle.wheelSlices.length;
    if (len === 0) return -1;
    const arcSize = (Math.PI * 2) / len;
    // 轉盤順時針轉，指針在正上方（-π/2）
    let normalized = (-raffle.wheelAngle - Math.PI / 2) % (Math.PI * 2);
    if (normalized < 0) normalized += Math.PI * 2;
    return Math.floor(normalized / arcSize) % len;
}

// 轉盤停下後，指針每再掃過一格就多算一位中籤者，每位停留一下下。
// 不要退回「動畫抽一位、其餘隨機補齊」——老師看得出來後面幾位不是抽出來的
function sweepRaffleWheelWinners() {
    const len = raffle.wheelSlices.length;
    const startSlice = getRafflePointerSlice();
    if (len === 0 || startSlice < 0) {
        setRaffleDrawing(false);
        return;
    }

    const target = Math.min(getRaffleDrawCount(), len);
    const arcSize = (Math.PI * 2) / len;
    const reduced = isRaffleReducedMotion();
    const picks = [];
    raffle.sweepPicked = [];

    // 轉盤持續往前轉時，指針落到的格子位置會往回一格
    const revealAt = (order) => {
        const slicePos = (startSlice - order + len) % len;
        const poolIndex = raffle.wheelSlices[slicePos];
        raffle.sweepPicked.push(slicePos);
        picks.push({ index: poolIndex, seat: raffle.pool[poolIndex] });
        drawRaffleWheel();
        playRaffleSound("tick");
    };

    const advance = (order) => {
        if (order >= target) {
            finishRaffleDraw(picks);
            return;
        }

        const from = raffle.wheelAngle;
        if (reduced) {
            raffle.wheelAngle = from + arcSize;
            revealAt(order);
            raffleLater(() => advance(order + 1), RAFFLE_SWEEP_HOLD_MS);
            return;
        }

        const start = performance.now();
        function step(timestamp) {
            const t = Math.min((timestamp - start) / RAFFLE_SWEEP_STEP_MS, 1);
            raffle.wheelAngle = from + arcSize * (1 - Math.pow(1 - t, 3));
            drawRaffleWheel();
            if (t < 1) {
                raffleFrame(step);
                return;
            }
            raffle.wheelAngle = from + arcSize;
            revealAt(order);
            raffleLater(() => advance(order + 1), RAFFLE_SWEEP_HOLD_MS);
        }
        raffleFrame(step);
    };

    revealAt(0);
    raffleLater(() => advance(1), RAFFLE_SWEEP_HOLD_MS);
}

// ==================== 2. 滾動拉霸機 ==================== */

function setupRaffleSlot() {
    const reel = document.getElementById("raffle-slot-reel");
    reel.replaceChildren();
    reel.style.transform = "translateY(0px)";

    const item = document.createElement("div");
    item.className = "raffle-slot-item";
    item.textContent = raffle.pool.length === 0 ? "已抽完" : "❓";
    reel.appendChild(item);
}

function spinRaffleSlot() {
    const reel = document.getElementById("raffle-slot-reel");
    const pool = raffle.pool;
    const len = pool.length;
    raffle.winners = [];

    // 中籤者用亂數挑，排在滾動條最後面，讓拉霸依序停在每一位身上
    const target = Math.min(getRaffleDrawCount(), len);
    const picks = shuffleRaffle(pool.map((seat, index) => ({ index, seat }))).slice(0, target);

    const spins = 30 + Math.floor(Math.random() * 20) + target;
    const filler = shuffleRaffle(pool);
    const labels = [];
    for (let i = 0; i < spins - target; i++) labels.push(raffleLabel(filler[i % len]));
    picks.forEach(pick => labels.push(raffleLabel(pick.seat)));

    reel.replaceChildren();
    labels.forEach(label => {
        const el = document.createElement("div");
        el.className = "raffle-slot-item";
        el.textContent = label;
        reel.appendChild(el);
    });

    const offsetOf = (order) => -(spins - target + order) * RAFFLE_SLOT_ITEM_PX;
    const reduced = isRaffleReducedMotion();

    function holdWinner(order) {
        playRaffleSound("tick");
        if (order >= target - 1) {
            raffleLater(() => finishRaffleDraw(picks), RAFFLE_SWEEP_HOLD_MS);
            return;
        }
        raffleLater(() => slideToWinner(order + 1), RAFFLE_SWEEP_HOLD_MS);
    }

    function slideToWinner(order) {
        const from = offsetOf(order - 1);
        const to = offsetOf(order);
        if (reduced) {
            reel.style.transform = `translateY(${to}px)`;
            holdWinner(order);
            return;
        }
        const start = performance.now();
        function slide(timestamp) {
            const t = Math.min((timestamp - start) / RAFFLE_SWEEP_STEP_MS, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            reel.style.transform = `translateY(${from + (to - from) * eased}px)`;
            if (t < 1) {
                raffleFrame(slide);
                return;
            }
            reel.style.transform = `translateY(${to}px)`;
            holdWinner(order);
        }
        raffleFrame(slide);
    }

    const targetY = offsetOf(0);
    if (reduced) {
        reel.style.transform = `translateY(${targetY}px)`;
        holdWinner(0);
        return;
    }

    const start = performance.now();
    let lastItemIndex = 0;
    function step(timestamp) {
        const t = Math.min((timestamp - start) / RAFFLE_SLOT_SPIN_MS, 1);
        const currentY = targetY * (1 - Math.pow(1 - t, 3.5));
        reel.style.transform = `translateY(${currentY}px)`;

        const itemIndex = Math.floor(-currentY / RAFFLE_SLOT_ITEM_PX);
        if (itemIndex !== lastItemIndex) {
            playRaffleSound("tick");
            lastItemIndex = itemIndex;
        }

        if (t < 1) {
            raffleFrame(step);
        } else {
            reel.style.transform = `translateY(${targetY}px)`;
            holdWinner(0);
        }
    }
    raffleFrame(step);
}

// ==================== 3. 神秘翻牌 ==================== */

function setupRaffleCards() {
    const container = document.getElementById("raffle-arena-cards");
    container.replaceChildren();

    if (raffle.pool.length === 0) {
        const empty = document.createElement("p");
        empty.className = "raffle-empty";
        empty.textContent = "這一輪已全部抽完";
        container.appendChild(empty);
        return;
    }

    raffle.pool.forEach((seat, index) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "raffle-flip-card";
        card.setAttribute("aria-label", `翻開第 ${index + 1} 張神秘卡牌`);

        const inner = document.createElement("span");
        inner.className = "raffle-flip-inner";

        const front = document.createElement("span");
        front.className = "raffle-flip-front";
        front.innerHTML = `<i class="fa-solid fa-question" aria-hidden="true"></i>`;

        const back = document.createElement("span");
        back.className = "raffle-flip-back";
        const seatEl = document.createElement("span");
        seatEl.className = "raffle-flip-seat";
        seatEl.textContent = `${seat} 號`;
        back.appendChild(seatEl);
        const student = raffleStudent(seat);
        if (raffleHasCustomName(student)) {
            const nameEl = document.createElement("span");
            nameEl.className = "raffle-flip-name";
            nameEl.textContent = student.name;
            back.appendChild(nameEl);
        }

        inner.append(front, back);
        card.appendChild(inner);
        card.addEventListener("click", () => selectRaffleCard(card, index, seat));
        container.appendChild(card);
    });
}

function selectRaffleCard(card, index, seat) {
    if (raffle.isDrawing || card.classList.contains("flipped")) return;
    primeRaffleAudio();

    const target = getRaffleDrawCount();
    card.classList.add("flipped");
    raffle.pendingPicks.push({ index, seat });

    // 還沒翻滿指定人數，繼續等下一張
    if (raffle.pendingPicks.length < target) {
        playRaffleSound("tick");
        updateRaffleHint();
        return;
    }

    setRaffleDrawing(true);
    const picks = raffle.pendingPicks.slice();
    updateRaffleHint();
    raffleLater(() => finishRaffleDraw(picks), 700);
}

function shuffleRaffleCards() {
    setupRaffleCards();
    raffle.pendingPicks = [];
    updateRaffleHint();

    const cards = document.querySelectorAll("#raffle-arena-cards .raffle-flip-card");
    if (cards.length === 0) {
        setRaffleDrawing(false);
        return;
    }

    playRaffleSound("tick");
    if (!isRaffleReducedMotion()) {
        cards.forEach(card => {
            card.style.transition = "transform 0.15s ease";
            card.style.transform = `scale(0.9) translate(${Math.random() * 20 - 10}px, ${Math.random() * 20 - 10}px)`;
        });
    }

    raffleLater(() => {
        cards.forEach(card => {
            card.style.transition = "transform 0.5s cubic-bezier(0.18, 0.89, 0.32, 1.28)";
            card.style.transform = "";
        });
        setRaffleDrawing(false);
        const target = raffle.drawCount;
        showToast(target > 1 ? `洗牌完成！請點任意 ${target} 張卡牌` : "洗牌完成！請點任意一張卡牌", "info");
    }, 400);
}

// ==================== 抽籤主流程 ==================== */

function renderRaffleArena() {
    if (raffle.mode === "wheel") drawRaffleWheel();
    else if (raffle.mode === "slot") setupRaffleSlot();
    else if (raffle.mode === "cards") setupRaffleCards();
}

function startRaffleDraw() {
    if (raffle.isDrawing) return;
    if (raffle.pool.length === 0) {
        showToast("這一輪已經全部抽完了，請按「重置名單」", "error");
        return;
    }

    primeRaffleAudio();
    setRaffleDrawing(true);

    if (raffle.mode === "wheel") spinRaffleWheel();
    else if (raffle.mode === "slot") spinRaffleSlot();
    else shuffleRaffleCards(); // 翻牌模式由老師點卡牌抽，這顆按鈕只負責洗牌
}

// 動畫抽出的中籤者為主；人數不足時（理論上不會發生）才從剩下的名單補齊，同一次不重複
function collectRaffleWinners(picks) {
    const target = getRaffleDrawCount();
    const winners = [];
    const used = new Set();

    const add = (entry) => {
        if (!entry || used.has(entry.index)) return;
        used.add(entry.index);
        winners.push({ index: entry.index, seat: entry.seat });
    };

    (picks || []).forEach(add);

    const candidates = raffle.pool
        .map((seat, index) => ({ index, seat }))
        .filter(item => !used.has(item.index));
    while (winners.length < target && candidates.length > 0) {
        add(candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0]);
    }
    return winners;
}

function finishRaffleDraw(picks) {
    const winners = collectRaffleWinners(picks);
    if (winners.length === 0) {
        raffle.pendingPicks = [];
        setRaffleDrawing(false);
        return;
    }

    playRaffleSound("win");
    raffle.winners = winners.map(w => ({ index: w.index, seat: w.seat, awarded: 0, card: null }));
    showRaffleWinner();

    // 紀錄：先抽到的排在最上面
    const entry = raffleEntry();
    if (entry) {
        const at = Date.now();
        winners.slice().reverse().forEach(w => {
            entry.history.unshift({ seat: w.seat, at });
        });
        entry.history.length = Math.min(entry.history.length, RAFFLE_HISTORY_LIMIT);
        renderRaffleHistory();
    }

    // 不重複抽：由大到小刪除，避免索引位移
    if (raffle.exclude) {
        winners.map(w => w.index).sort((a, b) => b - a).forEach(index => {
            raffle.pool.splice(index, 1);
        });
        if (entry) winners.forEach(w => entry.drawn.push(w.seat));
        rebuildRaffleWheel();
        updateRaffleDrawCountLimit();
        renderRafflePoolStatus();
    }

    saveRaffleStore();
    raffle.pendingPicks = [];
    // isDrawing 維持 true，等老師按「完成」關掉中籤畫面才解鎖
}

// ==================== 中籤畫面與加分 ==================== */

function showRaffleWinner() {
    const winners = raffle.winners;
    const overlay = document.getElementById("raffle-winner");
    const list = document.getElementById("raffle-winner-list");

    document.getElementById("raffle-winner-title").textContent = winners.length > 1
        ? `🎉 恭喜 ${winners.length} 位中籤者 🎉`
        : "🎉 恭喜中籤者 🎉";

    list.replaceChildren();
    list.classList.toggle("is-multi", winners.length > 1);
    winners.forEach(winner => list.appendChild(renderRaffleWinnerCard(winner)));

    document.getElementById("btn-raffle-bonus-all").classList.toggle("hidden", winners.length < 2);
    overlay.classList.remove("hidden");
    overlay.scrollTop = 0;
    playRaffleBurst(overlay);
}

function renderRaffleWinnerCard(winner) {
    const student = raffleStudent(winner.seat);
    const card = document.createElement("div");
    card.className = "raffle-winner-card";

    const seatEl = document.createElement("div");
    seatEl.className = "raffle-winner-seat";
    seatEl.textContent = `${winner.seat} 號`;
    card.appendChild(seatEl);

    if (raffleHasCustomName(student)) {
        const nameEl = document.createElement("div");
        nameEl.className = "raffle-winner-name";
        nameEl.textContent = student.name;
        card.appendChild(nameEl);
    }

    const scoreEl = document.createElement("div");
    scoreEl.className = "raffle-winner-score";
    card.appendChild(scoreEl);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "raffle-bonus-btn";
    btn.innerHTML = `<i class="fa-solid fa-plus"></i> <span></span>`;
    btn.querySelector("span").textContent = `加 ${RAFFLE_BONUS_POINTS} 分`;
    btn.addEventListener("click", () => awardRaffleBonus([winner.seat]));
    card.appendChild(btn);

    winner.card = card;
    updateRaffleWinnerScore(winner);
    return card;
}

// 顯示目前分數；按過加分鈕就多標「已加 N」，免得老師不確定剛才點到了沒
function updateRaffleWinnerScore(winner) {
    if (!winner.card) return;
    const scoreEl = winner.card.querySelector(".raffle-winner-score");
    const student = raffleStudent(winner.seat);
    scoreEl.replaceChildren();
    if (!student) return;

    const score = student.score;
    const value = document.createElement("span");
    value.className = "raffle-score-value";
    value.classList.toggle("positive", score > 0);
    value.classList.toggle("negative", score < 0);
    value.textContent = `目前 ${score > 0 ? `+${score}` : score} 分`;
    scoreEl.appendChild(value);

    if (winner.awarded > 0) {
        const tag = document.createElement("span");
        tag.className = "raffle-awarded-tag";
        tag.textContent = `已加 ${winner.awarded}`;
        scoreEl.appendChild(tag);
    }
}

function awardRaffleBonus(seats) {
    // 視窗蓋住了分頁列，正常情況班級不會變；仍擋一下，免得把分加到別班同座號
    if (raffle.className !== state.currentClass || state.studentsClass !== raffle.className) {
        showToast("班級已切換，請重新抽籤", "error");
        return;
    }

    seats.forEach(seat => {
        const winner = raffle.winners.find(w => w.seat === seat);
        if (!winner || !raffleStudent(seat)) return;

        // changeScore 會先樂觀更新 state.students，所以呼叫完馬上就能顯示新分數
        winner.awarded += RAFFLE_BONUS_POINTS;
        const request = changeScore(seat, RAFFLE_BONUS_POINTS);
        updateRaffleWinnerScore(winner);
        popRaffleWinnerCard(winner.card);

        request.then(ok => {
            if (!ok) winner.awarded -= RAFFLE_BONUS_POINTS;
            if (winner.card && winner.card.isConnected) updateRaffleWinnerScore(winner);
        });
    });
}

function popRaffleWinnerCard(card) {
    if (!card) return;
    card.classList.remove("raffle-bonus-pop");
    void card.offsetWidth; // 重設動畫，連點時才會重播
    card.classList.add("raffle-bonus-pop");
}

// 中籤慶祝：沿用加分動畫的星星樣式（.praise-star），射得更遠更大
function playRaffleBurst(overlay) {
    if (isRaffleReducedMotion()) return;

    const stars = Array.from({ length: RAFFLE_BURST_COUNT }, (_, i) => {
        const angle = i * (360 / RAFFLE_BURST_COUNT) + (i % 2 ? 7 : -4);
        const dist = 150 + (i % 4) * 50;
        const size = [1.1, 1.5, 1.9][i % 3];
        const spin = (i % 2 ? 1 : -1) * (200 + (i % 4) * 90);
        const tint = RAFFLE_BURST_TINTS[i % RAFFLE_BURST_TINTS.length];
        const dur = 1.0 + (i % 3) * 0.2;
        return `<i class="praise-star fa-solid fa-star" style="--angle:${angle}deg; --dist:${dist}px; --size:${size}rem; --spin:${spin}deg; --tint:${tint}; --dur:${dur}s"></i>`;
    }).join("");

    const burst = document.createElement("span");
    burst.className = "raffle-burst";
    burst.innerHTML = stars;
    overlay.appendChild(burst);
    raffleLater(() => burst.remove(), 1700);
}

function clearRaffleWinnerView() {
    const overlay = document.getElementById("raffle-winner");
    if (overlay) {
        overlay.classList.add("hidden");
        overlay.querySelectorAll(".raffle-burst").forEach(el => el.remove());
    }
    const list = document.getElementById("raffle-winner-list");
    if (list) list.replaceChildren();
    raffle.winners = [];
}

function closeRaffleWinner() {
    clearRaffleWinnerView();
    raffle.pendingPicks = [];
    raffle.sweepPicked = [];
    setRaffleDrawing(false);
    renderRaffleArena();
    updateRaffleHint();
}

// 關閉視窗（含 Esc、點背景、登出）時呼叫：停掉動畫與計時器，清掉畫面上的姓名
function abortRaffle() {
    raffle.epoch++;
    if (raffle.frame) cancelAnimationFrame(raffle.frame);
    raffle.frame = null;
    raffle.timers.forEach(id => clearTimeout(id));
    raffle.timers.clear();

    clearRaffleWinnerView();
    raffle.pendingPicks = [];
    raffle.sweepPicked = [];
    setRaffleDrawing(false);

    const reel = document.getElementById("raffle-slot-reel");
    if (reel) reel.replaceChildren();
    const cards = document.getElementById("raffle-arena-cards");
    if (cards) cards.replaceChildren();
}

// 登出時由 clearLocalSession 呼叫：丟掉記憶體快取與畫面上的姓名。
// localStorage 刻意保留（只有座號），下次開抽籤視窗時重讀
function clearRaffleState() {
    abortRaffle();
    raffle.byClass = Object.create(null);
    raffle.className = null;
    raffle.pool = [];
    raffle.wheelSlices = [];
    raffle.wheelColors = [];
    clearRaffleWheel();

    ["raffle-history", "raffle-pool-status", "raffle-class-name"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.replaceChildren();
    });
    updateRaffleHint();
}

// ==================== 音效 ==================== */

// 在點擊（使用者手勢）裡先喚醒 AudioContext，之後動畫中的 tick 才出得了聲
function primeRaffleAudio() {
    if (!RAFFLE_SOUND_ENABLED) return;
    const ctx = getPraiseAudioContext();
    if (ctx && ctx.state === "suspended") ctx.resume();
}

// 與加分音效共用同一個 AudioContext（app.js 的 getPraiseAudioContext）
function playRaffleSound(type) {
    if (!RAFFLE_SOUND_ENABLED) return;

    if (type === "tick") {
        const nowMs = performance.now();
        if (nowMs - raffleTickLastAt < RAFFLE_TICK_MIN_GAP_MS) return;
        raffleTickLastAt = nowMs;
    }

    const ctx = getPraiseAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const voice = (wave, gainValue, freqs, holdUntil, endAt) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = wave;
        freqs.forEach(([freq, at]) => osc.frequency.setValueAtTime(freq, now + at));
        gain.gain.setValueAtTime(gainValue, now);
        if (holdUntil) gain.gain.linearRampToValueAtTime(gainValue, now + holdUntil);
        gain.gain.exponentialRampToValueAtTime(0.01, now + endAt);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.onended = () => gain.disconnect(); // 播完就卸掉，避免節點無限累積
        osc.start(now);
        osc.stop(now + endAt);
    };

    if (type === "tick") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.05);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.onended = () => gain.disconnect();
        osc.start(now);
        osc.stop(now + 0.05);
    } else if (type === "win") {
        // C 大三和弦上行琶音，兩個八度疊在一起
        voice("triangle", 0.2, [[261.63, 0], [329.63, 0.1], [392.0, 0.2], [523.25, 0.3]], 0.4, 0.8);
        voice("sine", 0.1, [[523.25, 0], [659.25, 0.1], [783.99, 0.2], [1046.5, 0.3]], 0.4, 0.8);
    }
}

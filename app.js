/**
 * Class Score Web Application Frontend
 */

// backend Google Apps Script URL
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbwZeR2kvK84TiaiuedsCp0Q1DYw_oBk4tGhIBWeQBYeX3At5HxWqlRjPcQ_EfbsjM_qaA/exec";

// 不需附帶 session token 的動作（登入流程本身）
const NO_SESSION_ACTIONS = new Set(["login", "create_pairing", "check_pairing"]);

// 加分時隨機挑一句飄出的鼓勵詞（只在加分播放，扣分維持低調的 pulse）
const PRAISE_WORDS = ["讚！", "太棒了！", "好厲害！", "很好！", "繼續加油！", "做得好！", "超讚！"];

// 星星迸發的配色（綠／金／白／青，混色比單色更熱鬧）
const PRAISE_TINTS = ["#34d399", "#fbbf24", "#ffffff", "#22d3ee"];
const PRAISE_STAR_COUNT = 12;

// 加分音效：不想要就把這個改成 false（介面刻意不放開關，維持精簡）
const PRAISE_SOUND_ENABLED = true;
// 音符：[頻率, 起音延遲(秒), 衰減時長(秒), 相對音量]
// 低音 C5 當鈴身撐出厚度與長度，上方 C6-E6-G6-C7 依序疊成上行琶音。
// 越高的音相對音量越低，長衰減時才不會刺耳。總長約 1.25 秒，與鼓勵動畫等長
const PRAISE_CHIME_NOTES = [
    { freq: 523.25, delay: 0.00, decay: 1.35, gain: 0.55 },
    { freq: 1046.5, delay: 0.00, decay: 1.20, gain: 1.00 },
    { freq: 1318.5, delay: 0.11, decay: 1.20, gain: 0.90 },
    { freq: 1568.0, delay: 0.22, decay: 1.15, gain: 0.80 },
    { freq: 2093.0, delay: 0.33, decay: 1.05, gain: 0.65 }
];
const PRAISE_CHIME_VOLUME = 0.15;    // 保守音量，實際大小交給大螢幕的系統音量
const PRAISE_SOUND_MIN_GAP_MS = 120; // 連點時的最小間隔；音效變長後要拉寬，否則疊音會爆表

// 建立班級時的人數範圍（需與 index.html 的 min/max 及後端上限一致）
const MIN_STUDENT_COUNT = 5;
const MAX_STUDENT_COUNT = 50;
const DEFAULT_STUDENT_COUNT = 30;

// 課堂資訊圖表。圖檔與無障礙描述都不在本 repo：描述含教師個人資料，
// 一律隨圖從後端取回；key 必須與 GAS 的 INFOGRAPHIC_FILES 白名單一致。
const INFOGRAPHICS = {
    "teacher-profile": { title: "教師簡歷" },
    "teaching-flow": { title: "教學流程" },
    "grading": { title: "學期成績計算方法" },
    "conduct": { title: "課堂表現加減分" }
};

// 考卷檢討的檔案圖示，依 mimeType 與副檔名判斷
const EXAM_FILE_ICONS = [
    { test: /presentation|powerpoint|\.pptx?$/i, cls: "ppt", icon: "fa-file-powerpoint" },
    { test: /pdf/i,                              cls: "pdf", icon: "fa-file-pdf" },
    { test: /image\//i,                          cls: "img", icon: "fa-file-image" }
];

// 登入過去存在 localStorage 的兩個 key。現在 session 只放記憶體，
// 啟動時仍要清掉舊版殘留，否則大螢幕上會一直留著一組舊 token
const LEGACY_SESSION_KEYS = ["session_token", "session_expiry"];

// Global Application State
// ⚠️ session token 只存在記憶體，不進 localStorage／sessionStorage：
// 教室大螢幕是任何人都走得到的裝置，而考卷檢討的 Drive 網址一旦外流就收不回來。
// 重新整理或關掉分頁就等於登出，重新掃碼只要幾秒。
const state = {
    sessionToken: null,
    sessionExpiry: null,
    pairId: null,        // 登入配對通道 ID（公開，放在 QR Code 中）
    pollKey: null,       // 領取 session token 的憑證（僅存於大螢幕）
    mode: 'desktop', // 'desktop' or 'mobile'
    classes: [],
    currentClass: null,
    students: [],
    currentLogs: [],   // 紀錄視窗當下載入的那批，供匯出 CSV 使用
    infographicCache: {},  // key -> { dataUri, alt }，同一次登入內只跟後端要一次
    infographicPending: null,  // 目前等待中的圖表 key，用來丟棄過期的回應
    examTree: null,      // 考卷清單（含一次性 handle），同一次登入內沿用，登出即丟
    examEpoch: 0,        // 開關視窗、重新整理、登出都會 +1，用來丟棄過期的清單回應
    timerInterval: null,
    pollInterval: null,
    pairingRetryTimer: null,  // 配對通道失敗後的重試計時器，重新進入登入畫面時要清掉
    pairingEpoch: 0           // 每次重新申請通道就 +1，用來作廢還在飛行中的舊請求
};

// Initial setup
document.addEventListener("DOMContentLoaded", () => {
    // Reveal app container
    document.getElementById("app").classList.remove("hidden");
    
    // Determine route based on URL query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const pairParam = urlParams.get("pair");
    const modeParam = urlParams.get("mode");

    if (pairParam && modeParam === "login") {
        // MOBILE LOGIN MODE
        state.mode = 'mobile';
        state.pairId = pairParam;
        showMobileLogin();
    } else {
        // DESKTOP BIG SCREEN MODE
        state.mode = 'desktop';
        checkSessionAndInit();
    }
    
    setupEventListeners();
});

// ==================== EVENT LISTENERS SETUP ==================== */
function setupEventListeners() {
    // Desktop Logout Button
    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", performLogout);
    }

    // New Class Form cancellation
    const cancelCreateBtn = document.getElementById("btn-cancel-create");
    if (cancelCreateBtn) {
        cancelCreateBtn.addEventListener("click", () => {
            if (state.classes.length > 0) {
                switchClassTab(state.classes[0]);
            } else {
                showToast("請先建立一個班級！", "error");
            }
        });
    }

    // New Class Student Count change updates seat list dynamically
    const studentCountInput = document.getElementById("input-student-count");
    if (studentCountInput) {
        // 打字途中不修改輸入值，否則刪掉重打時游標會被跳走
        studentCountInput.addEventListener("input", (e) => {
            const count = parseInt(e.target.value, 10);
            if (isNaN(count) || count < 1 || count > MAX_STUDENT_COUNT) return;
            renderVacantSeatsGrid(count);
        });

        // 離開欄位時才夾到合法範圍
        studentCountInput.addEventListener("change", (e) => {
            let count = parseInt(e.target.value, 10);
            if (isNaN(count)) count = DEFAULT_STUDENT_COUNT;
            count = Math.min(MAX_STUDENT_COUNT, Math.max(MIN_STUDENT_COUNT, count));
            e.target.value = count;
            renderVacantSeatsGrid(count);
        });
    }

    // Mobile Login Form Submit
    const mobileForm = document.getElementById("mobile-login-form");
    if (mobileForm) {
        mobileForm.addEventListener("submit", handleMobileLoginSubmit);
    }

    // Desktop Direct Login Form Submit
    const desktopLoginForm = document.getElementById("desktop-login-form");
    if (desktopLoginForm) {
        desktopLoginForm.addEventListener("submit", handleDesktopLoginSubmit);
    }

    // Desktop Create Class Form Submit
    const createClassForm = document.getElementById("create-class-form");
    if (createClassForm) {
        createClassForm.addEventListener("submit", handleCreateClassSubmit);
    }

    setupClassActionListeners();
    setupModalListeners();
}

// 班級管理動作（操作紀錄）
function setupClassActionListeners() {
    const viewLogsBtn = document.getElementById("btn-view-logs");
    if (viewLogsBtn) viewLogsBtn.addEventListener("click", openLogsViewer);

    const exportScoresBtn = document.getElementById("btn-export-scores");
    if (exportScoresBtn) exportScoresBtn.addEventListener("click", exportScoresCsv);

    const logsScope = document.getElementById("logs-all-classes");
    if (logsScope) logsScope.addEventListener("change", loadLogs);

    const exportLogsBtn = document.getElementById("btn-export-logs");
    if (exportLogsBtn) exportLogsBtn.addEventListener("click", exportLogsCsv);

    document.querySelectorAll("[data-infographic]").forEach(btn => {
        btn.addEventListener("click", () => {
            closeHeaderMenu();
            openInfographic(btn.dataset.infographic);
        });
    });

    const menuBtn = document.getElementById("btn-infographic-menu");
    if (menuBtn) {
        menuBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // 不讓下面「點選單外面就關閉」的監聽器馬上又把它關掉
            toggleHeaderMenu();
        });
    }

    // 點選單以外的地方就收起來（大螢幕觸控沒有「滑出去」這回事）
    document.addEventListener("click", (e) => {
        const menu = document.getElementById("infographic-menu");
        if (menu && !menu.classList.contains("hidden") && !menu.contains(e.target)) {
            closeHeaderMenu();
        }
    });

    const examBtn = document.getElementById("btn-exam-review");
    if (examBtn) examBtn.addEventListener("click", openExamViewer);

    const examRefreshBtn = document.getElementById("btn-exam-refresh");
    if (examRefreshBtn) examRefreshBtn.addEventListener("click", () => loadExamTree(true));
}

function toggleHeaderMenu() {
    const menu = document.getElementById("infographic-menu");
    if (!menu) return;
    if (menu.classList.contains("hidden")) {
        menu.classList.remove("hidden");
        document.getElementById("btn-infographic-menu").setAttribute("aria-expanded", "true");
    } else {
        closeHeaderMenu();
    }
}

function closeHeaderMenu() {
    const menu = document.getElementById("infographic-menu");
    const btn = document.getElementById("btn-infographic-menu");
    if (menu) menu.classList.add("hidden");
    if (btn) btn.setAttribute("aria-expanded", "false");
}

// 對話框共用行為：關閉鈕、點背景關閉、Esc 關閉
function setupModalListeners() {
    document.querySelectorAll("[data-close-modal]").forEach(btn => {
        btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
    });

    document.querySelectorAll(".modal-overlay").forEach(overlay => {
        overlay.addEventListener("click", (e) => {
            // 只有點在遮罩本身（而非對話框內部）才關閉
            if (e.target === overlay) closeModal(overlay.id);
        });
    });

    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const menu = document.getElementById("infographic-menu");
        if (menu && !menu.classList.contains("hidden")) {
            closeHeaderMenu();
            return;
        }
        const open = document.querySelector(".modal-overlay:not(.hidden)");
        if (open) closeModal(open.id);
    });
}

// ==================== ROUTING & INITIALIZATION ==================== */

// Desktop Mode Init
// session 只存在記憶體，所以頁面一載入必定是未登入狀態，直接進登入畫面
function checkSessionAndInit() {
    clearLocalSession();
    showDesktopLogin();
}

// Enter the main dashboard
function enterSystem() {
    document.getElementById("desktop-login-view").classList.add("hidden");
    document.getElementById("desktop-view").classList.remove("hidden");
    
    startSessionTimer();
    loadClasses();
}

// Show Desktop login screen (renders QR code)
function showDesktopLogin() {
    document.getElementById("desktop-view").classList.add("hidden");
    document.getElementById("desktop-login-view").classList.remove("hidden");

    // Clear direct desktop login password input and error message
    const desktopPasswordInput = document.getElementById("desktop-password");
    if (desktopPasswordInput) {
        desktopPasswordInput.value = "";
    }
    const desktopErrorEl = document.getElementById("desktop-login-error-msg");
    if (desktopErrorEl) {
        desktopErrorEl.classList.add("hidden");
    }

    requestPairingChannel();
}

// 前 PAIRING_FAST_RETRY 次用退避快速重試，之後才退回固定 5 秒。
// 有些失敗不到一秒就會好（例如剛登出重新導向時 fetch 被導覽中斷），
// 一律等滿 5 秒會讓大螢幕白白空著；但退避次數用完後仍要無限重試——
// 大螢幕是無人看顧的裝置，網路晚幾分鐘恢復時它必須自己好。
const PAIRING_FAST_RETRY = 4;
const PAIRING_SLOW_RETRY_MS = 5000;

// 向後端申請登入配對通道，成功後才渲染 QR Code 並開始輪詢
function requestPairingChannel(attempt) {
    attempt = attempt || 0;

    if (state.pollInterval) clearInterval(state.pollInterval);
    // 手動回到登入畫面時可能已有一輪重試在排隊，不清掉會疊成兩條計時鏈
    if (state.pairingRetryTimer) clearTimeout(state.pairingRetryTimer);

    // clearTimeout 取消得了「已排程」的重試，取消不了「還在飛行中」的請求——
    // 它的 .catch 之後仍會排一條新的鏈，.then 更糟：過期的成功回應會把
    // pairId 覆蓋成舊通道，QR 就對不上真正在輪詢的那一條。用世代編號作廢舊回應。
    state.pairingEpoch = (state.pairingEpoch || 0) + 1;
    const epoch = state.pairingEpoch;

    state.pairId = null;
    state.pollKey = null;

    const qrContainer = document.getElementById("qrcode-box");
    const statusText = document.getElementById("qr-status-text");
    qrContainer.innerHTML = "";
    if (statusText) {
        statusText.innerText = attempt ? "連線失敗，重試中..." : "正在建立安全登入通道...";
    }

    callAPI({ action: "create_pairing" })
        .then(res => {
            if (epoch !== state.pairingEpoch) return;   // 已被更新的一輪取代，丟棄
            if (!res.success) {
                throw new Error(res.error || "建立登入通道失敗");
            }
            state.pairId = res.pairId;
            state.pollKey = res.pollKey;
            renderLoginQRCode();
            startLoginStatusPolling();
        })
        .catch(err => {
            if (epoch !== state.pairingEpoch) return;
            console.error("Failed to create pairing channel", err);
            const fast = attempt < PAIRING_FAST_RETRY;
            if (statusText && !fast) {
                statusText.innerText = "無法連線至伺服器，持續重試中...";
            }
            state.pairingRetryTimer = setTimeout(function () {
                requestPairingChannel(attempt + 1);
            }, fast ? 800 * Math.pow(2, attempt) : PAIRING_SLOW_RETRY_MS);
        });
}

// 依目前的配對通道渲染 QR Code
function renderLoginQRCode() {
    // QR Code 只帶 pairId；領取 token 用的 pollKey 不會離開這台大螢幕
    const loginUrl = `${window.location.origin}${window.location.pathname}?pair=${state.pairId}&mode=login`;

    const qrContainer = document.getElementById("qrcode-box");
    qrContainer.innerHTML = "";

    try {
        new QRCode(qrContainer, {
            text: loginUrl,
            width: 200,
            height: 200,
            colorDark : "#0b0f19",
            colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.M
        });
    } catch (e) {
        console.error("Failed to generate QR Code, using backup rendering", e);
        const safeUrl = escapeHtml(loginUrl);
        qrContainer.innerHTML = `<div style="padding:10px;color:black;background:white;font-size:12px;">無法載入 QR Code 庫，請造訪此連結進行授權:<br><a href="${safeUrl}" target="_blank" rel="noopener" style="color:blue;word-break:break-all;">${safeUrl}</a></div>`;
    }
}

// Show Mobile Login UI
function showMobileLogin() {
    document.getElementById("mobile-login-view").classList.remove("hidden");
    document.getElementById("desktop-view").classList.add("hidden");
    document.getElementById("desktop-login-view").classList.add("hidden");
}

// ==================== POLLING & TIMERS ==================== */

// Poll pairing status (Desktop)
function startLoginStatusPolling() {
    if (state.pollInterval) clearInterval(state.pollInterval);

    const statusText = document.getElementById("qr-status-text");
    statusText.innerText = "等待手機掃描登入中...";

    state.pollInterval = setInterval(() => {
        // 記下發送當下的通道，稍後用來忽略「回應抵達時通道已換過或已登入」的過期結果
        const requestPairId = state.pairId;

        callAPI({
            action: "check_pairing",
            pairId: state.pairId,
            pollKey: state.pollKey
        })
            .then(data => {
                if (state.pairId !== requestPairId) return; // 過期回應，忽略

                if (data.expired) {
                    // 通道逾時或已被使用，重新申請一組
                    clearInterval(state.pollInterval);
                    requestPairingChannel();
                    return;
                }
                if (data.success && data.authenticated && data.session) {
                    clearInterval(state.pollInterval);
                    storeSession(data.session, data.expiresInMinutes);
                    showToast("授權登入成功！", "success");
                    enterSystem();
                }
            })
            .catch(err => console.error("Polling error: ", err));
    }, 3000);
}

// 儲存後端核發的 session token 與到期時間
function storeSession(sessionToken, expiresInMinutes) {
    const minutes = parseInt(expiresInMinutes, 10);
    const durationMs = (isNaN(minutes) || minutes <= 0 ? 45 : minutes) * 60 * 1000;
    const expiry = Date.now() + durationMs;

    // 只放記憶體，理由見 state 上方的註解
    state.sessionToken = sessionToken;
    state.sessionExpiry = expiry;
    state.pairId = null;
    state.pollKey = null;
}

// Session countdown timer (Desktop)
function startSessionTimer() {
    if (state.timerInterval) clearInterval(state.timerInterval);
    
    const timerText = document.getElementById("timer-text");
    
    const updateTimerDisplay = () => {
        const timeLeftMs = state.sessionExpiry - Date.now();
        
        if (timeLeftMs <= 0) {
            clearInterval(state.timerInterval);
            timerText.innerText = "連線已逾期";
            showToast("登入逾時，已自動登出！", "error");
            performLogout();
            return;
        }
        
        const totalSec = Math.floor(timeLeftMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        
        timerText.innerText = `剩餘 ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };
    
    updateTimerDisplay();
    state.timerInterval = setInterval(updateTimerDisplay, 1000);
}

// ==================== API CONTROLLERS ==================== */

// General API request wrapper
function callAPI(payload) {
    // Inject session token into all requests except the login flow itself
    const isLoginFlow = NO_SESSION_ACTIONS.has(payload.action);
    if (!isLoginFlow) {
        payload.session = state.sessionToken;
    }

    return fetch(GAS_API_URL, {
        method: "POST",
        // Using plain text body to bypass CORS preflight OPTIONS requests
        body: JSON.stringify(payload)
    })
    .then(res => {
        if (!res.ok) {
            throw new Error(`HTTP error! Status: ${res.status}`);
        }
        return res.json();
    })
    .then(data => {
        // Handle Session Expiry (401 Unauthorized) returned by backend.
        // 登入流程本身不帶 session，若對它也觸發自動登出會造成
        // performLogout → showDesktopLogin → create_pairing → 401 的無窮迴圈
        // （例如後端尚未更新到支援配對通道的版本時）。
        if (data.code === 401 && !isLoginFlow) {
            showToast("工作階段已失效，請重新登入！", "error");
            performLogout();
            throw new Error("Unauthorized");
        }
        return data;
    });
}

// Load class tabs from backend
function loadClasses() {
    showLoading(true);
    callAPI({ action: "get_classes" })
        .then(res => {
            showLoading(false);
            if (res.success) {
                state.classes = res.classes;
                renderClassTabs();
                
                // Select first class, or go to new class form if no classes exist
                if (state.classes.length > 0) {
                    switchClassTab(state.classes[0]);
                } else {
                    switchClassTab("__new__");
                }
            } else {
                showToast("載入班級清單失敗: " + res.error, "error");
            }
        })
        .catch(err => {
            showLoading(false);
            showToast("無法連線至伺服器，請檢查網路連線", "error");
            console.error(err);
        });
}

// Load class data (students & scores)
function loadClassData(className) {
    showLoading(true);
    callAPI({ action: "get_class_data", className: className })
        .then(res => {
            showLoading(false);
            if (res.success) {
                state.students = res.students;
                document.getElementById("current-class-name").innerText = className;
                document.getElementById("stat-student-count").innerText = state.students.length;
                renderStudentGrid();
                updateTopThreeLeaderboard();
            } else {
                showToast("載入班級資料失敗: " + res.error, "error");
            }
        })
        .catch(err => {
            showLoading(false);
            showToast("資料讀取失敗", "error");
            console.error(err);
        });
}

// Update student score (Optimistic update)
function changeScore(seatNumber, delta) {
    const card = document.querySelector(`.student-card[data-seat="${seatNumber}"]`);
    const scoreValEl = card.querySelector(".student-score");
    const scoreWrapper = card.querySelector(".student-score-wrapper");
    
    // Find current local state
    const studentIdx = state.students.findIndex(s => s.seat === seatNumber);
    if (studentIdx === -1) return;
    
    const oldScore = state.students[studentIdx].score;
    const newScore = oldScore + delta;
    
    // 1. Optimistic Update (UI updates immediately)
    state.students[studentIdx].score = newScore;
    scoreValEl.innerText = newScore >= 0 ? `+${newScore}` : newScore;
    
    // Update color classes
    scoreValEl.className = "student-score";
    if (newScore > 0) scoreValEl.classList.add("positive");
    if (newScore < 0) scoreValEl.classList.add("negative");
    
    // Pulse animation（加分用彈跳幅度較大的版本，扣分維持原本低調的 pulse）
    const pulseClass = delta > 0 ? "score-pulse-up" : "score-pulse";
    scoreWrapper.classList.remove("score-pulse", "score-pulse-up");
    void scoreWrapper.offsetWidth; // Trigger reflow
    scoreWrapper.classList.add(pulseClass);

    // 加分才播鼓勵動畫與音效（扣分不慶祝）
    if (delta > 0) {
        playPraiseAnimation(card, delta);
        playPraiseSound();
    }

    // Update top three display instantly in the optimistic phase
    updateTopThreeLeaderboard();
    
    // 2. Send request to backend
    card.classList.add("updating");
    
    callAPI({ 
        action: "update_score", 
        className: state.currentClass, 
        seatNumber: seatNumber, 
        scoreChange: delta 
    })
    .then(res => {
        card.classList.remove("updating");
        if (res.success) {
            // Confirm score from backend
            state.students[studentIdx].score = res.newScore;
            scoreValEl.innerText = res.newScore >= 0 ? `+${res.newScore}` : res.newScore;
            updateTopThreeLeaderboard();
        } else {
            // Revert on backend error
            state.students[studentIdx].score = oldScore;
            scoreValEl.innerText = oldScore >= 0 ? `+${oldScore}` : oldScore;
            scoreValEl.className = "student-score";
            if (oldScore > 0) scoreValEl.classList.add("positive");
            if (oldScore < 0) scoreValEl.classList.add("negative");
            updateTopThreeLeaderboard();
            
            showToast("寫入失敗，數值已復原！", "error");
        }
    })
    .catch(err => {
        card.classList.remove("updating");
        // Revert on connection error
        state.students[studentIdx].score = oldScore;
        scoreValEl.innerText = oldScore >= 0 ? `+${oldScore}` : oldScore;
        scoreValEl.className = "student-score";
        if (oldScore > 0) scoreValEl.classList.add("positive");
        if (oldScore < 0) scoreValEl.classList.add("negative");
        updateTopThreeLeaderboard();
        
        showToast("網路錯誤，更新失敗！", "error");
        console.error(err);
    });
}

// 加分鼓勵動畫：飄升的鼓勵詞＋分數、星星迸發、卡片綠色光暈
// 每次點擊都建立獨立的圖層，播完自行移除，所以大螢幕連點時不會互相打斷
function playPraiseAnimation(card, delta) {
    // 尊重系統的「減少動態效果」設定
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const word = PRAISE_WORDS[Math.floor(Math.random() * PRAISE_WORDS.length)];

    // 每顆星的方向、距離、大小、自轉、顏色、時長都錯開，散射才不會看起來像機械式的圓
    const stars = Array.from({ length: PRAISE_STAR_COUNT }, (_, i) => {
        const angle = i * (360 / PRAISE_STAR_COUNT) + (i % 2 ? 12 : -6);
        const dist = 56 + (i % 3) * 24;                        // 56 / 80 / 104 px 三層
        const size = [0.55, 0.8, 1.05][i % 3];
        const spin = (i % 2 ? 1 : -1) * (180 + (i % 4) * 90);
        const tint = PRAISE_TINTS[i % PRAISE_TINTS.length];
        const dur = 0.8 + (i % 3) * 0.15;
        return `<i class="praise-star fa-solid fa-star" style="--angle:${angle}deg; --dist:${dist}px; --size:${size}rem; --spin:${spin}deg; --tint:${tint}; --dur:${dur}s"></i>`;
    }).join("");

    const layer = document.createElement("div");
    layer.className = "praise-layer";
    layer.innerHTML = `
        <span class="praise-ring"></span>
        <span class="praise-ring praise-ring-late"></span>
        <span class="praise-burst">${stars}</span>
        <span class="praise-float">
            <span class="praise-word">${word}</span>
            <span class="praise-delta">+${delta}</span>
        </span>
    `;
    card.appendChild(layer);

    // 動畫最長 1.25 秒，稍留餘裕後移除
    setTimeout(() => layer.remove(), 1400);

    // 卡片彈跳＋光暈（重設 class 以便連點時能重播）
    card.classList.remove("card-praise");
    void card.offsetWidth; // Trigger reflow
    card.classList.add("card-praise");

    // 播完就拿掉，別讓 .card-praise 的 z-index: 10 永久留在卡片上。
    // 子元素的動畫也會冒泡到這裡，故須比對 animationName
    card.addEventListener("animationend", function onEnd(e) {
        if (e.animationName !== "card-praise") return;
        card.classList.remove("card-praise");
        card.removeEventListener("animationend", onEnd);
    });
}

// 加分音效以 Web Audio API 即時合成，不引入音檔也不依賴外部資源
// （教室網路可能擋外部請求，且省去在 repo 放二進位檔）
let praiseAudioCtx = null;
let praiseSoundLastAt = 0;

function getPraiseAudioContext() {
    if (praiseAudioCtx) return praiseAudioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null; // 舊瀏覽器沒有 Web Audio 就靜靜不播，不影響加分本身
    praiseAudioCtx = new Ctx();
    return praiseAudioCtx;
}

function playPraiseSound() {
    if (!PRAISE_SOUND_ENABLED) return;

    // 連點時節流，否則多組琶音疊在一起會變噪音
    const nowMs = performance.now();
    if (nowMs - praiseSoundLastAt < PRAISE_SOUND_MIN_GAP_MS) return;
    praiseSoundLastAt = nowMs;

    const ctx = getPraiseAudioContext();
    if (!ctx) return;
    // 自動播放政策會讓 context 生成時處於 suspended；本函式只由點擊觸發，
    // 屬於使用者手勢，可以安全恢復
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = PRAISE_CHIME_VOLUME;
    master.connect(ctx.destination);

    let endsAt = 0;
    PRAISE_CHIME_NOTES.forEach(note => {
        const startAt = now + note.delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = note.freq;
        // 兩段式包封：先快速落到延音位準，再拉長尾音。
        // 單段指數衰減會在前 0.3 秒就掉到幾乎聽不見，時長參數調再大也沒有變長的感覺
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(note.gain, startAt + 0.012);
        gain.gain.exponentialRampToValueAtTime(note.gain * 0.35, startAt + 0.28);
        gain.gain.exponentialRampToValueAtTime(note.gain * 0.02, startAt + note.decay);
        gain.gain.linearRampToValueAtTime(0, startAt + note.decay + 0.06); // 收乾淨，避免尾巴爆音
        osc.connect(gain);
        gain.connect(master);
        osc.start(startAt);
        osc.stop(startAt + note.decay + 0.08);
        endsAt = Math.max(endsAt, note.delay + note.decay + 0.08);
    });

    // 播完把 master 從 destination 卸掉，避免節點無限累積
    setTimeout(() => master.disconnect(), endsAt * 1000 + 300);
}

// Handle login submission on phone (Mobile)
function handleMobileLoginSubmit(e) {
    const passwordInput = document.getElementById("mobile-password");
    const errorEl = document.getElementById("login-error-msg");
    const submitBtn = document.getElementById("btn-mobile-login");
    const btnText = submitBtn.querySelector(".btn-text");
    const btnSpinner = submitBtn.querySelector(".btn-spinner");
    
    const password = passwordInput.value;
    if (!password) return;
    
    // UI Loading state
    errorEl.classList.add("hidden");
    submitBtn.disabled = true;
    btnText.classList.add("hidden");
    btnSpinner.classList.remove("hidden");
    
    callAPI({
        action: "login",
        password: password,
        pairId: state.pairId
    })
    .then(res => {
        submitBtn.disabled = false;
        btnText.classList.remove("hidden");
        btnSpinner.classList.add("hidden");

        if (res.success) {
            // 授權成功。手機端不會取得任何憑證，token 由大螢幕自行領取
            document.getElementById("mobile-login-form-container").classList.add("hidden");
            document.getElementById("mobile-success-container").classList.remove("hidden");
        } else {
            errorEl.classList.remove("hidden");
            errorEl.querySelector("span").innerText = res.error;
            passwordInput.value = "";

            if (res.expired) {
                // 通道已失效，繼續嘗試也沒有意義
                submitBtn.disabled = true;
            } else {
                passwordInput.focus();
            }
        }
    })
    .catch(err => {
        submitBtn.disabled = false;
        btnText.classList.remove("hidden");
        btnSpinner.classList.add("hidden");
        
        errorEl.classList.remove("hidden");
        errorEl.querySelector("span").innerText = "無法連線至後端系統，請重新送出";
        console.error(err);
    });
}

// Handle direct login submission on desktop (Big Screen)
function handleDesktopLoginSubmit(e) {
    const passwordInput = document.getElementById("desktop-password");
    const errorEl = document.getElementById("desktop-login-error-msg");
    const submitBtn = document.getElementById("btn-desktop-login");
    const btnText = submitBtn.querySelector(".btn-text");
    const btnSpinner = submitBtn.querySelector(".btn-spinner");
    
    const password = passwordInput.value;
    if (!password) return;
    
    // UI Loading state
    errorEl.classList.add("hidden");
    submitBtn.disabled = true;
    btnText.classList.add("hidden");
    btnSpinner.classList.remove("hidden");
    
    // 大螢幕直接登入時附帶 pollKey，向後端證明自己就是發起此登入通道的裝置
    callAPI({
        action: "login",
        password: password,
        pairId: state.pairId,
        pollKey: state.pollKey
    })
    .then(res => {
        submitBtn.disabled = false;
        btnText.classList.remove("hidden");
        btnSpinner.classList.add("hidden");

        if (res.success && res.session) {
            // Stop polling
            if (state.pollInterval) clearInterval(state.pollInterval);

            storeSession(res.session, res.expiresInMinutes);

            showToast("登入成功！", "success");
            enterSystem();
        } else {
            errorEl.classList.remove("hidden");
            errorEl.querySelector("span").innerText = res.error || "登入失敗，請重試";
            passwordInput.value = "";
            passwordInput.focus();

            if (res.expired) {
                // 通道已失效，重新申請一組並更新 QR Code
                requestPairingChannel();
            }
        }
    })
    .catch(err => {
        submitBtn.disabled = false;
        btnText.classList.remove("hidden");
        btnSpinner.classList.add("hidden");
        
        errorEl.classList.remove("hidden");
        errorEl.querySelector("span").innerText = "無法連線至後端系統，請重新送出";
        console.error(err);
    });
}

// 檢查班級名稱是否可作為試算表分頁名稱（規則需與後端 validateClassName 一致）
function validateClassName(name) {
    if (!name) return "請輸入班級名稱";
    if (name.length > 15) return "班級名稱請勿超過 15 個字";
    if (name.startsWith("_")) return "班級名稱不可以底線「_」開頭，此為系統保留";
    if (name.startsWith("'")) return "班級名稱不可以單引號「'」開頭";
    if (/[:\\\/\?\*\[\]]/.test(name)) return "班級名稱不可包含 : \\ / ? * [ ] 等字元";
    return null;
}

// Handle New Class Creation (Desktop)
function handleCreateClassSubmit(e) {
    const classNameInput = document.getElementById("input-class-name");
    const studentCountInput = document.getElementById("input-student-count");
    
    const className = classNameInput.value.trim();
    const totalStudents = parseInt(studentCountInput.value, 10);

    // 與後端一致的班級名稱檢查，先在前端擋掉以便即時提示
    const nameError = validateClassName(className);
    if (nameError) {
        showToast(nameError, "error");
        classNameInput.focus();
        return;
    }

    // Collect vacant seats checkboxes
    const vacantCheckboxes = document.querySelectorAll("#vacant-seats-grid input[type='checkbox']:checked");
    const vacantSeats = Array.from(vacantCheckboxes).map(cb => parseInt(cb.value, 10));
    
    showLoading(true);
    callAPI({
        action: "create_class",
        className: className,
        totalStudents: totalStudents,
        vacantSeats: vacantSeats
    })
    .then(res => {
        showLoading(false);
        if (res.success) {
            showToast(`班級「${className}」建立成功並寫入試算表！`, "success");
            
            // Clear form inputs
            classNameInput.value = "";
            studentCountInput.value = DEFAULT_STUDENT_COUNT;
            
            // Reload classes list and switch to the newly created class
            state.classes = res.classes;
            renderClassTabs();
            switchClassTab(res.created);
        } else {
            showToast("建立班級失敗: " + res.error, "error");
        }
    })
    .catch(err => {
        showLoading(false);
        showToast("建立失敗，請檢查網路連線", "error");
        console.error(err);
    });
}

// Perform Logout
function performLogout() {
    // Notify server asynchronously
    if (state.sessionToken) {
        callAPI({ action: "logout" }).catch(e => console.log("Logout notice failed: ", e));
    }
    
    clearLocalSession();

    // 逾時登出時視窗可能還開著：modal 的 z-index 高過登入畫面，不關掉會蓋住 QR Code
    closeHeaderMenu();
    document.querySelectorAll(".modal-overlay:not(.hidden)").forEach(overlay => closeModal(overlay.id));

    // Reset view to QR Code login
    document.getElementById("desktop-view").classList.add("hidden");
    showDesktopLogin();
}

// ==================== RENDERING COMPONENT HELPERS ==================== */

// Show/Hide main loading overlay
function showLoading(show) {
    const loading = document.getElementById("main-loading");
    if (loading) {
        if (show) loading.classList.remove("hidden");
        else loading.classList.add("hidden");
    }
}

// Render tabs at the top header
function renderClassTabs() {
    const tabsContainer = document.getElementById("class-tabs");
    tabsContainer.innerHTML = "";
    
    // Add tab buttons for each class
    state.classes.forEach(cls => {
        const btn = document.createElement("button");
        btn.className = "tab-btn";
        btn.dataset.classTab = cls; // 以 data 屬性辨識，不依賴按鈕顯示文字
        if (state.currentClass === cls) btn.classList.add("active");
        btn.innerText = cls;
        btn.addEventListener("click", () => switchClassTab(cls));
        tabsContainer.appendChild(btn);
    });

    // Add "+ New Class" tab button
    const newTabBtn = document.createElement("button");
    newTabBtn.className = "tab-btn tab-btn-new";
    newTabBtn.dataset.classTab = "__new__";
    if (state.currentClass === "__new__") newTabBtn.classList.add("active");
    newTabBtn.innerHTML = `<i class="fa-solid fa-plus"></i> 新班級`;
    newTabBtn.addEventListener("click", () => switchClassTab("__new__"));
    tabsContainer.appendChild(newTabBtn);
}

// Switch between tabs
function switchClassTab(targetTab) {
    state.currentClass = targetTab;
    
    // Update tabs active state in DOM
    const buttons = document.querySelectorAll(".tab-btn");
    buttons.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.classTab === targetTab);
    });

    const dashboard = document.getElementById("class-dashboard");
    const newClassPanel = document.getElementById("new-class-panel");

    if (targetTab === "__new__") {
        dashboard.classList.add("hidden");
        newClassPanel.classList.remove("hidden");
        const countInput = document.getElementById("input-student-count");
        const initialCount = parseInt(countInput && countInput.value, 10);
        renderVacantSeatsGrid(isNaN(initialCount) ? DEFAULT_STUDENT_COUNT : initialCount);
    } else {
        newClassPanel.classList.add("hidden");
        dashboard.classList.remove("hidden");
        loadClassData(targetTab);
    }
}

// Render grid of student cards
function renderStudentGrid() {
    const grid = document.getElementById("student-grid");
    grid.innerHTML = "";
    
    if (state.students.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-secondary);">
            <i class="fa-regular fa-folder-open" style="font-size: 3rem; margin-bottom:12px; display:block;"></i>此班級尚無學生資料。
        </div>`;
        return;
    }
    
    state.students.forEach(student => {
        const card = document.createElement("div");
        card.className = "student-card animate-card";
        card.setAttribute("data-seat", student.seat);
        
        let scoreClass = "";
        let scoreText = student.score;
        if (student.score > 0) {
            scoreClass = "positive";
            scoreText = `+${student.score}`;
        } else if (student.score < 0) {
            scoreClass = "negative";
        }
        
        // Only display name if it is custom (i.e. not the default "學生X")
        // 姓名來自試算表，屬於外部輸入，插入前必須跳脫
        const isDefaultName = student.name === `學生${student.seat}`;
        const nameHTML = isDefaultName ? "" : `<div class="student-name">${escapeHtml(student.name)}</div>`;

        card.innerHTML = `
            <div class="student-seat">座號 ${student.seat}</div>
            ${nameHTML}
            <div class="student-score-wrapper">
                <span class="student-score ${scoreClass}">${scoreText}</span>
            </div>
            <div class="score-controls">
                <button class="score-btn btn-minus" title="扣分"><i class="fa-solid fa-minus"></i></button>
                <button class="score-btn btn-plus" title="加分"><i class="fa-solid fa-plus"></i></button>
            </div>
        `;
        
        // Hook up scoring buttons
        card.querySelector(".btn-minus").addEventListener("click", () => changeScore(student.seat, -1));
        card.querySelector(".btn-plus").addEventListener("click", () => changeScore(student.seat, 1));
        
        grid.appendChild(card);
    });
}

// Render vacant seat checkbox grid
function renderVacantSeatsGrid(studentCount) {
    const grid = document.getElementById("vacant-seats-grid");
    grid.innerHTML = "";
    
    for (let i = 1; i <= studentCount; i++) {
        const box = document.createElement("div");
        box.className = "vacant-box";
        
        const checkboxId = `vacant-check-${i}`;
        const formattedSeat = i.toString().padStart(2, '0');
        
        box.innerHTML = `
            <input type="checkbox" id="${checkboxId}" value="${i}">
            <label class="vacant-label" for="${checkboxId}">${formattedSeat}</label>
        `;
        
        grid.appendChild(box);
    }
}

// ==================== MODALS ==================== */

function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove("hidden");
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
    if (id === "modal-exam") clearExamTreeView();
}

// ==================== 課堂資訊圖表 ==================== */

// 圖檔不在本 repo，一律向後端要；後端沒驗過 session 就不會給。
function openInfographic(key) {
    var meta = INFOGRAPHICS[key];
    if (!meta) return;

    document.getElementById("infographic-title").innerText = meta.title;
    openModal("modal-infographic");

    // 連點不同按鈕時，只認最後一次點擊的結果，避免先發的請求後到而蓋掉畫面
    state.infographicPending = key;

    var cached = state.infographicCache[key];
    if (cached) {
        showInfographicImage(cached);
        return;
    }

    setInfographicState("loading");

    callAPI({ action: "get_infographic", key: key })
        .then(function (res) {
            if (state.infographicPending !== key) return;

            if (!res.success) {
                setInfographicState("error", res.error || "無法載入圖表");
                return;
            }

            // 後端只會回自家圖檔，但 mime 直接進 data URI，仍先擋掉非圖片與帶分號的值
            var mime = String(res.mimeType || "");
            if (mime.indexOf("image/") !== 0 || mime.indexOf(";") >= 0) {
                setInfographicState("error", "圖表格式不正確");
                return;
            }

            var loaded = {
                dataUri: "data:" + mime + ";base64," + res.data,
                alt: typeof res.alt === "string" && res.alt ? res.alt : meta.title
            };
            state.infographicCache[key] = loaded;
            showInfographicImage(loaded);
        })
        .catch(function (err) {
            console.error("get_infographic failed", err);
            if (state.infographicPending !== key) return;
            setInfographicState("error", "載入圖表失敗，請確認網路後再試一次。");
        });
}

function showInfographicImage(loaded) {
    var img = document.getElementById("infographic-image");
    img.src = loaded.dataUri;
    img.alt = loaded.alt;
    setInfographicState("image");
}

// which：loading／error／image，三者互斥
function setInfographicState(which, message) {
    var loading = document.getElementById("infographic-loading");
    var error = document.getElementById("infographic-error");
    var img = document.getElementById("infographic-image");

    loading.classList.toggle("hidden", which !== "loading");
    error.classList.toggle("hidden", which !== "error");
    img.classList.toggle("hidden", which !== "image");

    if (which === "error") error.innerText = message || "";
}

// ==================== 考卷檢討 ==================== */

// 考卷資料夾是「知道連結的人可檢視」，網址就是通行證。
// 後端清單只給檔名與一次性 handle，網址要點下檔案時才拿得到；
// 前端關閉視窗就清掉畫面上的檔名，登出再把記憶體裡的清單一起丟掉。
function openExamViewer() {
    closeHeaderMenu();
    openModal("modal-exam");
    loadExamTree(false);
}

// force 為 false 時沿用這次登入已經拿過的清單，省下一趟走訪 Drive 的時間
function loadExamTree(force) {
    const container = document.getElementById("exam-tree");
    const epoch = ++state.examEpoch;

    if (state.examTree && !force) {
        renderExamTree(state.examTree);
        return;
    }

    container.innerHTML = `<div class="logs-empty"><div class="spinner"></div>讀取考卷資料夾中...</div>`;

    callAPI({ action: "list_exam_files" })
        .then(res => {
            // 視窗已關閉、已登出或又按了一次重新整理，這份回應作廢
            if (epoch !== state.examEpoch) return;

            if (!res.success) {
                container.innerHTML = `<div class="logs-empty"><i class="fa-solid fa-triangle-exclamation"></i>${escapeHtml(res.error || "讀取失敗")}</div>`;
                return;
            }
            state.examTree = res.tree || [];
            renderExamTree(state.examTree);
            if (res.truncated) showToast("檔案數量較多，只列出前面一部分", "error");
        })
        .catch(err => {
            console.error("list_exam_files failed", err);
            if (epoch !== state.examEpoch) return;
            container.innerHTML = `<div class="logs-empty"><i class="fa-solid fa-plug-circle-xmark"></i>無法連線至伺服器，請按「重新整理」再試一次</div>`;
        });
}

function clearExamTreeView() {
    state.examEpoch++;
    const container = document.getElementById("exam-tree");
    if (container) container.innerHTML = "";
}

function renderExamTree(nodes) {
    const container = document.getElementById("exam-tree");
    container.innerHTML = "";

    if (!nodes.length) {
        container.innerHTML = `<div class="logs-empty"><i class="fa-regular fa-folder-open"></i>考卷資料夾裡還沒有檔案</div>`;
        return;
    }
    container.appendChild(renderExamNodes(nodes));
}

function renderExamNodes(nodes) {
    const frag = document.createDocumentFragment();

    nodes.filter(n => n.type === "folder").forEach(folder => {
        const group = document.createElement("div");
        group.className = "exam-folder";

        const head = document.createElement("button");
        head.type = "button";
        head.className = "exam-folder-head";
        head.setAttribute("aria-expanded", "false");
        head.innerHTML = `
            <i class="fa-solid fa-folder folder-icon"></i>
            <span class="exam-folder-name">${escapeHtml(folder.name)}</span>
            <span class="exam-folder-count">${countExamFiles(folder)} 個檔案</span>
            <i class="fa-solid fa-chevron-right exam-chevron"></i>
        `;

        const body = document.createElement("div");
        body.className = "exam-folder-body hidden";
        body.appendChild(renderExamNodes(folder.children || []));

        head.addEventListener("click", () => {
            const open = !body.classList.toggle("hidden");
            head.classList.toggle("open", open);
            head.setAttribute("aria-expanded", String(open));
            head.querySelector(".folder-icon").className =
                `fa-solid ${open ? "fa-folder-open" : "fa-folder"} folder-icon`;
        });

        group.appendChild(head);
        group.appendChild(body);
        frag.appendChild(group);
    });

    const files = nodes.filter(n => n.type === "file");
    if (files.length) {
        const grid = document.createElement("div");
        grid.className = "exam-file-grid";
        files.forEach(file => grid.appendChild(renderExamFile(file)));
        frag.appendChild(grid);
    }

    return frag;
}

function countExamFiles(node) {
    if (node.type === "file") return 1;
    return (node.children || []).reduce((sum, child) => sum + countExamFiles(child), 0);
}

function renderExamFile(file) {
    const probe = `${file.mimeType || ""} ${file.name}`;
    const match = EXAM_FILE_ICONS.find(entry => entry.test.test(probe)) || { cls: "other", icon: "fa-file" };
    const sub = [file.modified, formatFileSize(file.size)].filter(Boolean).join(" · ");

    const card = document.createElement("button");
    card.type = "button";
    card.className = "exam-file-card";
    card.innerHTML = `
        <span class="exam-file-icon ${match.cls}"><i class="fa-solid ${match.icon}"></i></span>
        <span class="exam-file-meta">
            <span class="exam-file-name">${escapeHtml(file.name)}</span>
            <span class="exam-file-sub">${escapeHtml(sub)}</span>
        </span>
    `;
    card.title = file.name;
    card.addEventListener("click", () => openExamFile(file, card));
    return card;
}

function openExamFile(file, card) {
    // 先在點擊（使用者手勢）裡開好空白分頁，等網址回來再導過去；
    // 等 fetch 完成才 window.open 會被瀏覽器的彈出視窗封鎖擋掉
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;

    card.disabled = true;
    callAPI({ action: "get_exam_file_url", handle: file.handle })
        .then(res => {
            if (res.success && res.url) {
                if (tab) tab.location.href = res.url;
                else showToast("瀏覽器擋下了新分頁，請允許此網站開啟彈出視窗", "error");
            } else {
                if (tab) tab.close();
                showToast(res.error || "無法開啟檔案", "error");
            }
        })
        .catch(err => {
            // 401 時 callAPI 已經處理登出並丟出例外，這裡只負責收掉空白分頁
            if (tab) tab.close();
            if (err && err.message === "Unauthorized") return;
            console.error("get_exam_file_url failed", err);
            showToast("連線失敗，請再試一次", "error");
        })
        .finally(() => {
            card.disabled = false;
        });
}

function formatFileSize(bytes) {
    const n = Number(bytes);
    if (!n || isNaN(n)) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ==================== 操作紀錄 ==================== */

function openLogsViewer() {
    if (!state.currentClass || state.currentClass === "__new__") return;
    openModal("modal-logs");
    loadLogs();
}

function loadLogs() {
    const container = document.getElementById("logs-content");
    const allClasses = document.getElementById("logs-all-classes").checked;

    container.innerHTML = `<div class="logs-empty"><div class="spinner"></div>載入紀錄中...</div>`;
    state.currentLogs = [];

    callAPI({
        action: "get_logs",
        className: allClasses ? null : state.currentClass,
        limit: 200
    })
    .then(res => {
        if (!res.success) {
            container.innerHTML = `<div class="logs-empty"><i class="fa-solid fa-circle-exclamation"></i>載入失敗：${escapeHtml(res.error)}</div>`;
            return;
        }
        state.currentLogs = res.logs || [];
        renderLogs(state.currentLogs);
    })
    .catch(err => {
        container.innerHTML = `<div class="logs-empty"><i class="fa-solid fa-plug-circle-xmark"></i>無法連線至伺服器</div>`;
        console.error(err);
    });
}

function renderLogs(logs) {
    const container = document.getElementById("logs-content");

    if (logs.length === 0) {
        container.innerHTML = `<div class="logs-empty"><i class="fa-regular fa-clipboard"></i>目前沒有操作紀錄</div>`;
        return;
    }

    const rows = logs.map(log => {
        const delta = log.delta === "" || log.delta === null || log.delta === undefined
                      ? "" : Number(log.delta);
        let deltaClass = "";
        let deltaText = "";
        if (delta !== "") {
            deltaClass = delta > 0 ? "positive" : (delta < 0 ? "negative" : "");
            deltaText = delta > 0 ? `+${delta}` : String(delta);
        }
        const target = log.seat === "" || log.seat === null || log.seat === undefined
                       ? "—"
                       : `座號 ${log.seat}${log.name && log.name !== `學生${log.seat}` ? ` ${log.name}` : ""}`;

        return `<tr>
            <td>${escapeHtml(log.time)}</td>
            <td>${escapeHtml(log.className)}</td>
            <td>${escapeHtml(log.action)}</td>
            <td>${escapeHtml(target)}</td>
            <td class="log-delta ${deltaClass}">${escapeHtml(deltaText)}</td>
            <td>${log.newScore === "" || log.newScore === null || log.newScore === undefined ? "" : escapeHtml(log.newScore)}</td>
            <td class="log-device">${escapeHtml(log.device)}</td>
        </tr>`;
    }).join("");

    container.innerHTML = `
        <table class="logs-table">
            <thead>
                <tr>
                    <th>時間</th><th>班級</th><th>動作</th><th>對象</th>
                    <th>變動</th><th>變動後</th><th>裝置</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

// ==================== CSV 匯出 ==================== */

// CSV 欄位跳脫：含逗號／雙引號／換行時以雙引號包起，內部雙引號加倍。
// 另擋 CSV 注入：以 = + - @ 或 tab／CR 開頭的字串會被 Excel 當公式執行，前置單引號使其維持純文字。
// 但純數字要放行，否則扣分的 -3 會被加上單引號變成文字，Excel 無法加總
function csvEscapeCell(value) {
    let text = String(value === undefined || value === null ? "" : value);
    const isPlainNumber = /^-?\d+(\.\d+)?$/.test(text);
    if (!isPlainNumber && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
}

// rows 為二維陣列（第一列是表頭），輸出 CRLF 換行的 CSV 字串
function buildCsv(rows) {
    return rows.map(row => row.map(csvEscapeCell).join(",")).join("\r\n");
}

// 觸發瀏覽器下載。開頭必須補 UTF-8 BOM，否則 Excel 開啟時中文會變亂碼
function downloadCsv(fileName, csvText) {
    const blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 立即 revoke 在部分瀏覽器會讓下載中斷，延後釋放
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 檔名用的本地時間戳 yyyymmdd-HHmm
function csvTimestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 班級名稱可能含檔名不允許的字元，清乾淨再用
function safeFileNamePart(name) {
    const cleaned = String(name === undefined || name === null ? "" : name)
        .replace(/[\\/:*?"<>|]/g, "_")
        .trim();
    return cleaned || "class";
}

// 匯出目前班級的分數表（用畫面上已載入的資料，不再打 API）
function exportScoresCsv() {
    if (!state.currentClass || state.currentClass === "__new__") return;

    if (state.students.length === 0) {
        showToast("此班級沒有學生資料，無法匯出", "error");
        return;
    }

    const rows = [["座號", "姓名", "分數"]];
    state.students.forEach(student => rows.push([student.seat, student.name, student.score]));

    downloadCsv(`${safeFileNamePart(state.currentClass)}_分數_${csvTimestamp()}.csv`, buildCsv(rows));
    showToast(`已匯出 ${state.students.length} 筆分數`, "success");
}

// 匯出操作紀錄（沿用紀錄視窗當下載入的那批，範圍與筆數上限跟著畫面走）
function exportLogsCsv() {
    if (state.currentLogs.length === 0) {
        showToast("目前沒有可匯出的紀錄", "error");
        return;
    }

    const rows = [["時間", "班級", "動作", "座號", "姓名", "變動", "變動後分數", "操作裝置"]];
    state.currentLogs.forEach(log => rows.push([
        log.time, log.className, log.action, log.seat, log.name, log.delta, log.newScore, log.device
    ]));

    const allClasses = document.getElementById("logs-all-classes").checked;
    const scope = allClasses ? "全部班級" : safeFileNamePart(state.currentClass);

    downloadCsv(`${scope}_操作紀錄_${csvTimestamp()}.csv`, buildCsv(rows));
    showToast(`已匯出 ${state.currentLogs.length} 筆紀錄`, "success");
}

// ==================== TOAST & LOCAL STATE UTILS ==================== */

// 將字串跳脫後才可安全插入 innerHTML
function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Toast notification helper
function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    let iconClass = "fa-circle-info";
    if (type === "success") iconClass = "fa-circle-check";
    if (type === "error") iconClass = "fa-circle-exclamation";

    const icon = document.createElement("i");
    icon.className = `fa-solid ${iconClass}`;

    const text = document.createElement("span");
    text.textContent = message; // 訊息可能含後端回傳內容，一律以文字插入

    toast.appendChild(icon);
    toast.appendChild(text);

    container.appendChild(toast);
    
    // Trigger CSS slide-in
    setTimeout(() => toast.classList.add("show"), 10);
    
    // Auto remove after 3.5s
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// Clear current session storage
function clearLocalSession() {
    // 舊版曾把 token 存進 localStorage，這裡順手清掉殘留
    try {
        LEGACY_SESSION_KEYS.forEach(key => localStorage.removeItem(key));
    } catch (e) {
        // 瀏覽器封鎖儲存空間時會丟例外，本來就沒有殘留可清
    }

    state.sessionToken = null;
    state.sessionExpiry = null;
    state.pairId = null;
    state.pollKey = null;
    state.infographicCache = {};
    state.infographicPending = null;
    state.examTree = null;
    clearExamTreeView();

    // 教師簡歷的圖含個資，隱藏的 <img> 仍握著 data URI，登出時一併清掉
    const infographicImg = document.getElementById("infographic-image");
    if (infographicImg) {
        infographicImg.removeAttribute("src");
        infographicImg.alt = "";
    }

    if (state.timerInterval) clearInterval(state.timerInterval);
    if (state.pollInterval) clearInterval(state.pollInterval);
}

// Calculate and render Top 3 leaderboard
function updateTopThreeLeaderboard() {
    const container = document.getElementById("top-three-display");
    if (!container) return;
    
    // Sort students by score descending
    const sorted = [...state.students].sort((a, b) => b.score - a.score);
    
    if (sorted.length === 0) {
        container.innerHTML = `<span style="font-size:0.85rem;color:var(--text-muted);"><i class="fa-solid fa-trophy"></i> 目前尚無評分數據</span>`;
        return;
    }
    
    // Get top 3
    const top3 = sorted.slice(0, 3);
    const medals = [
        '<span class="podium-badge gold"><i class="fa-solid fa-crown"></i> ',
        '<span class="podium-badge silver"><i class="fa-solid fa-trophy"></i> ',
        '<span class="podium-badge bronze"><i class="fa-solid fa-medal"></i> '
    ];
    
    let html = '';
    top3.forEach((student, idx) => {
        const displayName = student.name && student.name !== `學生${student.seat}` ? student.name : `座號 ${student.seat}`;
        let scoreText = student.score >= 0 ? `+${student.score}` : student.score;
        html += `${medals[idx]}${escapeHtml(displayName)} (${scoreText}分)</span>`;
    });
    
    container.innerHTML = html;
}

/**
 * Class Score Web Application Frontend
 */

// backend Google Apps Script URL
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbwZeR2kvK84TiaiuedsCp0Q1DYw_oBk4tGhIBWeQBYeX3At5HxWqlRjPcQ_EfbsjM_qaA/exec";

// 不需附帶 session token 的動作（登入流程本身）
const NO_SESSION_ACTIONS = new Set(["login", "create_pairing", "check_pairing"]);

// 建立班級時的人數範圍（需與 index.html 的 min/max 及後端上限一致）
const MIN_STUDENT_COUNT = 5;
const MAX_STUDENT_COUNT = 50;
const DEFAULT_STUDENT_COUNT = 30;

// Global Application State
const state = {
    sessionToken: null,
    sessionExpiry: null,
    pairId: null,        // 登入配對通道 ID（公開，放在 QR Code 中）
    pollKey: null,       // 領取 session token 的憑證（僅存於大螢幕）
    mode: 'desktop', // 'desktop' or 'mobile'
    classes: [],
    currentClass: null,
    students: [],
    timerInterval: null,
    pollInterval: null
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
}

// ==================== ROUTING & INITIALIZATION ==================== */

// Desktop Mode Session Verification & Init
function checkSessionAndInit() {
    const cachedToken = localStorage.getItem("session_token");
    const cachedExpiry = localStorage.getItem("session_expiry");
    
    if (cachedToken && cachedExpiry && Date.now() < parseInt(cachedExpiry, 10)) {
        // Valid local session exists, verify with backend
        state.sessionToken = cachedToken;
        state.sessionExpiry = parseInt(cachedExpiry, 10);
        
        showLoading(true);
        callAPI({ action: "check_session" })
            .then(res => {
                showLoading(false);
                if (res.success && res.authenticated) {
                    enterSystem();
                } else {
                    // Session rejected by server cache, force login
                    clearLocalSession();
                    showDesktopLogin();
                }
            })
            .catch(err => {
                showLoading(false);
                console.error("Session validation failed", err);
                // 連不上後端時不要放行進主畫面，否則每個操作都會失敗且無從理解。
                // 退回登入畫面即可，該畫面本身會每 5 秒自動重試建立通道。
                showToast("無法連線至伺服器，請確認網路後重新登入", "error");
                clearLocalSession();
                showDesktopLogin();
            });
    } else {
        // No valid session, show login screen
        clearLocalSession();
        showDesktopLogin();
    }
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

// 向後端申請登入配對通道，成功後才渲染 QR Code 並開始輪詢
function requestPairingChannel() {
    if (state.pollInterval) clearInterval(state.pollInterval);

    state.pairId = null;
    state.pollKey = null;

    const qrContainer = document.getElementById("qrcode-box");
    const statusText = document.getElementById("qr-status-text");
    qrContainer.innerHTML = "";
    if (statusText) statusText.innerText = "正在建立安全登入通道...";

    callAPI({ action: "create_pairing" })
        .then(res => {
            if (!res.success) {
                throw new Error(res.error || "建立登入通道失敗");
            }
            state.pairId = res.pairId;
            state.pollKey = res.pollKey;
            renderLoginQRCode();
            startLoginStatusPolling();
        })
        .catch(err => {
            console.error("Failed to create pairing channel", err);
            if (statusText) statusText.innerText = "無法連線至伺服器，5 秒後重試...";
            setTimeout(requestPairingChannel, 5000);
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

    state.sessionToken = sessionToken;
    state.sessionExpiry = expiry;
    state.pairId = null;
    state.pollKey = null;

    localStorage.setItem("session_token", sessionToken);
    localStorage.setItem("session_expiry", expiry.toString());
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
    
    // Pulse animation
    scoreWrapper.classList.remove("score-pulse");
    void scoreWrapper.offsetWidth; // Trigger reflow
    scoreWrapper.classList.add("score-pulse");
    
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
    localStorage.removeItem("session_token");
    localStorage.removeItem("session_expiry");
    state.sessionToken = null;
    state.sessionExpiry = null;
    state.pairId = null;
    state.pollKey = null;

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

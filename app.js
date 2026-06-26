/**
 * Class Score Web Application Frontend
 */

// backend Google Apps Script URL
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbwZeR2kvK84TiaiuedsCp0Q1DYw_oBk4tGhIBWeQBYeX3At5HxWqlRjPcQ_EfbsjM_qaA/exec";

// Global Application State
const state = {
    sessionToken: null,
    sessionExpiry: null,
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
    const sessionParam = urlParams.get("session");
    const modeParam = urlParams.get("mode");

    if (sessionParam && modeParam === "login") {
        // MOBILE LOGIN MODE
        state.mode = 'mobile';
        state.sessionToken = sessionParam;
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
        studentCountInput.addEventListener("input", (e) => {
            let count = parseInt(e.target.value, 10);
            if (isNaN(count)) return;
            if (count > 50) e.target.value = 50;
            if (count < 5) e.target.value = 5;
            renderVacantSeatsGrid(parseInt(e.target.value, 10));
        });
    }

    // Mobile Login Form Submit
    const mobileForm = document.getElementById("mobile-login-form");
    if (mobileForm) {
        mobileForm.addEventListener("submit", handleMobileLoginSubmit);
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
                console.error("Network validation failed, using cached session", err);
                // offline fallback if token is still valid by timestamp
                enterSystem();
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
    
    // Generate a fresh session token
    state.sessionToken = generateSessionToken();
    
    // Generate URL for scanning (points to same site with params)
    const loginUrl = `${window.location.origin}${window.location.pathname}?session=${state.sessionToken}&mode=login`;
    console.log("Login URL generated for phone scan:", loginUrl);
    
    // Render QR Code
    const qrContainer = document.getElementById("qrcode-box");
    qrContainer.innerHTML = ""; // Clear existing QR
    
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
        qrContainer.innerHTML = `<div style="padding:10px;color:black;background:white;font-size:12px;">無法載入 QR Code 庫，請造訪此連結進行授權:<br><a href="${loginUrl}" target="_blank" style="color:blue;word-break:break-all;">${loginUrl}</a></div>`;
    }
    
    // Start Polling backend for login status
    startLoginStatusPolling();
}

// Show Mobile Login UI
function showMobileLogin() {
    document.getElementById("mobile-login-view").classList.remove("hidden");
    document.getElementById("desktop-view").classList.add("hidden");
    document.getElementById("desktop-login-view").classList.add("hidden");
}

// ==================== POLLING & TIMERS ==================== */

// Poll status of current session (Desktop)
function startLoginStatusPolling() {
    if (state.pollInterval) clearInterval(state.pollInterval);
    
    const statusText = document.getElementById("qr-status-text");
    statusText.innerText = "等待手機掃描登入中...";
    
    state.pollInterval = setInterval(() => {
        // Call backend via lightweight GET request
        fetch(`${GAS_API_URL}?action=check_session&session=${state.sessionToken}`)
            .then(res => res.json())
            .then(data => {
                if (data.success && data.authenticated) {
                    clearInterval(state.pollInterval);
                    
                    // Session authorized! Cache it locally
                    const expiry = Date.now() + 45 * 60 * 1000; // 45 minutes
                    localStorage.setItem("session_token", state.sessionToken);
                    localStorage.setItem("session_expiry", expiry.toString());
                    
                    state.sessionExpiry = expiry;
                    
                    showToast("授權登入成功！", "success");
                    enterSystem();
                }
            })
            .catch(err => console.error("Polling error: ", err));
    }, 3000);
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
    // Inject session token into all requests unless it is login
    if (payload.action !== "login") {
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
        // Handle Session Expiry (401 Unauthorized) returned by backend
        if (data.code === 401) {
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
        session: state.sessionToken
    })
    .then(res => {
        submitBtn.disabled = false;
        btnText.classList.remove("hidden");
        btnSpinner.classList.add("hidden");
        
        if (res.success) {
            // Login successful! Update UI to success screen
            document.getElementById("mobile-login-form-container").classList.add("hidden");
            document.getElementById("mobile-success-container").classList.remove("hidden");
        } else {
            errorEl.classList.remove("hidden");
            errorEl.querySelector("span").innerText = res.error;
            passwordInput.value = "";
            passwordInput.focus();
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

// Handle New Class Creation (Desktop)
function handleCreateClassSubmit(e) {
    const classNameInput = document.getElementById("input-class-name");
    const studentCountInput = document.getElementById("input-student-count");
    
    const className = classNameInput.value.trim();
    const totalStudents = parseInt(studentCountInput.value, 10);
    
    if (!className) return;
    
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
            studentCountInput.value = "30";
            
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
        if (state.currentClass === cls) btn.classList.add("active");
        btn.innerText = cls;
        btn.addEventListener("click", () => switchClassTab(cls));
        tabsContainer.appendChild(btn);
    });
    
    // Add "+ New Class" tab button
    const newTabBtn = document.createElement("button");
    newTabBtn.className = "tab-btn tab-btn-new";
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
        btn.classList.remove("active");
        if (btn.innerText === targetTab || (targetTab === "__new__" && btn.classList.contains("tab-btn-new"))) {
            btn.classList.add("active");
        }
    });
    
    const dashboard = document.getElementById("class-dashboard");
    const newClassPanel = document.getElementById("new-class-panel");
    
    if (targetTab === "__new__") {
        dashboard.classList.add("hidden");
        newClassPanel.classList.remove("hidden");
        renderVacantSeatsGrid(30); // Render seat select default 30
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
        const isDefaultName = student.name === `學生${student.seat}`;
        const nameHTML = isDefaultName ? "" : `<div class="student-name">${student.name}</div>`;
        
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

// Generate temporary high entropy session token
function generateSessionToken() {
    if (window.crypto && window.crypto.randomUUID) {
        return window.crypto.randomUUID();
    }
    // Fallback if UUID not supported
    return 'sess_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now().toString(36);
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
    
    toast.innerHTML = `
        <i class="fa-solid ${iconClass}"></i>
        <span>${message}</span>
    `;
    
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
        html += `${medals[idx]}${displayName} (${scoreText}分)</span>`;
    });
    
    container.innerHTML = html;
}

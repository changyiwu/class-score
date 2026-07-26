/**
 * Class Score Web Application Backend
 * Google Apps Script Web App API
 */

// ==================== CONSTANTS ====================

var SESSION_KEY_PREFIX = "sess_";            // CacheService 中 session token 的前綴
var PAIRING_KEY_PREFIX = "pair_";            // CacheService 中登入配對通道的前綴
var GLOBAL_FAILURE_KEY = "login_failures_global";

var PAIRING_TTL_SECONDS = 600;               // 配對通道有效期限（10 分鐘）
var MAX_PAIRING_FAILURES = 5;                // 單一配對通道容許的密碼錯誤次數
var GLOBAL_FAILURE_WINDOW_SECONDS = 600;     // 全域失敗計數的觀察窗口
var GLOBAL_FAILURE_THRESHOLD = 15;           // 超過此失敗數即啟動節流
var GLOBAL_THROTTLE_MS = 2000;               // 節流時每次請求的延遲

var MAX_SCORE_CHANGE = 10;                   // 單次加減分的絕對值上限
var MAX_CLASS_NAME_LENGTH = 15;
var LOCK_TIMEOUT_MS = 15000;                 // 寫入試算表時等待鎖的上限

// Google 試算表分頁名稱不允許的字元
var INVALID_SHEET_NAME_CHARS = /[:\\\/\?\*\[\]]/;

// Helper to return JSON responses
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
                       .setMimeType(ContentService.MimeType.JSON);
}

// Main POST handler - handles all API requests to avoid CORS preflight OPTIONS issues
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: "Empty request body" });
    }

    var request = JSON.parse(e.postData.contents);
    var action = request.action;
    var session = request.session;

    // 1. 免驗證的登入流程端點
    switch (action) {
      case "create_pairing":
        return handleCreatePairing();

      case "check_pairing":
        return handleCheckPairing(request.pairId, request.pollKey);

      case "login":
        return handleLogin(request);
    }

    // 2. 其餘動作一律驗證 session token
    if (!session || !isSessionValid(session)) {
      return jsonResponse({ success: false, error: "Unauthorized", code: 401 });
    }

    // 3. Dispatch authorized actions
    switch (action) {
      case "check_session":
        return jsonResponse({ success: true, authenticated: true });

      case "get_classes":
        return handleGetClasses();

      case "get_class_data":
        return handleGetClassData(request.className);

      case "create_class":
        return handleCreateClass(request.className, request.totalStudents, request.vacantSeats);

      case "update_score":
        return handleUpdateScore(request.className, request.seatNumber, request.scoreChange);

      case "logout":
        return handleLogout(session);

      default:
        return jsonResponse({ success: false, error: "Unknown action: " + action });
    }
  } catch (err) {
    // 僅記錄於伺服器端，不將內部錯誤細節回傳給用戶端
    Logger.log("doPost error: " + err.toString());
    return jsonResponse({ success: false, error: "伺服器處理請求時發生錯誤" });
  }
}

// Simple GET handler for verification
// 註：不再提供 check_session 查詢，避免任何人得以探測 session token 是否有效
function doGet(e) {
  return HtmlService.createHtmlOutput(
    "<h1>Class Score Backend API is active</h1><p>Please access this service via the web frontend.</p>"
  );
}

// ==================== SPREADSHEET ACCESS ====================

// Get or create the master spreadsheet
function getSpreadsheet() {
  var properties = PropertiesService.getScriptProperties();
  var id = properties.getProperty("SPREADSHEET_ID");

  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      // Spreadsheet ID might be invalid or deleted
      properties.deleteProperty("SPREADSHEET_ID");
    }
  }

  // Search Drive for an existing spreadsheet named "ClassScoreDB"
  var files = DriveApp.getFilesByName("ClassScoreDB");
  if (files.hasNext()) {
    var file = files.next();
    properties.setProperty("SPREADSHEET_ID", file.getId());
    return SpreadsheetApp.openById(file.getId());
  }

  // Create a new spreadsheet if not found
  var ss = SpreadsheetApp.create("ClassScoreDB");
  properties.setProperty("SPREADSHEET_ID", ss.getId());

  // Initialize settings sheet
  var settingsSheet = ss.insertSheet("_Settings");
  settingsSheet.appendRow(["Key", "Value"]);
  settingsSheet.appendRow(["Password", "1234"]); // Default password
  settingsSheet.appendRow(["SessionDurationMinutes", "45"]); // Session duration

  // Remove the default "Sheet1" if it exists
  var defaultSheet = ss.getSheetByName("工作表1") || ss.getSheetByName("Sheet1");
  if (defaultSheet) {
    ss.deleteSheet(defaultSheet);
  }

  return ss;
}

// Retrieve setting from the _Settings sheet
function getSetting(key, defaultValue) {
  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName("_Settings");
    if (!sheet) {
      return defaultValue;
    }

    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] && values[i][0].toString().toLowerCase() === key.toLowerCase()) {
        return values[i][1];
      }
    }
  } catch (e) {
    Logger.log("Error getting setting: " + e.toString());
  }
  return defaultValue;
}

// 讀取工作階段時長（分鐘），並限制在合理範圍內
function getSessionDurationMinutes() {
  var minutes = parseInt(getSetting("SessionDurationMinutes", "45"), 10);
  if (isNaN(minutes) || minutes <= 0 || minutes > 360) {
    minutes = 45;
  }
  return minutes;
}

// ==================== SESSION & LOGIN ====================

// Verify session status in CacheService
function isSessionValid(session) {
  if (!session) return false;
  var cache = CacheService.getScriptCache();
  return cache.get(SESSION_KEY_PREFIX + session) === "true";
}

// 定時比較，避免以回應時間推測密碼
function constantTimeEquals(a, b) {
  a = a.toString();
  b = b.toString();
  var diff = a.length ^ b.length;
  var max = Math.max(a.length, b.length);
  for (var i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function readPairing(pairId) {
  if (!pairId) return null;
  var raw = CacheService.getScriptCache().get(PAIRING_KEY_PREFIX + pairId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writePairing(pairId, pairing) {
  CacheService.getScriptCache()
              .put(PAIRING_KEY_PREFIX + pairId, JSON.stringify(pairing), PAIRING_TTL_SECONDS);
}

function removePairing(pairId) {
  CacheService.getScriptCache().remove(PAIRING_KEY_PREFIX + pairId);
}

function getGlobalFailureCount() {
  var value = CacheService.getScriptCache().get(GLOBAL_FAILURE_KEY);
  return value ? (parseInt(value, 10) || 0) : 0;
}

function incrementGlobalFailureCount() {
  var count = getGlobalFailureCount() + 1;
  CacheService.getScriptCache()
              .put(GLOBAL_FAILURE_KEY, count.toString(), GLOBAL_FAILURE_WINDOW_SECONDS);
}

/**
 * 建立登入配對通道。
 * 大螢幕呼叫此端點取得 pairId（放進 QR Code，公開可見）與 pollKey（僅留在大螢幕）。
 * 由於 QR Code 會顯示在全班面前，pairId 視為公開資訊；只有握有 pollKey 的大螢幕
 * 才能領取登入成功後產生的 session token。
 */
function handleCreatePairing() {
  var pairId = Utilities.getUuid();
  var pollKey = Utilities.getUuid();

  writePairing(pairId, { pollKey: pollKey, session: null, failures: 0 });

  return jsonResponse({
    success: true,
    pairId: pairId,
    pollKey: pollKey
  });
}

/**
 * 大螢幕輪詢配對狀態。session token 僅交付一次，交付後立即銷毀配對通道。
 */
function handleCheckPairing(pairId, pollKey) {
  var pairing = readPairing(pairId);

  if (!pairing || !pollKey || pairing.pollKey !== pollKey) {
    return jsonResponse({
      success: false,
      expired: true,
      error: "登入通道已失效，請重新整理頁面"
    });
  }

  if (!pairing.session) {
    return jsonResponse({ success: true, authenticated: false });
  }

  // 一次性交付
  removePairing(pairId);

  return jsonResponse({
    success: true,
    authenticated: true,
    session: pairing.session,
    expiresInMinutes: getSessionDurationMinutes()
  });
}

/**
 * 處理密碼登入（手機授權或大螢幕直接登入）。
 * session token 一律由後端產生：手機端只會收到「授權成功」，不會取得任何憑證。
 */
function handleLogin(request) {
  var pairId = request.pairId;
  var pairing = readPairing(pairId);

  if (!pairing) {
    return jsonResponse({
      success: false,
      expired: true,
      error: "登入通道已失效，請重新整理大螢幕頁面後再掃描一次"
    });
  }

  if (pairing.failures >= MAX_PAIRING_FAILURES) {
    return jsonResponse({
      success: false,
      expired: true,
      error: "密碼錯誤次數過多，請重新整理大螢幕頁面取得新的登入通道"
    });
  }

  // 全域節流：短時間內失敗次數過多時，拖慢每一次嘗試以阻擋暴力破解
  if (getGlobalFailureCount() >= GLOBAL_FAILURE_THRESHOLD) {
    Utilities.sleep(GLOBAL_THROTTLE_MS);
  }

  var dbPassword = getSetting("Password", "1234").toString().trim();
  var passwordInput = (request.password === undefined || request.password === null)
                      ? "" : request.password.toString().trim();

  if (!passwordInput || !constantTimeEquals(passwordInput, dbPassword)) {
    pairing.failures = (pairing.failures || 0) + 1;
    writePairing(pairId, pairing);
    incrementGlobalFailureCount();

    var remaining = MAX_PAIRING_FAILURES - pairing.failures;
    if (remaining <= 0) {
      return jsonResponse({
        success: false,
        expired: true,
        error: "密碼錯誤次數過多，請重新整理大螢幕頁面取得新的登入通道"
      });
    }
    return jsonResponse({
      success: false,
      error: "密碼錯誤，尚可嘗試 " + remaining + " 次"
    });
  }

  // 密碼正確：由後端產生真正的 session token
  var sessionToken = Utilities.getUuid();
  var durationMinutes = getSessionDurationMinutes();
  CacheService.getScriptCache()
              .put(SESSION_KEY_PREFIX + sessionToken, "true", durationMinutes * 60);

  // 大螢幕直接登入：請求方已證明握有 pollKey，可直接交付 token
  if (request.pollKey && request.pollKey === pairing.pollKey) {
    removePairing(pairId);
    return jsonResponse({
      success: true,
      session: sessionToken,
      expiresInMinutes: durationMinutes
    });
  }

  // 手機授權：token 存入配對通道，等待大螢幕以 pollKey 領取；手機端不取得憑證
  pairing.session = sessionToken;
  pairing.failures = 0;
  writePairing(pairId, pairing);

  return jsonResponse({ success: true, message: "授權成功" });
}

// Handle Logout
function handleLogout(session) {
  CacheService.getScriptCache().remove(SESSION_KEY_PREFIX + session);
  return jsonResponse({ success: true, message: "Logged out successfully" });
}

// ==================== CLASS DATA ====================

// 取得所有班級名稱（排除以底線開頭的內部分頁）
function listClassNames(ss) {
  var sheets = ss.getSheets();
  var classNames = [];
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (name.indexOf("_") !== 0) {
      classNames.push(name);
    }
  }
  return classNames;
}

// Get all class names (sheet tabs)
function handleGetClasses() {
  return jsonResponse({
    success: true,
    classes: listClassNames(getSpreadsheet())
  });
}

// Get all students and scores in a class
function handleGetClassData(className) {
  if (!className) {
    return jsonResponse({ success: false, error: "Missing class name" });
  }

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(className);
  if (!sheet) {
    return jsonResponse({ success: false, error: "Class not found: " + className });
  }

  var data = sheet.getDataRange().getValues();
  var students = [];

  // Headers: Seat, Name, Score (座號, 姓名, 分數)
  // Data starts at row 2 (index 1)
  for (var i = 1; i < data.length; i++) {
    var seat = parseInt(data[i][0], 10);
    if (isNaN(seat)) continue; // 略過座號空白或非數字的列

    var name = data[i][1] ? data[i][1].toString() : ("學生" + seat);
    var score = parseInt(data[i][2], 10);
    if (isNaN(score)) score = 0;

    students.push({
      seat: seat,
      name: name,
      score: score
    });
  }

  // Sort students by seat number
  students.sort(function(a, b) {
    return a.seat - b.seat;
  });

  return jsonResponse({
    success: true,
    className: className,
    students: students
  });
}

/**
 * 檢查班級名稱是否可作為試算表分頁名稱。
 * 合法回傳 null，不合法回傳錯誤訊息。
 */
function validateClassName(name) {
  if (!name) return "請輸入班級名稱";

  name = name.toString().trim();
  if (!name) return "請輸入班級名稱";
  if (name.length > MAX_CLASS_NAME_LENGTH) {
    return "班級名稱請勿超過 " + MAX_CLASS_NAME_LENGTH + " 個字";
  }
  if (name.charAt(0) === "_") {
    return "班級名稱不可以底線「_」開頭，此為系統保留";
  }
  if (name.charAt(0) === "'") {
    return "班級名稱不可以單引號「'」開頭";
  }
  if (INVALID_SHEET_NAME_CHARS.test(name)) {
    return "班級名稱不可包含 : \\ / ? * [ ] 等字元";
  }
  return null;
}

// Create a new class tab
function handleCreateClass(className, totalStudents, vacantSeats) {
  var nameError = validateClassName(className);
  if (nameError) {
    return jsonResponse({ success: false, error: nameError });
  }
  className = className.toString().trim();

  totalStudents = parseInt(totalStudents, 10);
  if (isNaN(totalStudents) || totalStudents <= 0) {
    totalStudents = 30;
  }
  if (totalStudents > 50) {
    totalStudents = 50;
  }

  var vacantSeatsArray = [];
  if (vacantSeats && vacantSeats.length) {
    for (var v = 0; v < vacantSeats.length; v++) {
      var vacant = parseInt(vacantSeats[v], 10);
      if (!isNaN(vacant)) vacantSeatsArray.push(vacant);
    }
  }

  // 以鎖避免同時建立同名班級而產生重複分頁
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
  } catch (e) {
    return jsonResponse({ success: false, error: "系統忙碌中，請稍後再試" });
  }

  try {
    var ss = getSpreadsheet();
    if (ss.getSheetByName(className)) {
      return jsonResponse({ success: false, error: "班級已存在" });
    }

    var sheet = ss.insertSheet(className);
    sheet.appendRow(["座號", "姓名", "分數"]);

    var rows = [];
    for (var seat = 1; seat <= totalStudents; seat++) {
      if (vacantSeatsArray.indexOf(seat) === -1) {
        rows.push([seat, "學生" + seat, 0]);
      }
    }

    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 3).setValues(rows);
    }

    // Format the headers
    sheet.getRange("A1:C1").setFontWeight("bold").setBackground("#f3f4f6");

    return jsonResponse({
      success: true,
      classes: listClassNames(ss),
      created: className
    });
  } finally {
    lock.releaseLock();
  }
}

// Update a student's score
function handleUpdateScore(className, seatNumber, scoreChange) {
  if (!className || seatNumber === undefined || scoreChange === undefined) {
    return jsonResponse({ success: false, error: "Missing arguments" });
  }

  seatNumber = parseInt(seatNumber, 10);
  scoreChange = parseInt(scoreChange, 10);

  if (isNaN(seatNumber) || isNaN(scoreChange)) {
    return jsonResponse({ success: false, error: "Invalid arguments" });
  }
  if (scoreChange === 0 || Math.abs(scoreChange) > MAX_SCORE_CHANGE) {
    return jsonResponse({
      success: false,
      error: "單次加減分需介於 1 至 " + MAX_SCORE_CHANGE + " 分之間"
    });
  }

  // 讀取後再寫入的操作必須加鎖，否則大螢幕連續點擊時併發請求會互相覆蓋而漏算分數
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
  } catch (e) {
    return jsonResponse({ success: false, error: "系統忙碌中，請稍後再試" });
  }

  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(className);
    if (!sheet) {
      return jsonResponse({ success: false, error: "Class not found" });
    }

    var data = sheet.getDataRange().getValues();
    var foundRowIndex = -1;
    var currentScore = 0;

    for (var i = 1; i < data.length; i++) {
      if (parseInt(data[i][0], 10) === seatNumber) {
        foundRowIndex = i + 1; // row index in sheet is 1-based, data[i] is row index i+1
        currentScore = parseInt(data[i][2], 10);
        if (isNaN(currentScore)) currentScore = 0;
        break;
      }
    }

    if (foundRowIndex === -1) {
      return jsonResponse({ success: false, error: "Seat number not found in class" });
    }

    var newScore = currentScore + scoreChange;
    sheet.getRange(foundRowIndex, 3).setValue(newScore); // Column C is index 3
    SpreadsheetApp.flush(); // 確保釋放鎖之前資料已真正寫入

    return jsonResponse({
      success: true,
      className: className,
      seatNumber: seatNumber,
      newScore: newScore
    });
  } finally {
    lock.releaseLock();
  }
}

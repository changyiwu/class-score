/**
 * Class Score Web Application Backend
 * Google Apps Script Web App API
 */

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
    
    // 1. Handle login action (no session verification required)
    if (action === "login") {
      return handleLogin(request);
    }
    
    // 2. Validate session token for all other actions
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
    return jsonResponse({ success: false, error: err.toString() });
  }
}

// Simple GET handler for verification
function doGet(e) {
  // Check if it's a simple status check
  var action = e.parameter.action;
  var session = e.parameter.session;
  
  if (action === "check_session" && session) {
    return jsonResponse({ 
      success: true, 
      authenticated: isSessionValid(session) 
    });
  }
  
  return HtmlService.createHtmlOutput(
    "<h1>Class Score Backend API is active</h1><p>Please access this service via the web frontend.</p>"
  );
}

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

// Verify session status in CacheService
function isSessionValid(session) {
  if (!session) return false;
  var cache = CacheService.getScriptCache();
  var value = cache.get(session);
  return value === "true";
}

// Handle Mobile Login
function handleLogin(request) {
  var passwordInput = request.password;
  var session = request.session;
  
  if (!session) {
    return jsonResponse({ success: false, error: "Missing session token" });
  }
  
  var dbPassword = getSetting("Password", "1234").toString().trim();
  
  if (passwordInput && passwordInput.toString().trim() === dbPassword) {
    var durationMinutes = parseInt(getSetting("SessionDurationMinutes", "45"), 10);
    if (isNaN(durationMinutes)) durationMinutes = 45;
    
    var durationSeconds = durationMinutes * 60;
    
    // Store in script cache (max allowed duration is 6 hours, 45 mins is 2700s, perfectly fine)
    var cache = CacheService.getScriptCache();
    cache.put(session, "true", durationSeconds);
    
    return jsonResponse({ success: true, message: "Login successful" });
  } else {
    return jsonResponse({ success: false, error: "密碼錯誤，請重新輸入" });
  }
}

// Handle Logout
function handleLogout(session) {
  var cache = CacheService.getScriptCache();
  cache.remove(session);
  return jsonResponse({ success: true, message: "Logged out successfully" });
}

// Get all class names (sheet tabs)
function handleGetClasses() {
  var ss = getSpreadsheet();
  var sheets = ss.getSheets();
  var classNames = [];
  
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    // Exclude settings or internal sheets
    if (!name.startsWith("_")) {
      classNames.push(name);
    }
  }
  
  return jsonResponse({ 
    success: true, 
    classes: classNames 
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

// Create a new class tab
function handleCreateClass(className, totalStudents, vacantSeats) {
  if (!className) {
    return jsonResponse({ success: false, error: "Missing class name" });
  }
  
  totalStudents = parseInt(totalStudents, 10);
  if (isNaN(totalStudents) || totalStudents <= 0) {
    totalStudents = 30;
  }
  
  var vacantSeatsArray = [];
  if (vacantSeats) {
    vacantSeatsArray = vacantSeats.map(function(s) { return parseInt(s, 10); });
  }
  
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(className);
  
  if (sheet) {
    return jsonResponse({ success: false, error: "班級已存在" });
  }
  
  sheet = ss.insertSheet(className);
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
  
  // Return updated class list
  var sheets = ss.getSheets();
  var classNames = [];
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (!name.startsWith("_")) {
      classNames.push(name);
    }
  }
  
  return jsonResponse({
    success: true,
    classes: classNames,
    created: className
  });
}

// Update a student's score
function handleUpdateScore(className, seatNumber, scoreChange) {
  if (!className || seatNumber === undefined || scoreChange === undefined) {
    return jsonResponse({ success: false, error: "Missing arguments" });
  }
  
  seatNumber = parseInt(seatNumber, 10);
  scoreChange = parseInt(scoreChange, 10);
  
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
  
  return jsonResponse({
    success: true,
    className: className,
    seatNumber: seatNumber,
    newScore: newScore
  });
}

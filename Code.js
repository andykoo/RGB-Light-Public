/** Code.gs - Main Entry & Routing */



function doGet(e) {
  const page = e.parameter.page || 'student';
  
  if (page === 'admin') {
    return HtmlService.createTemplateFromFile('Admin')
      .evaluate()
      .setTitle('AI 作品儀錶板 - 管理者')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  
  // default to student
  const tmp = HtmlService.createTemplateFromFile('Student');
  // pass query param 'code' if exists, so template can init with it
  tmp.urlParams = { code: e.parameter.code || '' };
  
  return tmp.evaluate()
    .setTitle('AI 作品儀錶板 - 學生')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * API Dispatcher
 * In GAS, client calls google.script.run.myFunction()
 * specific functions must be global.
 */

/* Admin Auth APIs */
function api_adminLogin(username, password) {
  return auth_login(username, password);
}

function api_adminChangePassword(token, oldPass, newPass) {
  return auth_changePassword(token, oldPass, newPass);
}

function api_adminListAdmins(token) {
  const session = assertAdminByToken_(token);
  const admin = db_getAdmin_(session.username);

  // If not SUPER_ADMIN, return only themselves
  if (admin.role !== 'SUPER_ADMIN') {
      return [{ username: admin.username, role: admin.role }];
  }

  // SUPER_ADMIN gets all
  return db_readAll_(SHEET_NAMES.ADMINS).map(r => ({
    username: r.username,
    role: r.role || 'ADMIN'
  }));
}

function api_adminCreateAdmin(token, newUsername, newPassword, newRole) {
  const session = assertAdminByToken_(token);
  // Check if session user is SUPER_ADMIN
  const admin = db_getAdmin_(session.username); 
  if (!admin || admin.role !== 'SUPER_ADMIN') {
    throw new Error('權限不足：僅系統管理員 (SUPER_ADMIN) 可新增管理員');
  }

  // Basic validation
  if (!newUsername || !newPassword) throw new Error('使用者名稱與密碼為必填');
  if (db_getAdmin_(newUsername)) throw new Error('使用者名稱已存在');
  
  // Complexity
  auth_validatePasswordComplexity_(newPassword);

  const salt = auth_generateSalt_();
  const hash = auth_hash_(newPassword, salt);
  
  db_createAdmin_({
    username: newUsername,
    passwordHash: hash,
    salt: salt,
    isDefaultPassword: true,
    role: newRole || 'ADMIN' // Allow specifying role
  });
  
  return { success: true };
}

function api_adminDeleteAdmin(token, targetUsername) {
  const session = assertAdminByToken_(token);
  const admin = db_getAdmin_(session.username);
  if (!admin || admin.role !== 'SUPER_ADMIN') {
    throw new Error('權限不足：僅系統管理員 (SUPER_ADMIN) 可刪除管理員');
  }

  if (session.username === targetUsername) {
     throw new Error('無法刪除自己');
  }
  // also prevent deleting the last admin?
  if (db_countAdmins_() <= 1) {
     throw new Error('無法刪除唯一的管理員');
  }
  
  // Prevent deleting another SUPER_ADMIN? (Optional safety)
  const target = db_getAdmin_(targetUsername);
  if (target && target.role === 'SUPER_ADMIN') {
     throw new Error('無法刪除系統管理員');
  }

  // Delete from DB (Not implemented in DB.gs yet? We need db_deleteAdmin_)
  // For now, let's assume we implement db_deleteAdmin_ or use direct sheet manipulation if needed.
  // Actually, wait, db_deleteAdmin_ isn't in the snippet I saw earlier.
  // Let's implement db_deleteAdmin_ validation check passed, so we proceed.
  db_deleteAdmin_(targetUsername);
  
  return { success: true };
}

function api_adminResetPassword(token, targetUsername, newPassword) {
  const session = assertAdminByToken_(token);
  const admin = db_getAdmin_(session.username);
  
  if (!admin || admin.role !== 'SUPER_ADMIN') {
    throw new Error('權限不足：僅系統管理員 (SUPER_ADMIN) 可重置密碼');
  }

  if (!newPassword) throw new Error('新密碼為必填');

  // Verify target exists
  const target = db_getAdmin_(targetUsername);
  if (!target) throw new Error('找不到該使用者');

  // Complexity
  auth_validatePasswordComplexity_(newPassword);

  const salt = auth_generateSalt_();
  const hash = auth_hash_(newPassword, salt);

  // Update password and set isDefaultPassword to false (Admin set it manually, arguably "known")
  db_updateAdmin_(targetUsername, {
    passwordHash: hash,
    salt: salt,
    isDefaultPassword: true
  });

  return { success: true };
}  


/* Admin Feature APIs */

function adminCreateGuestActivity(payload) {
  // Uses CacheService to create a temporary activity memory without DB
  const cache = CacheService.getScriptCache();
  
  // Basic validation
  if (!payload.AI_API_KEY) throw new Error('API Key is required for guest mode');
  if (!payload.UPLOAD_FOLDER_ID) throw new Error('Upload Folder ID is required for guest mode');
  getWritableUploadFolderSafe_(payload.UPLOAD_FOLDER_ID);
  
  const code = 'G-' + Math.floor(1000 + Math.random() * 9000); // e.g. G-1234
  
  const activityData = {
    activityCode: code,
    activityName: payload.activityName || '訪客臨時活動',
    rubric: payload.rubric || '',
    startTime: payload.startTime || Date.now(),
    limitHours: payload.limitHours || 2,
    enableAI: true, // Always true for guest mode to make sense of KEY
    enableSeatLock: !!payload.enableSeatLock,
    isTimeLimited: true,
    studentCount: payload.studentCount || 30,
    isActive: true,
    AI_API_KEY: payload.AI_API_KEY,
    UPLOAD_FOLDER_ID: payload.UPLOAD_FOLDER_ID,
    createdAt: Date.now()
  };
  
  // Store activity metadata for 6 hours maximum in GAS cache
  cache.put('ACT_' + code, JSON.stringify(activityData), 21600); 
  
  // Initialize empty seats array in cache for tracking
  const initialSeats = [];
  cache.put('SEATS_' + code, JSON.stringify(initialSeats), 21600);
  
  return activityData;
}

function adminGetGuestDashboard(activityCode) {
  // Reads temporary dashboard state from CacheService
  const cache = CacheService.getScriptCache();
  
  const actJson = cache.get('ACT_' + activityCode);
  if (!actJson) throw new Error('臨時活動代碼無效或已過期 (Cache Expired)');
  
  const activity = JSON.parse(actJson);
  const seatsJson = cache.get('SEATS_' + activityCode);
  const cachedSeats = seatsJson ? JSON.parse(seatsJson) : [];
  
  // Fill missing seats up to studentCount
  const fullSeats = [];
  for (let i = 1; i <= activity.studentCount; i++) {
    const existing = cachedSeats.find(s => s.seatNo === i);
    if (existing) {
      fullSeats.push(existing);
    } else {
      fullSeats.push({
        activityCode: activityCode,
        seatNo: i,
        lightStatus: 'NONE',
        latestPhotoUrl: '',
        latestAiScore: '',
        latestAiSuggestion: '',
        lastSubmitAt: '',
        isOccupied: false,
        isHelpRequested: false
      });
    }
  }
  
  return {
    activity: activity,
    seats: fullSeats
  };
}

// --- ITC (Individual/Interaction-oriented Student Check) ---
const ITC_CANONICAL_CODES = ['ON_ACTIVE', 'ON_PASSIVE', 'SEEK_HELP', 'UNCLEAR', 'OFF_TASK', 'DISRUPTIVE'];

function normalizeItcCode_(rawCode) {
  const src = String(rawCode || '').trim();
  const aliases = {
    ON_ACTIVE: 'ON_ACTIVE', ON_TASK_ACTIVE: 'ON_ACTIVE', ACTIVE: 'ON_ACTIVE', '主動在工作中': 'ON_ACTIVE',
    ON_PASSIVE: 'ON_PASSIVE', ON_TASK_PASSIVE: 'ON_PASSIVE', PASSIVE: 'ON_PASSIVE', '被動在工作中': 'ON_PASSIVE',
    SEEK_HELP: 'SEEK_HELP', HELP: 'SEEK_HELP', '求助': 'SEEK_HELP',
    UNCLEAR: 'UNCLEAR', '無法判斷': 'UNCLEAR',
    OFF_TASK: 'OFF_TASK', 'OFF-TASK': 'OFF_TASK', '不在工作中': 'OFF_TASK',
    DISRUPTIVE: 'DISRUPTIVE', DISRUPT: 'DISRUPTIVE', '干擾': 'DISRUPTIVE'
  };
  return aliases[src] || aliases[src.toUpperCase()] || '';
}

function parseItcCountsJson_(jsonText) {
  try {
    const parsed = JSON.parse(String(jsonText || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    ITC_CANONICAL_CODES.forEach(code => clean[code] = Number(parsed[code] || 0));
    return clean;
  } catch (err) {
    return {};
  }
}

function normalizeItcEvents_(events) {
  if (!Array.isArray(events)) return [];
  const now = Date.now();
  const seen = {};
  return events.map((item, idx) => {
    if (!item || typeof item !== 'object') return null;
    const seatNo = Number(item.seatNo);
    const itcCode = normalizeItcCode_(item.itcCode || item.code);
    if (!seatNo || seatNo < 1 || !itcCode) return null;
    const clientTs = Number(item.clientTs || item.timestamp || now);
    const seq = Number(item.seq || 0);
    const key = String(item.idempotencyKey || `${seatNo}_${itcCode}_${clientTs}_${seq}_${idx}`);
    if (seen[key]) return null;
    seen[key] = true;
    return {
      seatNo, itcCode,
      source: String(item.source || 'dock'),
      mode: String(item.mode || 'itc'),
      intervalSec: Math.max(0, Number(item.intervalSec || 0)),
      clientTs: clientTs > 0 ? clientTs : now,
      serverTs: now,
      seq: isNaN(seq) ? 0 : seq,
      idempotencyKey: key
    };
  }).filter(Boolean);
}

function buildItcLogRow_(eventItem, meta) {
  return {
    user_id: meta.userId || '', category: meta.category || 'admin',
    activity_id: meta.activityCode || '', activity_name: meta.activityName || '',
    student_count: Number(meta.studentCount || 0), event_type: 'itc_mark',
    payload: JSON.stringify(eventItem), timestamp: eventItem.serverTs
  };
}

function buildItcSummaryPatch_(seat, eventsForSeat) {
  const sorted = eventsForSeat.slice().sort((a, b) => a.serverTs - b.serverTs || a.seq - b.seq);
  const last = sorted[sorted.length - 1];
  const counts = parseItcCountsJson_(seat && seat.itcCountsJson);
  const todayKey = Utilities.formatDate(new Date(last.serverTs || Date.now()), 'Asia/Taipei', 'yyyy-MM-dd');
  const sameDay = String((seat && seat.itcDayKey) || '') === todayKey;
  const dayCounts = sameDay ? parseItcCountsJson_(seat && seat.itcDayCountsJson) : {};
  sorted.forEach(ev => {
    counts[ev.itcCode] = Number(counts[ev.itcCode] || 0) + 1;
    dayCounts[ev.itcCode] = Number(dayCounts[ev.itcCode] || 0) + 1;
  });
  return {
    itcLastCode: last.itcCode, itcLastAt: last.serverTs,
    itcTotal: Number((seat && seat.itcTotal) || 0) + sorted.length,
    itcCountsJson: JSON.stringify(counts), itcDayKey: todayKey,
    itcDayTotal: (sameDay ? Number((seat && seat.itcDayTotal) || 0) : 0) + sorted.length,
    itcDayCountsJson: JSON.stringify(dayCounts), updatedAt: Date.now()
  };
}

function adminLogItcEvents(token, activityCode, events) {
  const session = assertAdminByToken_(token);
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  const normalized = normalizeItcEvents_(events).filter(ev => ev.seatNo <= Number(activity.studentCount || 0));
  if (!normalized.length) return { success: true, accepted: 0, seatsUpdated: 0 };
  db_insertLogs_(normalized.map(ev => buildItcLogRow_(ev, {
    userId: session.username || '', category: 'admin', activityCode,
    activityName: activity.activityName || '', studentCount: activity.studentCount || 0
  })));
  const bySeat = {};
  normalized.forEach(ev => {
    if (!bySeat[ev.seatNo]) bySeat[ev.seatNo] = [];
    bySeat[ev.seatNo].push(ev);
  });
  Object.keys(bySeat).forEach(key => {
    const seatNo = Number(key);
    db_updateSeatStatus_(activityCode, seatNo, buildItcSummaryPatch_(db_getOneSeatStatus_(activityCode, seatNo) || {}, bySeat[key]));
  });
  return { success: true, accepted: normalized.length, seatsUpdated: Object.keys(bySeat).length };
}

function adminGuestLogItcEvents(activityCode, events) {
  if (!String(activityCode || '').startsWith('G-')) throw new Error('Guest activity code required');
  const cache = CacheService.getScriptCache();
  const actJson = cache.get('ACT_' + activityCode);
  if (!actJson) throw new Error('Activity not found');
  const activity = JSON.parse(actJson) || {};
  const studentCount = Number(activity.studentCount || 0);
  const normalized = normalizeItcEvents_(events).filter(ev => !studentCount || ev.seatNo <= studentCount);
  if (!normalized.length) return { success: true, accepted: 0, seatsUpdated: 0 };
  db_insertLogs_(normalized.map(ev => buildItcLogRow_(ev, {
    userId: 'guest_admin', category: 'guest_admin', activityCode,
    activityName: activity.activityName || '', studentCount
  })));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const seats = JSON.parse(cache.get('SEATS_' + activityCode) || '[]');
    const bySeat = {};
    normalized.forEach(ev => {
      if (!bySeat[ev.seatNo]) bySeat[ev.seatNo] = [];
      bySeat[ev.seatNo].push(ev);
    });
    Object.keys(bySeat).forEach(key => {
      const seatNo = Number(key);
      let seat = seats.find(s => Number(s.seatNo) === seatNo);
      if (!seat) {
        seat = { activityCode, seatNo, lightStatus: 'NONE', isOccupied: false, isHelpRequested: false };
        seats.push(seat);
      }
      Object.assign(seat, buildItcSummaryPatch_(seat, bySeat[key]));
    });
    cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
    return { success: true, accepted: normalized.length, seatsUpdated: Object.keys(bySeat).length };
  } finally {
    lock.releaseLock();
  }
}

function getWritableUploadFolder_(folderId) {
  if (!folderId) {
    throw new Error('尚未設定上傳資料夾 ID');
  }

  try {
    const folder = DriveApp.getFolderById(folderId);
    folder.getName();
    return folder;
  } catch (e) {
    throw new Error(buildDriveAccessError_(folderId, e));
  }
}

function createSharedUploadFile_(folder, blob, filename) {
  let file;
  try {
    file = folder.createFile(blob).setName(filename);
  } catch (e) {
    throw new Error(buildDriveAccessError_(folder.getId(), e));
  }

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    throw new Error(
      '檔案已上傳到 Google Drive，但無法設成「知道連結的任何人可檢視」。' +
      '請確認部署帳號對此資料夾有分享權限，且網域或 Shared Drive 政策允許連結檢視。' +
      ` Folder ID: ${folder.getId()}`
    );
  }

  return file;
}

function buildDriveAccessError_(folderId, err) {
  const rawMessage = String((err && err.message) || err || '');
  const normalized = rawMessage.toLowerCase();

  if (
    normalized.includes('access denied') ||
    rawMessage.indexOf('存取遭拒') !== -1 ||
    rawMessage.indexOf('權限') !== -1
  ) {
    return '無法存取上傳資料夾。請確認目前 Apps Script Web App 的部署帳號已完成授權，' +
      '而且對這個資料夾具有編輯權限；若資料夾位於 Shared Drive，也要確認部署帳號是成員。' +
      ` Folder ID: ${folderId}`;
  }

  if (
    normalized.includes('not found') ||
    rawMessage.indexOf('找不到') !== -1 ||
    rawMessage.indexOf('不存在') !== -1
  ) {
    return `找不到上傳資料夾，請確認 UPLOAD_FOLDER_ID 是否正確。Folder ID: ${folderId}`;
  }

  return `無法存取上傳資料夾（${rawMessage}）。Folder ID: ${folderId}`;
}

function getWritableUploadFolderSafe_(folderId) {
  if (!folderId) {
    throw new Error('Upload folder ID is not set');
  }

  try {
    const folder = DriveApp.getFolderById(folderId);
    folder.getName();
    return folder;
  } catch (e) {
    throw new Error(buildDriveAccessErrorSafe_(folderId, e));
  }
}

function createSharedUploadFileSafe_(folder, blob, filename, options) {
  const requireLinkSharing = !!(options && options.requireLinkSharing);
  let file;
  try {
    file = folder.createFile(blob).setName(filename);
  } catch (e) {
    throw new Error(buildDriveAccessErrorSafe_(folder.getId(), e));
  }

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    const sharingWarning =
      'File uploaded to Google Drive, but sharing could not be set to anyone-with-link. ' +
      'Check whether the deployment account can manage sharing for this folder and whether domain or Shared Drive policies allow link sharing.' +
      ` Folder ID: ${folder.getId()}`;
    if (requireLinkSharing) {
      throw new Error(sharingWarning);
    }
    return { file, sharingWarning };
  }

  return { file, sharingWarning: '' };
}

function buildDriveAccessErrorSafe_(folderId, err) {
  const rawMessage = String((err && err.message) || err || '');
  const normalized = rawMessage.toLowerCase();

  if (
    normalized.includes('access denied') ||
    rawMessage.indexOf('存取遭拒') !== -1 ||
    rawMessage.indexOf('權限') !== -1
  ) {
    return 'Cannot access the upload folder. Make sure the Apps Script web app deployment account has completed authorization and has editor access to this folder. If the folder is in a Shared Drive, the deployment account must be a member.' +
      ` Folder ID: ${folderId}`;
  }

  if (
    normalized.includes('not found') ||
    rawMessage.indexOf('找不到') !== -1 ||
    rawMessage.indexOf('不存在') !== -1
  ) {
    return `Upload folder not found. Check whether UPLOAD_FOLDER_ID is correct. Folder ID: ${folderId}`;
  }

  return `Unable to access upload folder (${rawMessage}). Folder ID: ${folderId}`;
}

function adminUpdateGuestActivity(activityCode, payload) {
  const cache = CacheService.getScriptCache();
  const actJson = cache.get('ACT_' + activityCode);
  if (!actJson) throw new Error('臨時活動代碼無效或已過期');
  
  const activity = JSON.parse(actJson);
  
  if (payload.activityName !== undefined) activity.activityName = payload.activityName;
  if (payload.className !== undefined) activity.className = payload.className;
  if (payload.enableAI !== undefined) activity.enableAI = !!payload.enableAI;
  if (payload.enableSeatLock !== undefined) activity.enableSeatLock = !!payload.enableSeatLock;
  if (payload.rubric !== undefined) activity.rubric = payload.rubric;
  if (payload.AI_API_KEY !== undefined) activity.AI_API_KEY = String(payload.AI_API_KEY || '').trim();
  if (payload.UPLOAD_FOLDER_ID !== undefined) {
    const folderId = String(payload.UPLOAD_FOLDER_ID || '').trim();
    if (!folderId) throw new Error('Upload Folder ID is required for guest mode');
    getWritableUploadFolderSafe_(folderId);
    activity.UPLOAD_FOLDER_ID = folderId;
  }
  
  if (payload.isTimeLimited !== undefined) activity.isTimeLimited = !!payload.isTimeLimited;
  if (payload.startTime !== undefined) activity.startTime = Number(payload.startTime);
  if (payload.limitHours !== undefined) activity.limitHours = Number(payload.limitHours);
  
  if (payload.studentCount !== undefined) activity.studentCount = Number(payload.studentCount);
  if (!activity.AI_API_KEY) throw new Error('API Key is required for guest mode');
  
  cache.put('ACT_' + activityCode, JSON.stringify(activity), 21600);
  return activity;
}

function adminSetGuestSeatLight(activityCode, seatNo, lightStatus) {
  const cache = CacheService.getScriptCache();
  const seatsJson = cache.get('SEATS_' + activityCode);
  let seats = seatsJson ? JSON.parse(seatsJson) : [];
  
  let seat = seats.find(s => String(s.seatNo) === String(seatNo));
  if (seat) {
    seat.lightStatus = lightStatus;
    // Don't modify other properties like photoUrl
  } else {
    seat = {
      activityCode: activityCode,
      seatNo: Number(seatNo),
      lightStatus: lightStatus,
      latestPhotoUrl: '',
      latestAiScore: '',
      latestAiSuggestion: '',
      lastSubmitAt: Date.now(),
      isOccupied: false,
      isHelpRequested: false
    };
    seats.push(seat);
  }
  
  cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
  return seat;
}

function adminExportGuestActivity(activityCode) {
  const cache = CacheService.getScriptCache();
  const actJson = cache.get('ACT_' + activityCode);
  if (!actJson) throw new Error('臨時活動代碼無效或已過期');
  
  const activity = JSON.parse(actJson);
  
  const seatsJson = cache.get('SEATS_' + activityCode);
  const seats = seatsJson ? JSON.parse(seatsJson) : [];
  const submissions = db_getHistoryByActivity_(activityCode)
    .sort((a, b) => Number(a.uploadAt || 0) - Number(b.uploadAt || 0));
  const irs = irsExportBackup_(activityCode);
  
  const exportData = {
     version: '1.2',
     exportedAt: Date.now(),
     activity: activity,
     seats: seats,
     submissions: submissions,
     submissionCount: submissions.length,
     irs: irs
  };
  
  const json = JSON.stringify(exportData, null, 2);
  const zip = Utilities.zip([
     Utilities.newBlob(json, 'application/json', 'data.json')
  ], `${activity.activityName}_${new Date().toISOString().slice(0,10)}_GUEST.zip`);
  
  return {
    filename: zip.getName(),
    base64: Utilities.base64Encode(zip.getBytes()),
    submissionCount: submissions.length
  };
}

function adminImportGuestActivity(currentActivityCode, base64Zip) {
  const cache = CacheService.getScriptCache();
  
  // ensure current guest session exists to inherit keys
  const currentActJson = cache.get('ACT_' + currentActivityCode);
  if (!currentActJson) throw new Error('當前臨時活動代碼無效或已過期，無法匯入');
  const sessionAct = JSON.parse(currentActJson);
  const currentKey = sessionAct.AI_API_KEY;
  const currentFolder = sessionAct.UPLOAD_FOLDER_ID;

  const blob = Utilities.newBlob(Utilities.base64Decode(base64Zip), 'application/zip');
  const blobs = Utilities.unzip(blob);
  const jsonBlob = blobs.find(b => b.getName() === 'data.json');
  if (!jsonBlob) throw new Error('檔案無效: 找不到 data.json');
  
  const data = JSON.parse(jsonBlob.getDataAsString());
  
  // Overwrite current guest session's state but preserve keys and current code
  const importedAct = data.activity;
  if (!importedAct) throw new Error('Backup activity payload missing');
  if (!importedAct.AI_API_KEY) {
      importedAct.AI_API_KEY = Config_get('AI_API_KEY');
  }
  if (!importedAct.UPLOAD_FOLDER_ID) {
      importedAct.UPLOAD_FOLDER_ID = Config_get('UPLOAD_FOLDER_ID');
  }
  importedAct.activityCode = currentActivityCode;
  importedAct.AI_API_KEY = currentKey;
  importedAct.UPLOAD_FOLDER_ID = currentFolder;
  
  cache.put('ACT_' + currentActivityCode, JSON.stringify(importedAct), 21600);
  
  if (data.seats) {
     const seats = data.seats.map(s => {
         s.activityCode = currentActivityCode;
         return s;
     });
     cache.put('SEATS_' + currentActivityCode, JSON.stringify(seats), 21600);
  }
  restoreGuestSubmissionHistory_(data.submissions, currentActivityCode);
  irsRestoreBackup_(data.irs, currentActivityCode);
  
  return importedAct;
}

function restoreGuestSubmissionHistory_(submissions, activityCode) {
  const sourceRows = Array.isArray(submissions) ? submissions : [];
  if (!sourceRows.length) return 0;

  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  const existing = db_getHistoryByActivity_(activityCode);
  const known = {};
  existing.forEach(function(item) {
    const key = [item.submissionId, item.seatNo, item.photoUrl, item.uploadAt].join('|');
    known[key] = true;
  });

  const rowsToAdd = sourceRows.map(function(item) {
    const restored = Object.assign({}, item, { activityCode: activityCode });
    if (!restored.submissionId) restored.submissionId = Utilities.getUuid();
    return restored;
  }).filter(function(item) {
    const key = [item.submissionId, item.seatNo, item.photoUrl, item.uploadAt].join('|');
    if (known[key]) return false;
    known[key] = true;
    return true;
  });
  if (!rowsToAdd.length) return 0;

  const sh = db_getSpreadsheet_().getSheetByName(SHEET_NAMES.SUBMISSIONS);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.getRange(sh.getLastRow() + 1, 1, rowsToAdd.length, headers.length)
    .setValues(rowsToAdd.map(function(item) { return objToRow_(headers, item); }));
  return rowsToAdd.length;
}

function adminStartGuestActivityFromBackup(base64Zip, overrides) {
  const cache = CacheService.getScriptCache();
  
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Zip), 'application/zip');
  const blobs = Utilities.unzip(blob);
  const jsonBlob = blobs.find(b => b.getName() === 'data.json');
  if (!jsonBlob) throw new Error('檔案無效: 找不到 data.json');
  
  const data = JSON.parse(jsonBlob.getDataAsString());
  
  const importedAct = data.activity;
  if (!importedAct) throw new Error('Backup activity payload missing');
  const overrideApiKey = String((overrides && overrides.AI_API_KEY) || '').trim();
  const overrideFolderId = String((overrides && overrides.UPLOAD_FOLDER_ID) || '').trim();
  if (overrideApiKey) {
      importedAct.AI_API_KEY = overrideApiKey;
  }
  if (overrideFolderId) {
      importedAct.UPLOAD_FOLDER_ID = overrideFolderId;
  }
  if (!importedAct.AI_API_KEY) {
      importedAct.AI_API_KEY = Config_get('AI_API_KEY');
  }
  if (!importedAct.UPLOAD_FOLDER_ID) {
      importedAct.UPLOAD_FOLDER_ID = Config_get('UPLOAD_FOLDER_ID');
  }
  if (!importedAct) throw new Error('備份檔內容錯誤');
  
  if (!importedAct.AI_API_KEY || !importedAct.UPLOAD_FOLDER_ID) {
      throw new Error('此備份檔缺少 API Key 或資料夾 ID，無法用於直接開局。請先正常輸入設定開局後，再從系統內匯入備份。');
  }
  
  getWritableUploadFolderSafe_(importedAct.UPLOAD_FOLDER_ID);

  const code = 'G-' + Math.floor(1000 + Math.random() * 9000);
  
  importedAct.activityCode = code;
  importedAct.startTime = Date.now();
  importedAct.createdAt = Date.now();
  
  cache.put('ACT_' + code, JSON.stringify(importedAct), 21600);
  
  if (data.seats) {
     const seats = data.seats.map(s => {
         s.activityCode = code;
         return s;
     });
     cache.put('SEATS_' + code, JSON.stringify(seats), 21600);
  } else {
     cache.put('SEATS_' + code, JSON.stringify([]), 21600);
  }
  restoreGuestSubmissionHistory_(data.submissions, code);
  irsRestoreBackup_(data.irs, code);
  
  return importedAct;
}

function adminSendGuestBackupEmail(activityCode, toEmail) {
  try {
    const exportRes = adminExportGuestActivity(activityCode);
    sendBackupEmail_(exportRes, toEmail);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function adminSendBackupEmail(token, activityCode, toEmail) {
  try {
    assertAdminByToken_(token);
    const exportRes = adminExportActivity(token, activityCode);
    sendBackupEmail_(exportRes, toEmail);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function sendBackupEmail_(exportRes, toEmail) {
  const blob = Utilities.newBlob(Utilities.base64Decode(exportRes.base64), 'application/zip', exportRes.filename);
  
  // Extract activity name from filename or assume it's part of the file name (e.g. ActivityName_2026-02-24.zip)
  const actName = exportRes.filename.split('_')[0] || '臨時活動';
  const nowStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  
  const scriptUrl = ScriptApp.getService().getUrl();
  const adminLink = scriptUrl + '?page=admin';
  
  const subject = `[AI 互動燈板] 活動備份檔 - ${actName}`;
  const body = `老師您好，

感謝您使用「AI 互動燈板儀錶板」！這是一封系統自動發送的活動備份信件。

以下是您的活動基本資訊：
► 活動名稱：${actName}
► 備份時間：${nowStr}

【附件說明】
此信件包含一個 .zip 壓縮檔附件，內容即為您的活動備份資料。

【如何快速還原】
下次連入系統時，只要在首頁的「訪客老師快速開局」區塊中，點選「📂 匯入備份檔並開局 (.zip)」並選取此附檔，即可免除繁瑣設定，瞬間恢復您備份時的狀態！

【系統管理介面】
快速點擊以下連結回到管理員控制台：
${adminLink}

祝您 教學順利！
AI 互動燈板系統 敬上`;

  GmailApp.sendEmail(toEmail, subject, body, {
    attachments: [blob],
    name: 'AI 互動燈板系統'
  });
}

function adminCreateActivity(token, payload) {
  assertAdminByToken_(token);
  return db_createActivity_(payload);
}

function adminListActivities(token) {
  assertAdminByToken_(token);
  return db_listActivities_();
}

function adminGetDashboard(token, activityCode) {
  assertAdminByToken_(token);
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  
  const seats = db_getSeatStatusByActivity_(activityCode).filter(s => s.seatNo <= activity.studentCount);
  return {
    activity: activity,
    seats: seats
  };
}

function adminGetSeatDetail(token, activityCode, seatNo) {
  assertAdminByToken_(token);
  return db_getOneSeatStatus_(activityCode, seatNo);
}

function adminSetSeatLight(token, activityCode, seatNo, lightStatus) {
  assertAdminByToken_(token);
  db_setSeatLight_(activityCode, seatNo, lightStatus, { keepAi: true, keepPhoto: true });
  return db_getOneSeatStatus_(activityCode, seatNo);
}

function adminReleaseSeat(token, activityCode, seatNo) {
  assertAdminByToken_(token);
  // Clearing occupancy for a seat (Force reset)
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  
  db_updateSeatStatus_(activityCode, seatNo, { isOccupied: false });
  return { success: true };
}

function adminReleaseAllSeats(token, activityCode) {
  assertAdminByToken_(token);
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  
  // Batch update all seats for this activity
  const seats = db_getSeatStatusByActivity_(activityCode);
  seats.forEach(s => {
      if(s.isOccupied) {
          db_updateSeatStatus_(activityCode, s.seatNo, { isOccupied: false });
      }
  });
  return { success: true };
}

function adminGuestReleaseSeat(activityCode, seatNo) {
  const cache = CacheService.getScriptCache();
  const seatsJson = cache.get('SEATS_' + activityCode);
  if (!seatsJson) return { success: false, error: 'Activity not found' };
  
  let seats = JSON.parse(seatsJson);
  let seat = seats.find(s => String(s.seatNo) === String(seatNo));
  if (seat) {
      seat.isOccupied = false;
      cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
  }
  return { success: true };
}

function adminGuestReleaseAllSeats(activityCode) {
  const cache = CacheService.getScriptCache();
  const seatsJson = cache.get('SEATS_' + activityCode);
  if (!seatsJson) return { success: false, error: 'Activity not found' };
  
  let seats = JSON.parse(seatsJson);
  seats.forEach(s => {
      s.isOccupied = false;
  });
  cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
  return { success: true };
}

function adminBatchSetSeatLight(token, activityCode, seatNos, lightStatus) {
  assertAdminByToken_(token);
  db_batchSetSeatLight_(activityCode, seatNos, lightStatus);
  return db_getSeatStatusByActivity_(activityCode);
}

function adminGetSettings(token) {
  assertAdminByToken_(token);
  db_initSystemConfig_();
  return Config_getAll();
}

function adminUpdateSettings(token, payload) {
  assertAdminByToken_(token);
  if (payload.ADMIN_EMAILS !== undefined) Config_set('ADMIN_EMAILS', payload.ADMIN_EMAILS);
  if (payload.AI_PROVIDER !== undefined) Config_set('AI_PROVIDER', payload.AI_PROVIDER);
  if (payload.AI_API_KEY !== undefined) Config_set('AI_API_KEY', payload.AI_API_KEY);
  if (payload.UPLOAD_FOLDER_ID !== undefined) {
    if (payload.UPLOAD_FOLDER_ID) {
      getWritableUploadFolderSafe_(payload.UPLOAD_FOLDER_ID);
    }
    Config_set('UPLOAD_FOLDER_ID', payload.UPLOAD_FOLDER_ID);
  }
  
  return Config_getAll();
}

function adminTestUploadFolder(token, folderId) {
  assertAdminByToken_(token);

  const normalizedFolderId = String(folderId || '').trim();
  if (!normalizedFolderId) throw new Error('Upload folder ID is required');

  const folder = getWritableUploadFolderSafe_(normalizedFolderId);
  const blob = Utilities.newBlob(
    'RGB Light upload folder test',
    'text/plain',
    `upload-folder-test-${Date.now()}.txt`
  );
  const uploadResult = createSharedUploadFileSafe_(folder, blob, blob.getName(), { requireLinkSharing: true });
  const file = uploadResult.file;

  try {
    file.setTrashed(true);
  } catch (e) {
    throw new Error(
      'Upload test passed create/share checks, but the temporary test file could not be moved to trash. ' +
      `File ID: ${file.getId()}`
    );
  }

  return {
    success: true,
    folderId: normalizedFolderId,
    folderName: folder.getName(),
    fileId: file.getId(),
    message: `Upload test passed for folder "${folder.getName()}".`
  };
}

function adminUpdateActivity(token, payload) {
  assertAdminByToken_(token);
  return db_updateActivity_(payload.activityCode, payload);
}

function adminGetSeatHistory(token, activityCode, seatNo) {
  assertAdminByToken_(token);
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  
  const submissions = db_getHistoryBySeat_(activityCode, seatNo);
  const activity = db_getActivityByCode_(activityCode) || {};
  const folderIds = [Config_get('UPLOAD_FOLDER_ID'), activity.UPLOAD_FOLDER_ID]
    .map(function(value) { return String(value || '').trim(); })
    .filter(function(value, index, values) { return value && values.indexOf(value) === index; });
  let merged = submissions;
  folderIds.forEach(function(folderId) {
    merged = mergeSeatSubmissionHistoryFromDrive_(merged, folderId, activityCode, seatNo);
  });
  // Logged-in activities may have files in an older configured folder. An authenticated
  // teacher can safely recover those files by their activity/seat filename identity.
  merged = mergeSeatSubmissionHistoryFromDrive_(merged, '', activityCode, seatNo, true);
  merged.sort((a, b) => Number(b.uploadAt || 0) - Number(a.uploadAt || 0));
  return merged;
}

function adminGetSeatHistoryJson(token, activityCode, seatNo) {
  const history = adminGetSeatHistory(token, activityCode, seatNo);
  return JSON.stringify(history);
}

function adminGuestGetSeatHistory(activityCode, seatNo) {
  if (!String(activityCode || '').startsWith('G-')) throw new Error('Guest activity code required');
  const actJson = CacheService.getScriptCache().get('ACT_' + activityCode);
  if (!actJson) throw new Error('活動已過期或無效');
  const activity = JSON.parse(actJson) || {};
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  const submissions = db_getHistoryBySeat_(activityCode, seatNo);
  const merged = mergeSeatSubmissionHistoryFromDrive_(submissions, activity.UPLOAD_FOLDER_ID, activityCode, seatNo);
  merged.sort((a, b) => Number(b.uploadAt || 0) - Number(a.uploadAt || 0));
  return merged;
}

function mergeSeatSubmissionHistoryFromDrive_(submissions, folderId, activityCode, seatNo, searchAllDrive) {
  const merged = Array.isArray(submissions) ? submissions.slice() : [];
  if (!folderId && !searchAllDrive) return merged;
  const knownIds = {};
  merged.forEach(function(item) {
    const match = String(item.photoUrl || '').match(/[?&]id=([^&]+)/);
    if (match && match[1]) knownIds[match[1]] = true;
  });
  try {
    const normalizedCode = String(activityCode || '').trim();
    const normalizedSeat = String(Number(seatNo));
    const prefix = normalizedCode + '_S' + normalizedSeat + '_';
    const escapedCode = normalizedCode.replace(/'/g, "\\'");
    const files = searchAllDrive
      ? DriveApp.searchFiles("title contains '" + escapedCode + "' and trashed = false")
      : DriveApp.getFolderById(String(folderId).trim()).searchFiles("title contains '" + prefix.replace(/'/g, "\\'") + "' and trashed = false");
    const filenamePattern = new RegExp(
      '^' + normalizedCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_S0*' + normalizedSeat + '_(?:ADMIN_)?(\\d{13})(?:\\.[^.]+)?$',
      'i'
    );
    while (files.hasNext()) {
      const file = files.next();
      const name = String(file.getName() || '');
      const filenameMatch = name.match(filenamePattern);
      if (!filenameMatch || knownIds[file.getId()]) continue;
      const createdAt = filenameMatch[1] ? Number(filenameMatch[1]) : file.getDateCreated().getTime();
      merged.push({
        submissionId: 'drive_' + file.getId(),
        activityCode: activityCode,
        seatNo: Number(seatNo),
        photoUrl: 'https://drive.google.com/thumbnail?sz=w1000&id=' + file.getId(),
        lightStatus: 'NONE',
        aiScore: '',
        aiSuggestion: '由 Google Drive 復原的作品紀錄',
        uploadAt: createdAt,
        updatedAt: createdAt,
        recoveredFromDrive: true
      });
      knownIds[file.getId()] = true;
    }
  } catch (err) {
    console.warn('Drive history recovery failed: ' + String(err && err.message || err));
  }
  return merged;
}

function adminExportActivity(token, activityCode) {
  assertAdminByToken_(token);
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  
  const seats = db_getSeatStatusByActivity_(activityCode);
  const allSubmissions = db_getHistoryByActivity_(activityCode)
    .sort((a, b) => Number(a.uploadAt || 0) - Number(b.uploadAt || 0));
  const irs = irsExportBackup_(activityCode);
  
  const exportData = {
     version: '1.2',
     exportedAt: Date.now(),
     activity: activity,
     seats: seats,
     submissions: allSubmissions,
     submissionCount: allSubmissions.length,
     irs: irs
  };
  
  const json = JSON.stringify(exportData, null, 2);
  const zip = Utilities.zip([
     Utilities.newBlob(json, 'application/json', 'data.json')
  ], `${activity.activityName}_${new Date().toISOString().slice(0,10)}.zip`);
  
  return {
    filename: zip.getName(),
    base64: Utilities.base64Encode(zip.getBytes()),
    submissionCount: allSubmissions.length
  };
}

function adminImportActivity(token, base64Zip) {
  assertAdminByToken_(token);
  
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Zip), 'application/zip');
  const blobs = Utilities.unzip(blob);
  const jsonBlob = blobs.find(b => b.getName() === 'data.json');
  if (!jsonBlob) throw new Error('Invalid backup: data.json not found');
  
  const data = JSON.parse(jsonBlob.getDataAsString());
  
  // Restore Activity
  const oldAct = db_getActivityByCode_(data.activity.activityCode);
  if (oldAct) throw new Error('Activity code already exists: ' + data.activity.activityCode);
  
  const ss = db_getSpreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAMES.ACTIVITIES);
  let headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.appendRow(objToRow_(headers, data.activity));
  
  sh = ss.getSheetByName(SHEET_NAMES.SEAT_STATUS);
  headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const seatRows = data.seats.map(s => objToRow_(headers, s));
  if (seatRows.length) {
     sh.getRange(sh.getLastRow() + 1, 1, seatRows.length, headers.length).setValues(seatRows);
  }
  
  sh = ss.getSheetByName(SHEET_NAMES.SUBMISSIONS);
  headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const submissions = Array.isArray(data.submissions) ? data.submissions : [];
  const subRows = submissions.map(s => objToRow_(headers, s));
  if (subRows.length) {
     sh.getRange(sh.getLastRow() + 1, 1, subRows.length, headers.length).setValues(subRows);
  }
  irsRestoreBackup_(data.irs, data.activity.activityCode);
  
  return data.activity;
}

/* Student APIs */

function studentGetActivity(activityCode) {
  if (String(activityCode).startsWith('G-')) {
     const cache = CacheService.getScriptCache();
     const actJson = cache.get('ACT_' + activityCode);
     if (!actJson) throw new Error('活動代碼無效或已過期');
     
     const activity = JSON.parse(actJson);
     const timeStatus = checkActivityTime_(activity);
     if (timeStatus.status === 'not-started') {
         throw new Error(`活動尚未開始 (開始時間: ${new Date(activity.startTime).toLocaleString()})`);
     }
     if (timeStatus.status === 'ended') {
         throw new Error('活動已結束');
     }
     
     const seatsJson = cache.get('SEATS_' + activityCode);
     const seats = seatsJson ? JSON.parse(seatsJson) : [];
     const occupiedSeats = activity.enableSeatLock
       ? seats.filter(s => s.isOccupied === true).map(s => s.seatNo)
       : [];
     
     return {
        activityName: activity.activityName,
        studentCount: activity.studentCount,
        enableAI: activity.enableAI,
        enableSeatLock: !!activity.enableSeatLock,
        occupiedSeats: occupiedSeats,
        isTimeLimited: activity.isTimeLimited,
        startTime: activity.startTime,
        limitHours: activity.limitHours,
        serverTime: Date.now(),
        isGuestMode: true // flag for frontend
     };
  }

  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS); // Ensure isOccupied exists
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  if (!activity.isActive) throw new Error('Activity is closed');
  
  // Time Check
  const timeStatus = checkActivityTime_(activity);
  if (timeStatus.status === 'not-started') {
      throw new Error(`活動尚未開始 (開始時間: ${new Date(activity.startTime).toLocaleString()})`);
  }
  if (timeStatus.status === 'ended') {
      throw new Error('活動已結束');
  }
  
  // Get seat usage
  const seats = db_getSeatStatusByActivity_(activityCode);
  const occupiedSeats = activity.enableSeatLock
    ? seats.filter(s => s.isOccupied === true).map(s => s.seatNo)
    : [];

  return {
    activityName: activity.activityName,
    studentCount: activity.studentCount,
    enableAI: activity.enableAI,
    enableSeatLock: !!activity.enableSeatLock,
    occupiedSeats: occupiedSeats,
    // Pass time config for countdown
    isTimeLimited: activity.isTimeLimited,
    startTime: activity.startTime,
    limitHours: activity.limitHours,
    serverTime: Date.now()
  };
}

function checkActivityTime_(activity) {
    if (!activity.isTimeLimited) return { status: 'active' };
    
    const now = Date.now();
    const start = activity.startTime;
    const end = start + (activity.limitHours * 3600000);
    
    if (now < start) return { status: 'not-started', start, end };
    if (now > end) return { status: 'ended', start, end };
    return { status: 'active', start, end };
}

function studentClaimSeat(activityCode, seatNo) {
   const isGuest = String(activityCode).startsWith('G-');
   const lock = LockService.getScriptLock();
   lock.waitLock(10000);
   
   try {
     let seats = [];
     if (isGuest) {
       const cache = CacheService.getScriptCache();
       const seatsJson = cache.get('SEATS_' + activityCode);
       seats = seatsJson ? JSON.parse(seatsJson) : [];
       const existing = seats.find(s => String(s.seatNo) === String(seatNo));
       
       if (existing && existing.isOccupied === true) {
         throw new Error('該座位已被選走，請選擇其他座位');
       }
       
       if (existing) {
         existing.isOccupied = true;
       } else {
         seats.push({ seatNo: Number(seatNo), isOccupied: true });
       }
       cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
       return { success: true };
     } else {
       // Normal DB flow
       seats = db_getSeatStatusByActivity_(activityCode);
       const existing = seats.find(s => String(s.seatNo) === String(seatNo));
       
       if (existing && existing.isOccupied === true) {
         throw new Error('該座位已被選走，請選擇其他座位');
       }
       
       db_updateSeatStatus_(activityCode, seatNo, { isOccupied: true });
       return { success: true };
     }
   } finally {
     lock.releaseLock();
   }
}

function studentClaimSeat(activityCode, seatNo) {
  const isGuest = String(activityCode).startsWith('G-');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    if (isGuest) {
      const cache = CacheService.getScriptCache();
      const actJson = cache.get('ACT_' + activityCode);
      const activity = actJson ? JSON.parse(actJson) : {};

      const seatsJson = cache.get('SEATS_' + activityCode);
      const seats = seatsJson ? JSON.parse(seatsJson) : [];
      const existing = seats.find(s => String(s.seatNo) === String(seatNo));
      if (activity.enableSeatLock && existing && existing.isOccupied === true) {
        throw new Error('Seat already in use');
      }

      if (existing) {
        existing.isOccupied = true;
      } else {
        seats.push({ seatNo: Number(seatNo), isOccupied: true });
      }
      cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
      return { success: true };
    }

    const activity = db_getActivityByCode_(activityCode);
    if (!activity) throw new Error('Activity not found');

    const seats = db_getSeatStatusByActivity_(activityCode);
    const existing = seats.find(s => String(s.seatNo) === String(seatNo));
    if (activity.enableSeatLock && existing && existing.isOccupied === true) {
      throw new Error('Seat already in use');
    }

    db_updateSeatStatus_(activityCode, seatNo, { isOccupied: true });
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function studentReleaseSeat(activityCode, seatNo) {
  if (!activityCode || !seatNo) return;
  if (String(activityCode).startsWith('G-')) {
     const lock = LockService.getScriptLock();
     if(lock.tryLock(5000)) {
         try {
             const cache = CacheService.getScriptCache();
             const seatsJson = cache.get('SEATS_' + activityCode);
             if (seatsJson) {
                 let seats = JSON.parse(seatsJson);
                 let seat = seats.find(s => String(s.seatNo) === String(seatNo));
                 if (seat) {
                     seat.isOccupied = false;
                     cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
                 }
             }
         } finally {
             lock.releaseLock();
         }
     }
     return;
  }
  db_updateSeatStatus_(activityCode, seatNo, { isOccupied: false });
}

function studentGetDashboard(activityCode) {
  if (String(activityCode).startsWith('G-')) {
      const cache = CacheService.getScriptCache();
      const actJson = cache.get('ACT_' + activityCode);
      const activity = actJson ? JSON.parse(actJson) : null;
      const count = activity ? activity.studentCount : 30; // fallback

      const seatsJson = cache.get('SEATS_' + activityCode);
      const cachedSeats = seatsJson ? JSON.parse(seatsJson) : [];
      
      const fullSeats = [];
      for (let i = 1; i <= count; i++) {
        const existing = cachedSeats.find(s => s.seatNo === i);
        if (existing) {
          fullSeats.push(existing);
        } else {
          fullSeats.push({
            activityCode: activityCode,
            seatNo: i,
            lightStatus: 'NONE',
            latestPhotoUrl: '',
            latestAiScore: '',
            latestAiSuggestion: '',
            lastSubmitAt: '',
            isOccupied: false,
            isHelpRequested: false
          });
        }
      }

      return { seats: fullSeats };
  }
  
  // Public read (limit info if needed, but spec says students see all)
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  
  const seats = db_getSeatStatusByActivity_(activityCode);
  return {
    seats: seats
  };
}

function studentGetHistory(activityCode, seatNo) {
  // Public read for student self-history
  // Reuses the logic from adminGetSeatHistory without admin check (or minimal check)
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  
  const submissions = db_getHistoryBySeat_(activityCode, seatNo);
  
  // Sort by uploadAt desc
  submissions.sort((a, b) => Number(b.uploadAt || 0) - Number(a.uploadAt || 0));
  return submissions;
}

function studentGetHistoryJson(activityCode, seatNo) {
  return JSON.stringify(studentGetHistory(activityCode, seatNo));
}

function studentUploadAndSubmit(payload) {
  /**
   * payload: {
   *   activityCode, className, seatNo,
   *   fileData: { mimeType, base64 }, // or just standard form param if we use webapp hack (but google.script.run is better with string)
   * }
   */
   
  const { activityCode, className, seatNo, fileData } = payload;
  
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  
  // 1. Upload to Drive
  // 1. Upload to Drive
  const folderId = Config_get('UPLOAD_FOLDER_ID');
  // If not set, maybe create one? Spec says must be set.
  if (!folderId) throw new Error('Server config error: UPLOAD_FOLDER_ID not set');
  
  // Time Check enforcement
  if (activity.isTimeLimited) {
      const now = Date.now();
      const start = activity.startTime;
      const end = start + (activity.limitHours * 3600000);
      if (now < start) throw new Error('活動尚未開始');
      if (now > end) throw new Error('活動已結束，無法上傳');
  }
  
  const folder = getWritableUploadFolderSafe_(folderId);
  const blob = Utilities.newBlob(Utilities.base64Decode(fileData.base64), fileData.mimeType, `upload.jpg`);
  const filename = `${activityCode}_S${seatNo}_${Date.now()}.jpg`;
  const uploadResult = createSharedUploadFileSafe_(folder, blob, filename);
  const file = uploadResult.file;
  const fileId = file.getId();
  // Use thumbnail link which is more reliable for <img> tags
  // sz=w1000 requests a width of 1000px
  const photoUrl = `https://drive.google.com/thumbnail?sz=w1000&id=${fileId}`;
  
  let score = '';
  let suggestion = '';
  let light = 'NONE';
  let debugRubricText = '';
  
  // 2. AI Eval
  if (activity.enableAI) {
    try {
      const aiResult = aiEvaluatePhoto_({
         fileId: fileId,
         activity: activity,
         className: className,
         seatNo: seatNo
      });
      score = aiResult.score;
      suggestion = aiResult.suggestion;
      debugRubricText = aiResult.debugRubricText;
      
      // 90~100 G, 80~89 Y, <80 R
      if (score >= 90) light = 'GREEN';
      else if (score >= 80) light = 'YELLOW';
      else light = 'RED';
      
    } catch (e) {
      suggestion = 'AI分析失敗，請稍後再試 (' + e.message + ')';
      light = 'NONE';
    }
  } else {
    // No AI, just upload
    light = 'NONE'; 
    suggestion = '已上傳，等待老師評分';
  }
  
  const now = Date.now();
  
  // 3. Write Submission
  db_appendSubmission_({
    submissionId: Utilities.getUuid(),
    activityCode,
    dateYMD: new Date().toLocaleDateString(),
    className,
    seatNo,
    photoUrl,
    lightStatus: light,
    aiScore: score,
    aiSuggestion: suggestion,
    uploadAt: now,
    updatedAt: now
  });
  
  // 4. Update SeatStatus
  db_updateSeatStatus_(activityCode, seatNo, {
    lightStatus: light,
    latestPhotoUrl: photoUrl,
    latestAiScore: score,
    latestAiSuggestion: suggestion,
    lastSubmitAt: now,
    updatedAt: now
  });
  
  const seat = db_getOneSeatStatus_(activityCode, seatNo);
  if (uploadResult.sharingWarning) {
    seat.uploadWarning = uploadResult.sharingWarning;
  }
  return seat;
}

function adminSubmitSeatPhoto(token, payload) {
  assertAdminByToken_(token);
  const { activityCode, className, seatNo, fileData } = payload;
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  const folderId = Config_get('UPLOAD_FOLDER_ID');
  if (!folderId) throw new Error('Server config error: UPLOAD_FOLDER_ID not set');

  const folder = getWritableUploadFolderSafe_(folderId);
  const blob = Utilities.newBlob(Utilities.base64Decode(fileData.base64), fileData.mimeType, 'upload.jpg');
  const filename = `${activityCode}_S${seatNo}_ADMIN_${Date.now()}.jpg`;
  const uploadResult = createSharedUploadFileSafe_(folder, blob, filename);
  const fileId = uploadResult.file.getId();
  const photoUrl = `https://drive.google.com/thumbnail?sz=w1000&id=${fileId}`;
  const oldSeat = db_getOneSeatStatus_(activityCode, seatNo) || {};
  const now = Date.now();

  const light = oldSeat.lightStatus || 'NONE';
  const suggestion = '老師已代傳照片（未執行 AI 分析）';

  db_appendSubmission_({
    submissionId: Utilities.getUuid(),
    activityCode,
    dateYMD: new Date().toLocaleDateString(),
    className,
    seatNo,
    photoUrl,
    lightStatus: light,
    aiScore: '',
    aiSuggestion: suggestion,
    uploadAt: now,
    updatedAt: now
  });
  db_updateSeatStatus_(activityCode, seatNo, {
    lightStatus: light,
    latestPhotoUrl: photoUrl,
    latestAiScore: '',
    latestAiSuggestion: suggestion,
    lastSubmitAt: now,
    updatedAt: now
  });
  const seat = db_getOneSeatStatus_(activityCode, seatNo);
  if (uploadResult.sharingWarning) seat.uploadWarning = uploadResult.sharingWarning;
  return seat;
}

function adminDeleteSeatPhoto(token, activityCode, seatNo) {
  assertAdminByToken_(token);
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  const seat = db_getOneSeatStatus_(activityCode, seatNo);
  if (!seat) throw new Error('Seat not found');
  db_updateSeatStatus_(activityCode, seatNo, {
    latestPhotoUrl: '',
    latestAiScore: '',
    latestAiSuggestion: '',
    lastSubmitAt: '',
    updatedAt: Date.now()
  });
  return db_getOneSeatStatus_(activityCode, seatNo);
}

function adminClearAllHelp(token, activityCode) {
  assertAdminByToken_(token);
  const seats = db_getSeatStatusByActivity_(activityCode);
  // Filter only those requesting help to minimize writes? 
  // db_updateSeatStatus_ is per row. Ideally we batch update.
  // Let's iterate and update those true.
  seats.forEach(s => {
      if(s.isHelpRequested === true || s.isHelpRequested === 'true') {
         db_updateSeatStatus_(activityCode, s.seatNo, { isHelpRequested: false });
      }
  });
  return { success: true };
}

function adminClearAllLights(token, activityCode) {
  assertAdminByToken_(token);
  db_batchClearAllLights_(activityCode);
  return { success: true };
}

function adminClearAllData(token, activityCode) {
  assertAdminByToken_(token);
  db_batchClearAllData_(activityCode);
  return { success: true };
}

function adminGuestClearAllHelp(activityCode) {
  const cache = CacheService.getScriptCache();
  const seatsJson = cache.get('SEATS_' + activityCode);
  if (!seatsJson) return { success: false, error: 'Activity not found' };
  
  let seats = JSON.parse(seatsJson);
  seats.forEach(s => {
      if(s.isHelpRequested === true || s.isHelpRequested === 'true') {
          s.isHelpRequested = false;
      }
  });
  cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
  return { success: true };
}

function adminGuestSetHelpStatus(activityCode, seatNo, isHelp) {
  const cache = CacheService.getScriptCache();
  const seatsJson = cache.get('SEATS_' + activityCode);
  if (!seatsJson) return { success: false, error: 'Activity not found' };
  
  let seats = JSON.parse(seatsJson);
  let seat = seats.find(s => String(s.seatNo) === String(seatNo));
  if (seat) {
      seat.isHelpRequested = !!isHelp;
      cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
  }
  return { success: true };
}

function adminGuestClearAllLights(activityCode) {
  const cache = CacheService.getScriptCache();
  const seatsJson = cache.get('SEATS_' + activityCode);
  if (!seatsJson) return { success: false, error: 'Activity not found' };
  
  let seats = JSON.parse(seatsJson);
  let changed = false;
  seats.forEach(s => {
      if(s.lightStatus && s.lightStatus !== 'NONE') {
          s.lightStatus = 'NONE';
          changed = true;
      }
  });
  if(changed) {
      cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
  }
  return { success: true };
}

function adminGuestClearAllData(activityCode) {
  const cache = CacheService.getScriptCache();
  const seatsJson = cache.get('SEATS_' + activityCode);
  if (!seatsJson) return { success: false, error: 'Activity not found' };
  
  let seats = JSON.parse(seatsJson);
  let changed = false;
  seats.forEach(s => {
      if(s.isOccupied) {
          s.lightStatus = 'NONE';
          s.latestPhotoUrl = '';
          s.latestAiScore = '';
          s.latestAiSuggestion = '';
          s.lastSubmitAt = '';
          s.isOccupied = false;
          changed = true;
      }
  });
  if(changed) {
      cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
  }
  return { success: true };
}

/* Guest Activities Specialized API */

function studentGuestUploadAndEval(payload) {
  // payload: { activityCode, className, seatNo, fileData: { mimeType, base64 } }
  const { activityCode, className, seatNo, fileData } = payload;
  
  const cache = CacheService.getScriptCache();
  const actJson = cache.get('ACT_' + activityCode);
  if (!actJson) throw new Error('活動已過期或無效');
  const activity = JSON.parse(actJson);
  
  // 1. Upload to Drive (Using Teacher's Folder)
  const folderId = activity.UPLOAD_FOLDER_ID;
  if (!folderId) throw new Error('伺服器設定錯誤: 未提供資料夾 ID');
  
  const folder = getWritableUploadFolderSafe_(folderId);
  const blob = Utilities.newBlob(Utilities.base64Decode(fileData.base64), fileData.mimeType, `upload.jpg`);
  const filename = `${activityCode}_S${seatNo}_${Date.now()}.jpg`;
  const uploadResult = createSharedUploadFileSafe_(folder, blob, filename);
  const file = uploadResult.file;
  const fileId = file.getId();
  const photoUrl = `https://drive.google.com/thumbnail?sz=w1000&id=${fileId}`;
  
  let score = '';
  let suggestion = '';
  let light = 'NONE';
  let debugRubricText = '';
  
  // 2. AI Eval (Using Teacher's API KEY overriding the global one just for this call)
  try {
     const aiResult = aiEvaluateGuestPhoto_({
         fileId: fileId,
         activity: activity,
         className: className,
         seatNo: seatNo,
         apiKey: activity.AI_API_KEY // Pass specific key
     });
     score = aiResult.score;
     suggestion = aiResult.suggestion;
     debugRubricText = aiResult.debugRubricText;
     
     if (score >= 90) light = 'GREEN';
     else if (score >= 80) light = 'YELLOW';
     else light = 'RED';
     
  } catch (e) {
     suggestion = 'AI分析失敗，請稍後再試 (' + e.message + ')';
     light = 'NONE';
  }
  
  const now = Date.now();

  db_appendSubmission_({
    submissionId: Utilities.getUuid(),
    activityCode: activityCode,
    dateYMD: new Date().toLocaleDateString(),
    className: className || activity.activityName || '',
    seatNo: seatNo,
    photoUrl: photoUrl,
    lightStatus: light,
    aiScore: score,
    aiSuggestion: suggestion,
    uploadAt: now,
    updatedAt: now
  });
  
  // Update Cache state for teacher monitoring
  const lock = LockService.getScriptLock();
  if(lock.tryLock(10000)) {
     try {
         const seatsJson = cache.get('SEATS_' + activityCode);
         let seats = seatsJson ? JSON.parse(seatsJson) : [];
         let seat = seats.find(s => String(s.seatNo) === String(seatNo));
         
         if (!seat) {
            seat = { seatNo: Number(seatNo), isOccupied: true };
            seats.push(seat);
         }
         
         // Update seat state
         seat.lightStatus = light;
         seat.latestPhotoUrl = photoUrl;
         seat.latestAiScore = score;
         seat.latestAiSuggestion = suggestion;
         seat.lastSubmitAt = now;
         seat.updatedAt = now;
         
         cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
     } finally {
         lock.releaseLock();
     }
  }
  
  // Return to frontend to save in localStorage (history array + current stats)
  return { 
     photoUrl, 
     aiScore: score, 
     aiSuggestion: suggestion, 
     lightStatus: light,
     debugRubricText: debugRubricText,
     uploadAt: now,
     uploadWarning: uploadResult.sharingWarning || ''
  };
}

function adminGuestSubmitSeatPhoto(payload) {
  const cache = CacheService.getScriptCache();
  const activityJson = cache.get('ACT_' + payload.activityCode);
  if (!activityJson) throw new Error('活動已過期或無效');
  const activity = JSON.parse(activityJson);
  const folderId = activity.UPLOAD_FOLDER_ID;
  if (!folderId) throw new Error('伺服器設定錯誤: 未提供資料夾 ID');

  const folder = getWritableUploadFolderSafe_(folderId);
  const blob = Utilities.newBlob(Utilities.base64Decode(payload.fileData.base64), payload.fileData.mimeType, 'upload.jpg');
  const filename = `${payload.activityCode}_S${payload.seatNo}_ADMIN_${Date.now()}.jpg`;
  const uploadResult = createSharedUploadFileSafe_(folder, blob, filename);
  const photoUrl = `https://drive.google.com/thumbnail?sz=w1000&id=${uploadResult.file.getId()}`;
  const seats = JSON.parse(cache.get('SEATS_' + payload.activityCode) || '[]');
  const seat = seats.find(item => Number(item.seatNo) === Number(payload.seatNo));
  if (!seat) throw new Error('找不到座位狀態');
  const now = Date.now();
  db_appendSubmission_({
    submissionId: Utilities.getUuid(),
    activityCode: payload.activityCode,
    dateYMD: new Date().toLocaleDateString(),
    className: payload.className || activity.activityName || '',
    seatNo: payload.seatNo,
    photoUrl: photoUrl,
    lightStatus: seat.lightStatus || 'NONE',
    aiScore: '',
    aiSuggestion: '老師已代傳照片（未執行 AI 分析）',
    uploadAt: now,
    updatedAt: now
  });
  seat.latestPhotoUrl = photoUrl;
  seat.latestAiScore = '';
  seat.latestAiSuggestion = '老師已代傳照片（未執行 AI 分析）';
  seat.lastSubmitAt = now;
  seat.updatedAt = now;
  cache.put('SEATS_' + payload.activityCode, JSON.stringify(seats), 21600);
  if (uploadResult.sharingWarning) seat.uploadWarning = uploadResult.sharingWarning;
  return seat;
}

function adminGuestDeleteSeatPhoto(activityCode, seatNo) {
  const cache = CacheService.getScriptCache();
  const actJson = cache.get('ACT_' + activityCode);
  const seatsJson = cache.get('SEATS_' + activityCode);
  if (!actJson || !seatsJson) throw new Error('活動已過期或無效');
  const seats = JSON.parse(seatsJson);
  const seat = seats.find(item => Number(item.seatNo) === Number(seatNo));
  if (!seat) throw new Error('找不到座位');
  seat.latestPhotoUrl = '';
  seat.latestAiScore = '';
  seat.latestAiSuggestion = '';
  seat.lastSubmitAt = '';
  seat.updatedAt = Date.now();
  cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
  return seat;
}

/* Analytics & Logging */
function api_logEvents(events) {
  try {
    if (!events || !Array.isArray(events) || events.length === 0) return { success: true };
    
    // We do not have req.ip in GAS, the IP is provided by the frontend payload
    // If Admin token is provided? Actually events are self-contained. 
    // To prevent abuse, we could validate them lightly here, but let's just write them.
    db_insertLogs_(events);
    return { success: true };
  } catch (err) {
    console.error('Failed to write logs: ', err);
    throw new Error('日誌寫入失敗：' + err.message);
  }
}


function studentSetHelpStatus(activityCode, seatNo, isHelp) {
  if (String(activityCode).startsWith('G-')) {
     const lock = LockService.getScriptLock();
     if(lock.tryLock(5000)) {
         try {
             const cache = CacheService.getScriptCache();
             const seatsJson = cache.get('SEATS_' + activityCode);
             if (seatsJson) {
                 let seats = JSON.parse(seatsJson);
                 let seat = seats.find(s => String(s.seatNo) === String(seatNo));
                 if (seat) {
                     seat.isHelpRequested = isHelp;
                     seat.updatedAt = Date.now();
                     cache.put('SEATS_' + activityCode, JSON.stringify(seats), 21600);
                 }
             }
         } finally {
             lock.releaseLock();
         }
     }
     return { success: true };
  }

  // Public endpoint for students
  // Ideally should verify active session or something, but current design relies on valid activityCode + seatNo
  db_updateSeatStatus_(activityCode, seatNo, { 
    isHelpRequested: isHelp,
    updatedAt: Date.now()
  });
  return { success: true };
}

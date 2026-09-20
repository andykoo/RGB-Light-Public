/** Db.gs - Spreadsheet CRUD + init */


const SHEET_NAMES = {
  ACTIVITIES: 'Activities',
  SUBMISSIONS: 'Submissions',
  SEAT_STATUS: 'SeatStatus',
  SYSTEM_CONFIG: 'SystemConfig',
  ADMINS: 'Admins',
  SESSIONS: 'Sessions',
  LOGS: 'Logs'
};

const HEADERS = {
  [SHEET_NAMES.ACTIVITIES]: [
    'activityId', 'activityName', 'activityCode', 'className',
    'studentCount', 'enableAI', 'enableSeatLock', 'rubric', 'isActive', 'createdAt', 'updatedAt',
    'isTimeLimited', 'startTime', 'limitHours'
  ],
  [SHEET_NAMES.SUBMISSIONS]: [
    'submissionId', 'activityCode', 'dateYMD', 'className', 'seatNo',
    'photoUrl', 'lightStatus', 'aiScore', 'aiSuggestion', 'uploadAt', 'updatedAt'
  ],
  [SHEET_NAMES.SEAT_STATUS]: [
    'activityCode', 'seatNo', 'lightStatus', 'latestPhotoUrl',
    'latestAiScore', 'latestAiSuggestion', 'lastSubmitAt', 'updatedAt', 'isOccupied', 'isHelpRequested',
    'itcLastCode', 'itcLastAt', 'itcTotal', 'itcCountsJson',
    'itcDayKey', 'itcDayTotal', 'itcDayCountsJson'
  ],
  [SHEET_NAMES.SYSTEM_CONFIG]: [
    'key', 'value', 'description', 'updatedAt'
  ],
  [SHEET_NAMES.ADMINS]: [
    'username', 'passwordHash', 'salt', 'isDefaultPassword', 'role', 'createdAt', 'updatedAt', 'lastLoginAt'
  ],
  [SHEET_NAMES.SESSIONS]: [
    'token', 'username', 'expiresAt', 'createdAt'
  ],
  [SHEET_NAMES.LOGS]: [
    'id', 'user_id', 'category', 'activity_id', 'activity_name',
    'student_count', 'event_type', 'payload', 'timestamp', 'local_time',
    'ip_address', 'device_info', 'created_at'
  ]
};

function db_getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const sid = props.getProperty('SPREADSHEET_ID');

  if (sid) return SpreadsheetApp.openById(sid);

  // If bound spreadsheet exists, use it; else create a new one
  try {
    return SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    const ss = SpreadsheetApp.create('CodeGym_DB');
    props.setProperty('SPREADSHEET_ID', ss.getId());
    return ss;
  }
}

function db_ensureSheetsAndHeaders_(sheetNames, headersMap) {
  const ss = db_getSpreadsheet_();

  for (const key in sheetNames) {
    const name = sheetNames[key];
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);

    const expected = headersMap[name];
    if (!expected) continue;

    // Ensure header row
    const lastCol = sh.getLastColumn();
    const current = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];

    if (current.length === 0 || current.filter(Boolean).length === 0) {
      sh.getRange(1, 1, 1, expected.length).setValues([expected]);
      sh.setFrozenRows(1);
      continue;
    }

    // If missing columns, append
    const existing = current.map(String);
    let changed = false;
    for (const h of expected) {
      if (existing.indexOf(h) === -1) {
        existing.push(h);
        changed = true;
      }
    }
    if (changed) {
      sh.getRange(1, 1, 1, existing.length).setValues([existing]);
      sh.setFrozenRows(1);
    }
  }
}

function db_getHeaderIndex_(sheet, headerName) {
  const row = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const idx = row.indexOf(headerName);
  return idx >= 0 ? idx + 1 : -1;
}

function db_readAll_(sheetName) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(sheetName);
  if (!sh) return [];

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  return values.map(r => rowToObj_(headers, r));
}

function rowToObj_(headers, row) {
  const o = {};
  headers.forEach((h, i) => (o[h] = row[i]));
  return o;
}

function objToRow_(headers, obj) {
  return headers.map(h => (obj[h] !== undefined ? obj[h] : ''));
}

function db_listActivities_() {
  const all = db_readAll_(SHEET_NAMES.ACTIVITIES);
  // sort by createdAt desc
  all.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return all;
}

function db_getActivityByCode_(activityCode) {
  const code = String(activityCode || '').trim();
  if (!code) return null;
  const all = db_readAll_(SHEET_NAMES.ACTIVITIES);
  const found = all.find(r => String(r.activityCode).trim() === code);
  if (!found) return null;

  // Normalize booleans
  found.enableAI = (found.enableAI === true || String(found.enableAI).toLowerCase() === 'true');
  found.enableSeatLock = (found.enableSeatLock === true || String(found.enableSeatLock).toLowerCase() === 'true');
  found.isActive = (found.isActive === true || String(found.isActive).toLowerCase() === 'true');
  found.studentCount = Number(found.studentCount || 0);

  // Normalize Time Limits
  found.isTimeLimited = (found.isTimeLimited === true || String(found.isTimeLimited).toLowerCase() === 'true');
  found.startTime = found.startTime ? Number(found.startTime) : 0;
  found.limitHours = found.limitHours ? Number(found.limitHours) : 0;

  return found;
}

function db_createActivity_(params) {
  // Ensure schema
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.ACTIVITIES);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);

  const now = Date.now();
  const activityCode = db_generateUniqueCode_();

  const activity = {
    activityId: Utilities.getUuid(),
    activityName: params.activityName,
    activityCode: activityCode,
    className: params.className || '',
    studentCount: Number(params.studentCount),
    enableAI: !!params.enableAI,
    enableSeatLock: !!params.enableSeatLock,
    rubric: params.rubric || '',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    // Time Limit Fields
    isTimeLimited: !!params.isTimeLimited,
    startTime: params.startTime ? Number(params.startTime) : 0,
    limitHours: params.limitHours ? Number(params.limitHours) : 0
  };

  sh.appendRow(objToRow_(headers, activity));

  // init SeatStatus 1..N
  db_initSeatStatus_(activityCode, Number(activity.studentCount));

  return activity;
}

function db_updateActivity_(activityCode, patch) {
  // Ensure schema (including rubric)
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);

  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.ACTIVITIES);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const idxCode = headers.indexOf('activityCode');
  if (idxCode < 0) return null;

  const data = sh.getDataRange().getValues();
  // Row 1 is header
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idxCode]).trim() === String(activityCode).trim()) {
      const rowNum = i + 1;
      const currentObj = rowToObj_(headers, data[i]);
      
      // Update fields
      if (patch.activityName !== undefined) currentObj.activityName = patch.activityName;
      if (patch.className !== undefined) currentObj.className = patch.className;
      if (patch.enableAI !== undefined) currentObj.enableAI = !!patch.enableAI;
      if (patch.enableSeatLock !== undefined) currentObj.enableSeatLock = !!patch.enableSeatLock;
      if (patch.rubric !== undefined) currentObj.rubric = patch.rubric;
      if (patch.isActive !== undefined) currentObj.isActive = !!patch.isActive;
      
      // Time Limit Updates
      if (patch.isTimeLimited !== undefined) currentObj.isTimeLimited = !!patch.isTimeLimited;
      if (patch.startTime !== undefined) currentObj.startTime = Number(patch.startTime);
      if (patch.limitHours !== undefined) currentObj.limitHours = Number(patch.limitHours);
      
      // Handle studentCount change
      if (patch.studentCount !== undefined) {
         const oldVal = Number(currentObj.studentCount || 0);
         const newVal = Number(patch.studentCount);
         currentObj.studentCount = newVal;
         
         // If increased, init new seats
         if (newVal > oldVal) {
             db_expandSeatStatus_(activityCode, oldVal, newVal);
         }
      }

      currentObj.updatedAt = Date.now();
      
      const newRow = objToRow_(headers, currentObj);
      sh.getRange(rowNum, 1, 1, newRow.length).setValues([newRow]);
      return currentObj;
    }
  }
  return null;
}

function db_expandSeatStatus_(activityCode, fromCount, toCount) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SEAT_STATUS);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const now = Date.now();
  const rows = [];
  
  for (let i = fromCount + 1; i <= toCount; i++) {
     // Check if seat already exists (sanity check)? 
     // db_findSeatRow_ is expensive in loop. 
     // For performance, we assume if we are strictly increasing count on a valid activity, seats > oldMax didn't exist.
     // But to be safe against manual tampering, maybe we should check.
     // However, simpler is to just append. 
     rows.push(
      objToRow_(headers, {
        activityCode: activityCode,
        seatNo: i,
        lightStatus: 'NONE',
        latestPhotoUrl: '',
        latestAiScore: '',
        latestAiSuggestion: '',
        lastSubmitAt: '',
        updatedAt: now,
      })
    );
  }
  
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function db_generateUniqueCode_() {
  // 6~8 chars, avoid O/0 I/1
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const len = 6;

  for (let tries = 0; tries < 50; tries++) {
    let code = '';
    for (let i = 0; i < len; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!db_getActivityByCode_(code)) return code;
  }
  // fallback
  return 'A' + Date.now().toString(36).toUpperCase().slice(-6);
}

function db_initSeatStatus_(activityCode, studentCount) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SEAT_STATUS);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);

  const now = Date.now();
  const rows = [];
  for (let i = 1; i <= studentCount; i++) {
    rows.push(
      objToRow_(headers, {
        activityCode: activityCode,
        seatNo: i,
        lightStatus: 'NONE',
        latestPhotoUrl: '',
        latestAiScore: '',
        latestAiSuggestion: '',
        lastSubmitAt: '',
        updatedAt: now,
      })
    );
  }

  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function db_getSeatStatusByActivity_(activityCode) {
  const code = String(activityCode || '').trim();
  const all = db_readAll_(SHEET_NAMES.SEAT_STATUS).filter(r => String(r.activityCode).trim() === code);

  all.sort((a, b) => Number(a.seatNo || 0) - Number(b.seatNo || 0));
  // normalize
  return all.map(r => ({
    activityCode: String(r.activityCode).trim(),
    seatNo: Number(r.seatNo || 0),
    lightStatus: String(r.lightStatus || 'NONE'),
    latestPhotoUrl: r.latestPhotoUrl || '',
    latestAiScore: (r.latestAiScore === '' ? null : Number(r.latestAiScore)),
    latestAiSuggestion: r.latestAiSuggestion || '',
    lastSubmitAt: r.lastSubmitAt === '' ? null : Number(r.lastSubmitAt),
    updatedAt: Number(r.updatedAt || 0),
    isOccupied: !!r.isOccupied,
    isHelpRequested: (r.isHelpRequested === true || String(r.isHelpRequested).toLowerCase() === 'true'),
    itcLastCode: String(r.itcLastCode || ''),
    itcLastAt: r.itcLastAt === '' ? null : Number(r.itcLastAt),
    itcTotal: Number(r.itcTotal || 0),
    itcCountsJson: String(r.itcCountsJson || '{}'),
    itcDayKey: String(r.itcDayKey || ''),
    itcDayTotal: Number(r.itcDayTotal || 0),
    itcDayCountsJson: String(r.itcDayCountsJson || '{}')
  }));
}

function db_getOneSeatStatus_(activityCode, seatNo) {
  const code = String(activityCode || '').trim();
  const sn = Number(seatNo);
  const seats = db_getSeatStatusByActivity_(code);
  return seats.find(s => s.seatNo === sn) || null;
}

function db_findSeatRow_(sheet, activityCode, seatNo) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return -1;

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const idxCode = headers.indexOf('activityCode');
  const idxSeat = headers.indexOf('seatNo');
  if (idxCode < 0 || idxSeat < 0) return -1;

  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (String(r[idxCode]).trim() === String(activityCode).trim() && Number(r[idxSeat]) === Number(seatNo)) {
      return i + 2; // actual row number
    }
  }
  return -1;
}

function db_updateSeatStatus_(activityCode, seatNo, patch) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SEAT_STATUS);
  const rowNo = db_findSeatRow_(sh, activityCode, seatNo);
  if (rowNo < 0) {
    // if missing (shouldn't), create it
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    const obj = {
      activityCode,
      seatNo,
      lightStatus: patch.lightStatus || 'NONE',
      latestPhotoUrl: patch.latestPhotoUrl || '',
      latestAiScore: patch.latestAiScore === null ? '' : (patch.latestAiScore ?? ''),
      latestAiSuggestion: patch.latestAiSuggestion || '',
      lastSubmitAt: patch.lastSubmitAt || '',
      updatedAt: patch.updatedAt || Date.now(),
    };
    sh.appendRow(objToRow_(headers, obj));
    return;
  }

  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const current = sh.getRange(rowNo, 1, 1, lastCol).getValues()[0];
  const obj = rowToObj_(headers, current);

  // apply patch
  for (const k in patch) {
    if (patch[k] === undefined) continue;
    obj[k] = patch[k] === null ? '' : patch[k];
  }

  sh.getRange(rowNo, 1, 1, lastCol).setValues([objToRow_(headers, obj)]);
}

function db_setSeatLight_(activityCode, seatNo, lightStatus, options) {
  // keepAi/keepPhoto decide whether to preserve existing info
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SEAT_STATUS);
  const rowNo = db_findSeatRow_(sh, activityCode, seatNo);
  if (rowNo < 0) return;

  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const current = sh.getRange(rowNo, 1, 1, lastCol).getValues()[0];
  const obj = rowToObj_(headers, current);

  obj.lightStatus = lightStatus;
  obj.updatedAt = Date.now();
  if (options && options.lastSubmitAt) obj.lastSubmitAt = options.lastSubmitAt;

  // keep existing photo/ai by default
  sh.getRange(rowNo, 1, 1, lastCol).setValues([objToRow_(headers, obj)]);
}

function db_batchSetSeatLight_(activityCode, seatNos, lightStatus) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SEAT_STATUS);

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const idxCode = headers.indexOf('activityCode');
  const idxSeat = headers.indexOf('seatNo');
  const idxLight = headers.indexOf('lightStatus');
  const idxUpdated = headers.indexOf('updatedAt');
  if (idxCode < 0 || idxSeat < 0 || idxLight < 0 || idxUpdated < 0) return;

  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const set = new Set(seatNos.map(Number));
  const now = Date.now();

  let changed = false;
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    if (String(r[idxCode]).trim() !== String(activityCode).trim()) continue;
    const sn = Number(r[idxSeat]);
    if (!set.has(sn)) continue;

    r[idxLight] = lightStatus;
    r[idxUpdated] = now;
    changed = true;
  }

  if (changed) {
    sh.getRange(2, 1, values.length, lastCol).setValues(values);
  }
}

function db_batchClearAllLights_(activityCode) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SEAT_STATUS);

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const idxCode = headers.indexOf('activityCode');
  const idxLight = headers.indexOf('lightStatus');
  const idxUpdated = headers.indexOf('updatedAt');
  
  if (idxCode < 0 || idxLight < 0 || idxUpdated < 0) return;

  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const now = Date.now();
  let changed = false;

  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    if (String(r[idxCode]).trim() !== String(activityCode).trim()) continue;

    if (r[idxLight] !== 'NONE') {
        r[idxLight] = 'NONE';
        r[idxUpdated] = now;
        changed = true;
    }
  }

  if (changed) {
    sh.getRange(2, 1, values.length, lastCol).setValues(values);
  }
}

function db_batchClearAllData_(activityCode) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SEAT_STATUS);

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const idxCode = headers.indexOf('activityCode');
  const idxOcc = headers.indexOf('isOccupied');
  const idxLight = headers.indexOf('lightStatus');
  const idxPhoto = headers.indexOf('latestPhotoUrl');
  const idxScore = headers.indexOf('latestAiScore');
  const idxSugg = headers.indexOf('latestAiSuggestion');
  const idxSubm = headers.indexOf('lastSubmitAt');
  const idxUpdated = headers.indexOf('updatedAt');
  
  if (idxCode < 0 || idxOcc < 0) return;

  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const now = Date.now();
  let changed = false;

  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    if (String(r[idxCode]).trim() !== String(activityCode).trim()) continue;

    if (r[idxOcc] === true || String(r[idxOcc]).toLowerCase() === 'true') {
        r[idxLight] = 'NONE';
        r[idxPhoto] = '';
        r[idxScore] = '';
        r[idxSugg] = '';
        r[idxSubm] = '';
        r[idxOcc] = false;
        r[idxUpdated] = now;
        changed = true;
    }
  }

  if (changed) {
    sh.getRange(2, 1, values.length, lastCol).setValues(values);
  }
}



function db_getSubmissionRecords_() {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SUBMISSIONS);
  if (!sh || sh.getLastRow() < 2 || sh.getLastColumn() < 1) return [];

  const lastCol = sh.getLastColumn();
  const rawHeaders = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const normalizedHeaders = rawHeaders.map(function(header) {
    return String(header == null ? '' : header).replace(/^\uFEFF/, '').trim().toLowerCase();
  });
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();
  const expectedHeaders = HEADERS[SHEET_NAMES.SUBMISSIONS];

  function readField_(row, fieldName) {
    const normalizedName = String(fieldName).toLowerCase();
    const candidateIndexes = [];
    normalizedHeaders.forEach(function(header, index) {
      if (header === normalizedName) candidateIndexes.push(index);
    });
    for (let i = 0; i < candidateIndexes.length; i++) {
      const value = row[candidateIndexes[i]];
      if (value !== '' && value != null) return value;
    }
    const standardIndex = expectedHeaders.indexOf(fieldName);
    return standardIndex >= 0 && standardIndex < row.length ? row[standardIndex] : '';
  }

  return values.map(function(row) {
    const record = {};
    expectedHeaders.forEach(function(fieldName) {
      record[fieldName] = readField_(row, fieldName);
    });
    return record;
  });
}

function db_getHistoryByActivity_(activityCode) {
  const targetCode = String(activityCode || '').trim().toUpperCase();
  return db_getSubmissionRecords_().filter(function(record) {
    return String(record.activityCode || '').trim().toUpperCase() === targetCode;
  });
}

function db_getHistoryBySeat_(activityCode, seatNo) {
  const targetSeat = String(seatNo || '').trim();
  const all = db_getHistoryByActivity_(activityCode);

  return all.filter(function(r) {
    const rSeat = String(r.seatNo || '').trim();
    const seatMatches = rSeat === targetSeat || (
      Number.isFinite(Number(rSeat)) && Number.isFinite(Number(targetSeat)) && Number(rSeat) === Number(targetSeat)
    );
    return seatMatches;
  });
}

function db_appendSubmission_(submission) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SUBMISSIONS);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.appendRow(objToRow_(headers, submission));
}

/* SystemConfig CRUD */

function db_initSystemConfig_() {
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  
  // Pre-populate if empty
  const all = db_readAll_(SHEET_NAMES.SYSTEM_CONFIG);
  if (all.length === 0) {
    const defaults = [
      { key: 'ADMIN_EMAILS', value: '', description: 'Comma separated emails' },
      { key: 'AI_PROVIDER', value: 'OPENAI', description: 'OPENAI or GEMINI' },
      { key: 'AI_API_KEY', value: '', description: 'API Key' },
      { key: 'UPLOAD_FOLDER_ID', value: '', description: 'Drive Folder ID for uploads' }
    ];
    
    defaults.forEach(d => db_setSystemConfig_(d.key, d.value, d.description));
  }
}

function db_getSystemConfig_(key) {
  // Cache could be added here if performance is an issue, but for now direct read
  const all = db_readAll_(SHEET_NAMES.SYSTEM_CONFIG);
  const found = all.find(r => r.key === key);
  return found ? found.value : null;
}

function db_getAllSystemConfigs_() {
  const all = db_readAll_(SHEET_NAMES.SYSTEM_CONFIG);
  const result = {};
  all.forEach(r => {
    result[r.key] = r.value;
  });
  return result;
}

function db_setSystemConfig_(key, value, description) {
  const ss = db_getSpreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAMES.SYSTEM_CONFIG);
  
  if (!sh) {
    db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
    sh = ss.getSheetByName(SHEET_NAMES.SYSTEM_CONFIG);
  }
  
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const idxKey = headers.indexOf('key');
  
  if (idxKey < 0) return; // Should not happen if ensured
  
  const lastRow = sh.getLastRow();
  let rowNo = -1;
  
  // Find existing
  if (lastRow > 1) {
    const data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (let i = 0; i < data.length; i++) {
      if (data[i][idxKey] === key) {
        rowNo = i + 2;
        break;
      }
    }
  }
  
  const timestamp = Date.now();
  
  if (rowNo > 0) {
    // Update
    const current = sh.getRange(rowNo, 1, 1, lastCol).getValues()[0];
    const obj = rowToObj_(headers, current);
    obj.value = value;
    obj.updatedAt = timestamp;
    if (description) obj.description = description;
    
    sh.getRange(rowNo, 1, 1, lastCol).setValues([objToRow_(headers, obj)]);
  } else {
    // Insert
    const obj = {
      key: key,
      value: value,
      description: description || '',
      updatedAt: timestamp
    };
    sh.appendRow(objToRow_(headers, obj));
  }
}

/* Admins CRUD */

function db_initAdmins_() {
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  
  const all = db_readAll_(SHEET_NAMES.ADMINS);
  if (all.length === 0) {
    // Default: admin / admin1234
    // We need Auth.gs helper to hash, but DB layer should be unaware of exact hash logic if possible?
    // Actually, to avoid circular deps, let's just expose a raw create method and let Auth call it.
    // BUT user asked for default creation here. 
    // We will leave this EMPTY or simple implementation and let Auth.gs handle the actual creation logic 
    // or we'll simply check in Auth.gs if DB is empty.
    // Let's implement db_countAdmins_() so Auth can check.
  }
}

function db_countAdmins_() {
  const all = db_readAll_(SHEET_NAMES.ADMINS);
  return all.length;
}

function db_getAdmin_(username) {
  const uname = String(username || '').trim().toLowerCase();
  const all = db_readAll_(SHEET_NAMES.ADMINS);
  return all.find(r => String(r.username).trim().toLowerCase() === uname) || null;
}

function db_listAdmins_() {
  return db_readAll_(SHEET_NAMES.ADMINS).map(r => r.username);
}

function db_createAdmin_(data) {
  // data: { username, passwordHash, salt, isDefaultPassword, role }
  const ss = db_getSpreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAMES.ADMINS);
  if (!sh) { db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS); sh = ss.getSheetByName(SHEET_NAMES.ADMINS); }
  
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const now = Date.now();
  
  const obj = {
    username: data.username.trim(), 
    passwordHash: data.passwordHash,
    salt: data.salt,
    isDefaultPassword: !!data.isDefaultPassword,
    role: data.role || 'ADMIN', // Default to normal ADMIN
    createdAt: now,
    updatedAt: now,
    lastLoginAt: ''
  };
  
  sh.appendRow(objToRow_(headers, obj));
  return obj;
}

function db_updateAdmin_(username, patch) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.ADMINS);
  const uname = String(username).trim().toLowerCase();
  
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const idxUser = headers.indexOf('username');
  if (idxUser < 0) return null;
  
  const data = sh.getDataRange().getValues();
  // Row 1 header
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idxUser]).trim().toLowerCase() === uname) {
      const rowNum = i + 1;
      const current = rowToObj_(headers, data[i]);
      
      // Patch
      if (patch.passwordHash !== undefined) current.passwordHash = patch.passwordHash;
      if (patch.salt !== undefined) current.salt = patch.salt;
      if (patch.isDefaultPassword !== undefined) current.isDefaultPassword = patch.isDefaultPassword;
      if (patch.role !== undefined) current.role = patch.role;
      if (patch.lastLoginAt !== undefined) current.lastLoginAt = patch.lastLoginAt;
      current.updatedAt = Date.now();
      
      sh.getRange(rowNum, 1, 1, lastCol).setValues([objToRow_(headers, current)]);
      return current;
    }
  }
  return null;
}

function db_deleteAdmin_(username) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.ADMINS);
  const uname = String(username).trim().toLowerCase();
  
  const idxUser = db_getHeaderIndex_(sh, 'username') - 1;
  const data = sh.getDataRange().getValues();
  
  // Reverse to delete safely
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idxUser]).trim().toLowerCase() === uname) {
       sh.deleteRow(i + 1);
       return true;
    }
  }
  return false;
}

/* Sessions CRUD */

function db_createSession_(token, username) {
  const ss = db_getSpreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAMES.SESSIONS);
  if (!sh) { db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS); sh = ss.getSheetByName(SHEET_NAMES.SESSIONS); }
  
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const now = Date.now();
  // Expires in 24 hours
  const expiresAt = now + (24 * 60 * 60 * 1000);
  
  const obj = {
    token: token,
    username: username,
    expiresAt: expiresAt,
    createdAt: now
  };
  
  sh.appendRow(objToRow_(headers, obj));
  return obj;
}

function db_getSession_(token) {
  const all = db_readAll_(SHEET_NAMES.SESSIONS);
  const found = all.find(r => r.token === token);
  if (!found) return null;
  
  // Check if expired
  if (Number(found.expiresAt) < Date.now()) {
    // Lazy delete? or just return null
    // db_deleteSession_(token); // Optional: cleanup
    return null;
  }
  return found;
}

function db_deleteSession_(token) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SESSIONS);
  const idxToken = db_getHeaderIndex_(sh, 'token') - 1;
  
  const data = sh.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
     if (data[i][idxToken] === token) {
       sh.deleteRow(i + 1);
     }
  }
}

function db_deleteSessionsByUser_(username) {
  const ss = db_getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAMES.SESSIONS);
  const uname = String(username).trim().toLowerCase();
  const idxUser = db_getHeaderIndex_(sh, 'username') - 1;
  
  const data = sh.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
     if (String(data[i][idxUser]).trim().toLowerCase() === uname) {
       sh.deleteRow(i + 1);
     }
  }
}

function db_insertLogs_(events) {
  if (!events || events.length === 0) return;
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  
  const ss = db_getSpreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAMES.LOGS);
  if (!sh) return;
  
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const rows = [];
  const now = Date.now();
  
  events.forEach(e => {
    rows.push(objToRow_(headers, {
      id: Utilities.getUuid(),
      user_id: e.user_id || '',
      category: e.category || 'guest',
      activity_id: e.activity_id || '',
      activity_name: e.activity_name || '',
      student_count: e.student_count || 0,
      event_type: e.event_type || 'unknown',
      payload: e.payload || '',
      timestamp: e.timestamp || '',
      local_time: e.local_time || '',
      ip_address: e.ip_address || '',
      device_info: e.device_info || '',
      created_at: now
    }));
  });
  
  if (rows.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  }
}

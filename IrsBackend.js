/** IrsBackend.gs - Immediate Response System */

const IRS_CACHE_TTL_SEC = 21600;
const IRS_RESPONSE_TYPES = ['choice', 'text'];
const IRS_OPTIONS = ['A', 'B', 'C', 'D'];
const IRS_STATE_PROPERTY_PREFIX = 'IRS_STATE_META_';
const IRS_RESPONSE_PROPERTY_PREFIX = 'IRS_STATE_RESPONSE_';

function irsCacheKey_(activityCode) {
  return 'IRS_STATE_' + String(activityCode || '').trim().toUpperCase();
}

function irsStateMetaKey_(activityCode) {
  return IRS_STATE_PROPERTY_PREFIX + String(activityCode || '').trim().toUpperCase();
}

function irsStateResponseKey_(activityCode, seatNo) {
  return IRS_RESPONSE_PROPERTY_PREFIX + String(activityCode || '').trim().toUpperCase() + '_' + Number(seatNo || 0);
}

function irsReadDurableState_(activityCode) {
  const code = String(activityCode || '').trim().toUpperCase();
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(irsStateMetaKey_(code));
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) || {};
    const seats = Array.isArray(meta.responseSeats) ? meta.responseSeats : [];
    const updatedAt = Number(meta.updatedAt || 0);
    if (updatedAt && Date.now() - updatedAt > IRS_CACHE_TTL_SEC * 1000) {
      seats.forEach(function(seatNo) { props.deleteProperty(irsStateResponseKey_(code, seatNo)); });
      props.deleteProperty(irsStateMetaKey_(code));
      return null;
    }
    delete meta.responseSeats;
    meta.activityCode = code;
    meta.responses = {};
    seats.forEach(function(seatNo) {
      const responseRaw = props.getProperty(irsStateResponseKey_(code, seatNo));
      if (!responseRaw) return;
      try {
        const response = JSON.parse(responseRaw);
        if (response && Number(response.seatNo || 0)) meta.responses[String(Number(response.seatNo))] = response;
      } catch (err) {
        // Ignore one damaged response while preserving the current question.
      }
    });
    return meta;
  } catch (err) {
    return null;
  }
}

function irsWriteDurableState_(state) {
  const code = String(state && state.activityCode || '').trim().toUpperCase();
  if (!code) return;
  const props = PropertiesService.getScriptProperties();
  const metaKey = irsStateMetaKey_(code);
  let previousSeats = [];
  try {
    const previousMeta = JSON.parse(props.getProperty(metaKey) || '{}');
    previousSeats = Array.isArray(previousMeta.responseSeats) ? previousMeta.responseSeats : [];
  } catch (err) {
    previousSeats = [];
  }

  const responses = state.responses && typeof state.responses === 'object' ? state.responses : {};
  const responseSeats = Object.keys(responses).map(Number).filter(function(seatNo) { return seatNo > 0; });
  const currentSeatSet = {};
  responseSeats.forEach(function(seatNo) { currentSeatSet[String(seatNo)] = true; });
  previousSeats.forEach(function(seatNo) {
    if (!currentSeatSet[String(Number(seatNo))]) props.deleteProperty(irsStateResponseKey_(code, seatNo));
  });

  if (!state.questionId && state.status === 'idle') {
    props.deleteProperty(metaKey);
    return;
  }

  const meta = Object.assign({}, state, { responses: undefined, responseSeats: responseSeats });
  const values = {};
  values[metaKey] = JSON.stringify(meta);
  responseSeats.forEach(function(seatNo) {
    values[irsStateResponseKey_(code, seatNo)] = JSON.stringify(responses[String(seatNo)]);
  });
  props.setProperties(values, false);
}

function irsAssertActivity_(activityCode) {
  const code = String(activityCode || '').trim().toUpperCase();
  if (!code) throw new Error('Activity code is required');
  if (code.startsWith('G-')) {
    const raw = CacheService.getScriptCache().get('ACT_' + code);
    if (!raw) throw new Error('臨時活動代碼無效或已過期');
    return JSON.parse(raw) || {};
  }
  const activity = db_getActivityByCode_(code);
  if (!activity) throw new Error('Activity not found');
  return activity;
}

function irsReadState_(activityCode) {
  const code = String(activityCode || '').trim().toUpperCase();
  const raw = CacheService.getScriptCache().get(irsCacheKey_(code));
  if (raw) {
    try {
      const state = JSON.parse(raw) || {};
      state.activityCode = code;
      state.responses = state.responses && typeof state.responses === 'object' ? state.responses : {};
      if (!PropertiesService.getScriptProperties().getProperty(irsStateMetaKey_(code))) irsWriteDurableState_(state);
      return state;
    } catch (err) {
      // Fall through to durable storage.
    }
  }
  const durable = irsReadDurableState_(code);
  if (!durable) return irsEmptyState_(code);
  CacheService.getScriptCache().put(irsCacheKey_(code), JSON.stringify(durable), IRS_CACHE_TTL_SEC);
  return durable;
}

function irsEmptyState_(activityCode) {
  return {
    activityCode: String(activityCode || '').trim().toUpperCase(),
    questionId: '',
    prompt: '',
    responseType: 'choice',
    correctOption: '',
    status: 'idle',
    responses: {},
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    stoppedAt: 0,
    publishedAt: 0
  };
}

function irsWriteState_(state) {
  state.updatedAt = Date.now();
  CacheService.getScriptCache().put(irsCacheKey_(state.activityCode), JSON.stringify(state), IRS_CACHE_TTL_SEC);
  irsWriteDurableState_(state);
  return state;
}

function irsParsePayload_(value) {
  if (value && typeof value === 'object') return Object.assign({}, value);
  try {
    return JSON.parse(String(value || '{}')) || {};
  } catch (err) {
    return {};
  }
}

function irsBackupEventKey_(event) {
  const payload = irsParsePayload_(event && event.payload);
  const sourceId = String((event && event.sourceEventId) || payload._backupEventId || (event && event.id) || '').trim();
  if (sourceId) return 'id:' + sourceId;
  return [
    String(event && (event.eventType || event.event_type) || ''),
    String(payload.questionId || ''),
    String(event && (event.userId || event.user_id) || ''),
    String(event && event.timestamp || ''),
    String(payload.answer == null ? '' : payload.answer),
    String(payload.attemptNo || '')
  ].join('|');
}

function irsExportBackup_(activityCode) {
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  const code = String(activityCode || '').trim().toUpperCase();
  const events = db_readAll_(SHEET_NAMES.LOGS).filter(function(row) {
    return String(row.activity_id || '').trim().toUpperCase() === code && String(row.event_type || '').indexOf('irs_') === 0;
  }).map(function(row) {
    const payload = irsParsePayload_(row.payload);
    return {
      sourceEventId: String(payload._backupEventId || row.id || ''),
      userId: String(row.user_id || ''),
      category: String(row.category || ''),
      activityName: String(row.activity_name || ''),
      studentCount: Number(row.student_count || 0),
      eventType: String(row.event_type || ''),
      payload: payload,
      timestamp: String(row.timestamp || ''),
      localTime: String(row.local_time || ''),
      createdAt: Number(row.created_at || 0)
    };
  });
  const current = irsReadState_(code);
  return {
    version: '1.0',
    currentState: {
      questionId: String(current.questionId || ''),
      prompt: String(current.prompt || ''),
      responseType: String(current.responseType || 'choice'),
      correctOption: String(current.correctOption || ''),
      status: String(current.status || 'idle'),
      responses: current.responses && typeof current.responses === 'object' ? current.responses : {},
      createdAt: Number(current.createdAt || 0),
      updatedAt: Number(current.updatedAt || 0),
      startedAt: Number(current.startedAt || 0),
      stoppedAt: Number(current.stoppedAt || 0),
      publishedAt: Number(current.publishedAt || 0)
    },
    events: events
  };
}

function irsRestoreCurrentState_(rawState, activityCode) {
  if (!rawState || typeof rawState !== 'object') return false;
  const code = String(activityCode || '').trim().toUpperCase();
  const existing = irsReadState_(code);
  const incomingQuestionId = String(rawState.questionId || '');
  const existingQuestionId = String(existing.questionId || '');
  const incomingUpdatedAt = Number(rawState.updatedAt || 0);
  const existingUpdatedAt = Number(existing.updatedAt || 0);
  if (existingQuestionId && (existingQuestionId !== incomingQuestionId || existingUpdatedAt > incomingUpdatedAt)) return false;
  const restored = irsEmptyState_(code);
  restored.questionId = incomingQuestionId;
  restored.prompt = String(rawState.prompt || '').trim().slice(0, 200);
  restored.responseType = IRS_RESPONSE_TYPES.indexOf(String(rawState.responseType || '')) >= 0
    ? String(rawState.responseType)
    : 'choice';
  restored.correctOption = restored.responseType === 'choice' && IRS_OPTIONS.indexOf(String(rawState.correctOption || '').toUpperCase()) >= 0
    ? String(rawState.correctOption).toUpperCase()
    : '';
  restored.createdAt = Number(rawState.createdAt || 0);
  restored.startedAt = Number(rawState.startedAt || 0);
  restored.stoppedAt = Number(rawState.stoppedAt || 0);
  restored.publishedAt = Number(rawState.publishedAt || 0);
  restored.responses = {};
  const responseSource = rawState.responses && typeof rawState.responses === 'object' ? rawState.responses : {};
  Object.keys(responseSource).forEach(function(key) {
    const source = responseSource[key] || {};
    const seatNo = Number(source.seatNo || key || 0);
    if (!seatNo || seatNo > 60) return;
    const answer = String(source.answer == null ? '' : source.answer).trim().slice(0, 50);
    if (!answer) return;
    restored.responses[String(seatNo)] = {
      seatNo: seatNo,
      answer: restored.responseType === 'choice' ? answer.toUpperCase() : answer,
      submittedAt: Number(source.submittedAt || 0),
      attemptNo: Math.max(1, Number(source.attemptNo || 1))
    };
  });
  if (!restored.questionId) {
    restored.status = 'idle';
  } else if (String(rawState.status || '') === 'draft' || !restored.startedAt) {
    restored.status = 'draft';
  } else {
    restored.status = 'stopped';
    restored.stoppedAt = restored.stoppedAt || Date.now();
  }
  irsWriteState_(restored);
  return true;
}

function irsRestoreBackup_(backup, activityCode) {
  if (!backup || typeof backup !== 'object') return { restoredEvents: 0, skippedEvents: 0, restoredState: false };
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  const code = String(activityCode || '').trim().toUpperCase();
  const existing = db_readAll_(SHEET_NAMES.LOGS).filter(function(row) {
    return String(row.activity_id || '').trim().toUpperCase() === code && String(row.event_type || '').indexOf('irs_') === 0;
  });
  const known = {};
  existing.forEach(function(row) {
    const payload = irsParsePayload_(row.payload);
    const rowId = String(row.id || '').trim();
    const backupId = String(payload._backupEventId || '').trim();
    if (rowId) known['id:' + rowId] = true;
    if (backupId) known['id:' + backupId] = true;
    known[irsBackupEventKey_(row)] = true;
  });

  let skipped = 0;
  const rows = (Array.isArray(backup.events) ? backup.events : []).map(function(event) {
    const eventType = String(event && (event.eventType || event.event_type) || '');
    if (eventType.indexOf('irs_') !== 0) return null;
    const key = irsBackupEventKey_(event);
    if (known[key]) {
      skipped += 1;
      return null;
    }
    known[key] = true;
    const payload = irsParsePayload_(event.payload);
    const sourceEventId = String(event.sourceEventId || event.id || payload._backupEventId || '').trim();
    if (sourceEventId) payload._backupEventId = sourceEventId;
    return {
      user_id: String(event.userId || event.user_id || ''),
      category: String(event.category || (String(event.userId || event.user_id || '').indexOf('seat_') === 0 ? 'student' : (code.startsWith('G-') ? 'guest_admin' : 'admin'))),
      activity_id: code,
      activity_name: String(event.activityName || event.activity_name || ''),
      student_count: Number(event.studentCount || event.student_count || 0),
      event_type: eventType,
      payload: JSON.stringify(payload),
      timestamp: String(event.timestamp || ''),
      local_time: String(event.localTime || event.local_time || '')
    };
  }).filter(function(row) { return Boolean(row); });
  if (rows.length) db_insertLogs_(rows);
  return {
    restoredEvents: rows.length,
    skippedEvents: skipped,
    restoredState: irsRestoreCurrentState_(backup.currentState, code)
  };
}

function irsLog_(activity, activityCode, eventType, payload, seatNo) {
  db_insertLogs_([{
    user_id: seatNo ? 'seat_' + Number(seatNo) : 'teacher',
    category: seatNo ? 'student' : (String(activityCode).startsWith('G-') ? 'guest_admin' : 'admin'),
    activity_id: activityCode,
    activity_name: activity.activityName || '',
    student_count: Number(activity.studentCount || 0),
    event_type: eventType,
    payload: JSON.stringify(payload || {}),
    timestamp: new Date().toISOString(),
    local_time: ''
  }]);
}

function irsNormalizeQuestion_(payload) {
  const src = payload || {};
  const responseType = IRS_RESPONSE_TYPES.indexOf(String(src.responseType || '')) >= 0 ? String(src.responseType) : 'choice';
  const prompt = String(src.prompt || '').trim().slice(0, 200) || '快速口頭題（請聽老師說明）';
  const correctOption = responseType === 'choice' && IRS_OPTIONS.indexOf(String(src.correctOption || '').toUpperCase()) >= 0
    ? String(src.correctOption).toUpperCase()
    : '';
  return { prompt: prompt, responseType: responseType, correctOption: correctOption };
}

function irsSaveQuestion_(activityCode, payload) {
  const activity = irsAssertActivity_(activityCode);
  const code = String(activityCode).trim().toUpperCase();
  const clean = irsNormalizeQuestion_(payload);
  const state = irsReadState_(code);
  const typeChanged = state.responseType !== clean.responseType;
  state.questionId = state.questionId || Utilities.getUuid();
  state.prompt = clean.prompt;
  state.responseType = clean.responseType;
  state.correctOption = clean.correctOption;
  state.status = state.status === 'idle' ? 'draft' : state.status;
  state.createdAt = state.createdAt || Date.now();
  if (typeChanged) state.responses = {};
  irsWriteState_(state);
  irsLog_(activity, code, 'irs_question_saved', {
    questionId: state.questionId,
    prompt: state.prompt,
    responseType: state.responseType,
    correctOption: state.correctOption
  });
  return irsAdminView_(state, activity);
}

function irsSetStatus_(activityCode, action) {
  const activity = irsAssertActivity_(activityCode);
  const code = String(activityCode).trim().toUpperCase();
  const state = irsReadState_(code);
  const now = Date.now();
  const cmd = String(action || '').toLowerCase();
  if (cmd === 'start') {
    if (!state.prompt) throw new Error('請先建立題目');
    state.questionId = Utilities.getUuid();
    state.responses = {};
    state.status = 'active';
    state.startedAt = now;
    state.stoppedAt = 0;
    state.publishedAt = 0;
  } else if (cmd === 'stop') {
    if (state.status !== 'active') throw new Error('目前沒有進行中的 IRS 題目');
    state.status = 'stopped';
    state.stoppedAt = now;
  } else if (cmd === 'publish') {
    if (state.status === 'idle' || state.status === 'draft') throw new Error('題目尚未開始');
    state.status = 'published';
    state.publishedAt = now;
  } else if (cmd === 'clear') {
    Object.assign(state, irsEmptyState_(code));
  } else {
    throw new Error('Unknown IRS action');
  }
  irsWriteState_(state);
  irsLog_(activity, code, 'irs_' + cmd, {
    questionId: state.questionId,
    prompt: state.prompt,
    responseType: state.responseType,
    correctOption: state.correctOption,
    responseCount: Object.keys(state.responses || {}).length
  });
  return irsAdminView_(state, activity);
}

function irsAdminView_(state, activity) {
  const responses = Object.keys(state.responses || {}).map(key => state.responses[key]);
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  responses.forEach(item => {
    const answer = String(item.answer || '').toUpperCase();
    if (counts.hasOwnProperty(answer)) counts[answer] += 1;
  });
  return {
    activityCode: state.activityCode,
    questionId: state.questionId,
    prompt: state.prompt,
    responseType: state.responseType,
    correctOption: state.correctOption,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    publishedAt: state.publishedAt,
    studentCount: Number(activity.studentCount || 0),
    answeredCount: responses.length,
    counts: counts,
    responses: responses.sort((a, b) => Number(a.seatNo || 0) - Number(b.seatNo || 0))
  };
}

function irsStudentView_(state, seatNo) {
  const own = (state.responses || {})[String(Number(seatNo || 0))] || null;
  const published = state.status === 'published';
  const publicCounts = { A: 0, B: 0, C: 0, D: 0 };
  const responseItems = Object.keys(state.responses || {}).map(function(key) { return state.responses[key]; });
  if (published && state.responseType === 'choice') {
    responseItems.forEach(function(item) {
      const option = String(item.answer || '').toUpperCase();
      if (Object.prototype.hasOwnProperty.call(publicCounts, option)) publicCounts[option] += 1;
    });
  }
  return {
    questionId: state.questionId,
    prompt: state.prompt,
    responseType: state.responseType,
    status: state.status,
    ownResponse: own,
    answeredCount: published ? responseItems.length : 0,
    counts: published && state.responseType === 'choice' ? publicCounts : null,
    correctOption: published ? state.correctOption : '',
    isCorrect: published && own && state.responseType === 'choice' && state.correctOption
      ? String(own.answer || '') === String(state.correctOption)
      : null
  };
}

function irsSubmitResponse_(activityCode, seatNo, answer) {
  const activity = irsAssertActivity_(activityCode);
  const code = String(activityCode).trim().toUpperCase();
  const seat = Number(seatNo || 0);
  if (!seat || seat > Number(activity.studentCount || 0)) throw new Error('座號無效');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const state = irsReadState_(code);
    if (state.status !== 'active') throw new Error('老師目前沒有開放作答');
    let cleanAnswer = String(answer == null ? '' : answer).trim();
    if (state.responseType === 'choice') {
      cleanAnswer = cleanAnswer.toUpperCase();
      if (IRS_OPTIONS.indexOf(cleanAnswer) < 0) throw new Error('請選擇 A、B、C 或 D');
    } else {
      cleanAnswer = cleanAnswer.slice(0, 50);
      if (!cleanAnswer) throw new Error('請輸入文字回應');
    }
    const previous = (state.responses || {})[String(seat)];
    const item = {
      seatNo: seat,
      answer: cleanAnswer,
      submittedAt: Date.now(),
      attemptNo: Number(previous && previous.attemptNo || 0) + 1
    };
    state.responses[String(seat)] = item;
    irsWriteState_(state);
    if (code.startsWith('G-')) {
      const cache = CacheService.getScriptCache();
      const seats = JSON.parse(cache.get('SEATS_' + code) || '[]');
      let seatRow = seats.find(row => Number(row.seatNo) === seat);
      if (!seatRow) { seatRow = { seatNo: seat }; seats.push(seatRow); }
      seatRow.isOccupied = true;
      cache.put('SEATS_' + code, JSON.stringify(seats), IRS_CACHE_TTL_SEC);
    } else {
      db_updateSeatStatus_(code, seat, { isOccupied: true });
    }
    irsLog_(activity, code, 'irs_response', {
      questionId: state.questionId,
      prompt: state.prompt,
      responseType: state.responseType,
      answer: cleanAnswer,
      attemptNo: item.attemptNo
    }, seat);
    return irsStudentView_(state, seat);
  } finally {
    lock.releaseLock();
  }
}

function adminGetIrsState(token, activityCode) {
  assertAdminByToken_(token);
  const activity = irsAssertActivity_(activityCode);
  return irsAdminView_(irsReadState_(activityCode), activity);
}

function adminGuestGetIrsState(activityCode) {
  const activity = irsAssertActivity_(activityCode);
  return irsAdminView_(irsReadState_(activityCode), activity);
}

function adminSaveIrsQuestion(token, activityCode, payload) {
  assertAdminByToken_(token);
  return irsSaveQuestion_(activityCode, payload);
}

function adminGuestSaveIrsQuestion(activityCode, payload) {
  if (!String(activityCode || '').startsWith('G-')) throw new Error('Guest activity code required');
  return irsSaveQuestion_(activityCode, payload);
}

function adminSetIrsStatus(token, activityCode, action) {
  assertAdminByToken_(token);
  return irsSetStatus_(activityCode, action);
}

function adminGuestSetIrsStatus(activityCode, action) {
  if (!String(activityCode || '').startsWith('G-')) throw new Error('Guest activity code required');
  return irsSetStatus_(activityCode, action);
}

function studentGetIrsState(activityCode, seatNo) {
  irsAssertActivity_(activityCode);
  return irsStudentView_(irsReadState_(activityCode), seatNo);
}

function studentSubmitIrsResponse(activityCode, seatNo, answer) {
  return irsSubmitResponse_(activityCode, seatNo, answer);
}

function irsHistoryTimestamp_(row) {
  const raw = row.timestamp || row.created_at || 0;
  const num = Number(raw);
  if (!isNaN(num) && num > 0) return num;
  const parsed = Date.parse(String(raw || ''));
  return isNaN(parsed) ? 0 : parsed;
}

function irsBuildHistory_(activityCode) {
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  const code = String(activityCode || '').trim().toUpperCase();
  const rows = db_readAll_(SHEET_NAMES.LOGS).filter(function(row) {
    return String(row.activity_id || '').trim().toUpperCase() === code && String(row.event_type || '').indexOf('irs_') === 0;
  }).sort(function(a, b) { return irsHistoryTimestamp_(a) - irsHistoryTimestamp_(b); });
  const records = {};
  const order = [];
  let lastDraft = { prompt: '快速口頭題（請聽老師說明）', responseType: 'choice', correctOption: '' };

  function payloadOf(row) {
    try { return JSON.parse(String(row.payload || '{}')) || {}; } catch (err) { return {}; }
  }
  function ensureRecord(id, payload, row) {
    const key = String(id || '').trim();
    if (!key) return null;
    if (!records[key]) {
      records[key] = {
        questionId: key,
        prompt: String(payload.prompt || lastDraft.prompt || '快速口頭題（請聽老師說明）'),
        responseType: String(payload.responseType || lastDraft.responseType || 'choice'),
        correctOption: String(payload.correctOption || lastDraft.correctOption || ''),
        studentCount: Number(row.student_count || 0),
        startedAt: 0,
        stoppedAt: 0,
        publishedAt: 0,
        responsesBySeat: {}
      };
      order.push(key);
    }
    return records[key];
  }

  rows.forEach(function(row) {
    const type = String(row.event_type || '');
    const payload = payloadOf(row);
    const ts = irsHistoryTimestamp_(row);
    if (type === 'irs_question_saved') {
      lastDraft = {
        prompt: String(payload.prompt || lastDraft.prompt),
        responseType: String(payload.responseType || lastDraft.responseType),
        correctOption: String(payload.correctOption || '')
      };
      return;
    }
    const rec = ensureRecord(payload.questionId, payload, row);
    if (!rec) return;
    if (payload.prompt) rec.prompt = String(payload.prompt);
    if (payload.responseType) rec.responseType = String(payload.responseType);
    if (payload.correctOption !== undefined) rec.correctOption = String(payload.correctOption || '');
    if (type === 'irs_start') rec.startedAt = ts;
    if (type === 'irs_stop') rec.stoppedAt = ts;
    if (type === 'irs_publish') rec.publishedAt = ts;
    if (type === 'irs_response') {
      const seatMatch = String(row.user_id || '').match(/seat_(\d+)/i);
      const seatNo = Number(payload.seatNo || (seatMatch && seatMatch[1]) || 0);
      if (!seatNo) return;
      rec.responsesBySeat[String(seatNo)] = {
        seatNo: seatNo,
        answer: String(payload.answer == null ? '' : payload.answer),
        submittedAt: ts,
        attemptNo: Number(payload.attemptNo || 1)
      };
    }
  });

  return order.map(function(id) {
    const rec = records[id];
    const responses = Object.keys(rec.responsesBySeat).map(function(key) { return rec.responsesBySeat[key]; })
      .sort(function(a, b) { return a.seatNo - b.seatNo; });
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    responses.forEach(function(item) {
      const answer = String(item.answer || '').toUpperCase();
      if (Object.prototype.hasOwnProperty.call(counts, answer)) counts[answer] += 1;
    });
    return {
      questionId: rec.questionId,
      prompt: rec.prompt,
      responseType: rec.responseType,
      correctOption: rec.correctOption,
      studentCount: rec.studentCount,
      answeredCount: responses.length,
      startedAt: rec.startedAt,
      stoppedAt: rec.stoppedAt,
      publishedAt: rec.publishedAt,
      counts: counts,
      responses: responses
    };
  }).filter(function(rec) { return rec.startedAt || rec.responses.length; }).sort(function(a, b) {
    return Number(b.startedAt || 0) - Number(a.startedAt || 0);
  }).slice(0, 100);
}

function adminGetIrsHistory(token, activityCode) {
  assertAdminByToken_(token);
  irsAssertActivity_(activityCode);
  return irsBuildHistory_(activityCode);
}

function adminGuestGetIrsHistory(activityCode) {
  if (!String(activityCode || '').startsWith('G-')) throw new Error('Guest activity code required');
  irsAssertActivity_(activityCode);
  return irsBuildHistory_(activityCode);
}

function irsBuildSeatHistory_(activityCode, seatNo) {
  const targetSeat = Number(seatNo || 0);
  if (!targetSeat) throw new Error('座號無效');
  return irsBuildHistory_(activityCode).map(function(question) {
    const response = (question.responses || []).find(function(item) { return Number(item.seatNo) === targetSeat; });
    if (!response) return null;
    const gradable = question.responseType === 'choice' && Boolean(question.correctOption);
    const isCorrect = gradable
      ? String(response.answer || '').toUpperCase() === String(question.correctOption || '').toUpperCase()
      : null;
    return {
      questionId: question.questionId,
      prompt: question.prompt,
      responseType: question.responseType,
      answer: response.answer,
      correctOption: question.correctOption,
      isCorrect: isCorrect,
      score: gradable ? (isCorrect ? 100 : 0) : null,
      submittedAt: response.submittedAt,
      attemptNo: response.attemptNo || 1
    };
  }).filter(function(item) { return Boolean(item); });
}

function adminGetSeatIrsHistory(token, activityCode, seatNo) {
  assertAdminByToken_(token);
  irsAssertActivity_(activityCode);
  return irsBuildSeatHistory_(activityCode, seatNo);
}

function adminGuestGetSeatIrsHistory(activityCode, seatNo) {
  if (!String(activityCode || '').startsWith('G-')) throw new Error('Guest activity code required');
  irsAssertActivity_(activityCode);
  return irsBuildSeatHistory_(activityCode, seatNo);
}

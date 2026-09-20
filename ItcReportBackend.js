function itcCodeToNumber_(code) {
  const c = normalizeItcCode_(code);
  if (c === 'ON_ACTIVE') return 1;
  if (c === 'ON_PASSIVE') return 2;
  if (c === 'SEEK_HELP') return 3;
  if (c === 'UNCLEAR') return 4;
  if (c === 'OFF_TASK') return 5;
  if (c === 'DISRUPTIVE') return 6;
  return 0;
}

function parseLogTimestampMs_(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const num = Number(raw);
  if (!isNaN(num) && num > 0) return num;
  const parsed = Date.parse(String(raw));
  return isNaN(parsed) ? 0 : parsed;
}

function parseItcLogsForActivity_(activityCode, fromTs, toTs) {
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  const targetCode = String(activityCode || '').trim().toUpperCase();
  const from = Number(fromTs || 0);
  const to = Number(toTs || 0);
  const allLogs = db_readAll_(SHEET_NAMES.LOGS);
  const events = [];

  allLogs.forEach(item => {
    if (String(item.activity_id || '').trim().toUpperCase() !== targetCode) return;
    if (String(item.event_type || '') !== 'itc_mark') return;

    let payload = {};
    try {
      payload = JSON.parse(String(item.payload || '{}')) || {};
    } catch (err) {
      payload = {};
    }

    const itcCode = normalizeItcCode_(payload.itcCode || payload.code);
    if (!itcCode) return;

    const ts = parseLogTimestampMs_(payload.serverTs || payload.clientTs || item.timestamp || item.created_at);
    if (!ts) return;
    if (from > 0 && ts < from) return;
    if (to > 0 && ts > to) return;

    events.push({
      logId: String(item.id || ''),
      ts: ts,
      seatNo: Number(payload.seatNo || 0),
      code: itcCode,
      codeNo: itcCodeToNumber_(itcCode)
    });
  });

  events.sort((a, b) => a.ts - b.ts || a.seatNo - b.seatNo);
  return events;
}

function buildItcTimeWindow_(events, fromTs, toTs, classStartTs) {
  const list = Array.isArray(events) ? events : [];
  if (list.length > 0) {
    const startTs = Number(list[0].ts || 0);
    const endTs = Number(list[list.length - 1].ts || startTs);
    const totalMin = Math.max(0, Number(((endTs - startTs) / 60000).toFixed(2)));
    return {
      startTs: startTs,
      endTs: endTs,
      totalMin: totalMin
    };
  }

  const from = Number(fromTs || 0);
  const to = Number(toTs || 0);
  if (from > 0 && to >= from) {
    return {
      startTs: from,
      endTs: to,
      totalMin: Math.max(0, Number(((to - from) / 60000).toFixed(2)))
    };
  }

  const base = Number(classStartTs || 0) || Date.now();
  return {
    startTs: base,
    endTs: base,
    totalMin: 0
  };
}

function buildItcAnalyticsSummary_(events, latencyBaseTs) {
  const counts = {
    ON_ACTIVE: 0,
    ON_PASSIVE: 0,
    SEEK_HELP: 0,
    UNCLEAR: 0,
    OFF_TASK: 0,
    DISRUPTIVE: 0
  };

  events.forEach(ev => {
    if (counts[ev.code] === undefined) return;
    counts[ev.code] += 1;
  });
  const total = events.length;
  const percent = {};
  Object.keys(counts).forEach(k => {
    percent[k] = total > 0 ? Number((counts[k] * 100 / total).toFixed(2)) : 0;
  });

  const firstCode1 = events.find(ev => ev.code === 'ON_ACTIVE');
  const latencySec = (firstCode1 && Number(latencyBaseTs || 0) > 0)
    ? Math.max(0, Math.round((firstCode1.ts - Number(latencyBaseTs)) / 1000))
    : null;

  const bySeat = {};
  events.forEach(ev => {
    if (!ev.seatNo) return;
    if (!bySeat[ev.seatNo]) bySeat[ev.seatNo] = [];
    bySeat[ev.seatNo].push(ev);
  });

  let from3Total = 0;
  let from3To1 = 0;
  let from3To1DurSum = 0;
  let from3To5 = 0;
  let from3To5DurSum = 0;
  let from5Total = 0;
  let from5To1 = 0;
  let from5To1DurSum = 0;

  let bestFlow = { seatNo: 0, startTs: 0, endTs: 0, count: 0 };
  Object.keys(bySeat).forEach(seatKey => {
    const seq = bySeat[seatKey].slice().sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < seq.length - 1; i++) {
      const cur = seq[i];
      const nxt = seq[i + 1];
      if (cur.code === 'SEEK_HELP') {
        from3Total += 1;
        if (nxt.code === 'ON_ACTIVE') {
          from3To1 += 1;
          from3To1DurSum += Math.max(0, nxt.ts - cur.ts);
        } else if (nxt.code === 'OFF_TASK') {
          from3To5 += 1;
          from3To5DurSum += Math.max(0, nxt.ts - cur.ts);
        }
      }
      if (cur.code === 'OFF_TASK') {
        from5Total += 1;
        if (nxt.code === 'ON_ACTIVE') {
          from5To1 += 1;
          from5To1DurSum += Math.max(0, nxt.ts - cur.ts);
        }
      }
    }

    let runStart = null;
    let runEnd = null;
    let runCount = 0;
    seq.forEach(ev => {
      if (ev.code === 'ON_ACTIVE') {
        if (runStart === null) runStart = ev.ts;
        runEnd = ev.ts;
        runCount += 1;
      } else {
        if (runCount > bestFlow.count || (runCount === bestFlow.count && (runEnd - runStart) > (bestFlow.endTs - bestFlow.startTs))) {
          bestFlow = { seatNo: Number(seatKey), startTs: runStart || 0, endTs: runEnd || 0, count: runCount };
        }
        runStart = null;
        runEnd = null;
        runCount = 0;
      }
    });
    if (runCount > bestFlow.count || (runCount === bestFlow.count && (runEnd - runStart) > (bestFlow.endTs - bestFlow.startTs))) {
      bestFlow = { seatNo: Number(seatKey), startTs: runStart || 0, endTs: runEnd || 0, count: runCount };
    }
  });

  const transition = {
    fromHelp: {
      total: from3Total,
      toActive: from3To1,
      probability: from3Total > 0 ? Number((from3To1 * 100 / from3Total).toFixed(2)) : 0,
      avgSec: from3To1 > 0 ? Math.round(from3To1DurSum / from3To1 / 1000) : null,
      toOffTask: from3To5,
      probabilityOffTask: from3Total > 0 ? Number((from3To5 * 100 / from3Total).toFixed(2)) : 0,
      avgSecToOffTask: from3To5 > 0 ? Math.round(from3To5DurSum / from3To5 / 1000) : null
    },
    fromOffTask: {
      total: from5Total,
      toActive: from5To1,
      probability: from5Total > 0 ? Number((from5To1 * 100 / from5Total).toFixed(2)) : 0,
      avgSec: from5To1 > 0 ? Math.round(from5To1DurSum / from5To1 / 1000) : null
    },
    combined: {
      total: from3Total + from5Total,
      toActive: from3To1 + from5To1,
      probability: (from3Total + from5Total) > 0 ? Number((((from3To1 + from5To1) * 100) / (from3Total + from5Total)).toFixed(2)) : 0
    }
  };

  const flowDurationSec = (bestFlow.startTs && bestFlow.endTs) ? Math.max(0, Math.round((bestFlow.endTs - bestFlow.startTs) / 1000)) : 0;
  const flow = {
    seatNo: bestFlow.seatNo || null,
    startTs: bestFlow.startTs || null,
    endTs: bestFlow.endTs || null,
    durationSec: flowDurationSec,
    eventCount: bestFlow.count || 0
  };

  return {
    total: total,
    counts: counts,
    percent: percent,
    latencyToFirstActiveSec: latencySec,
    transition: transition,
    flow: flow
  };
}

function buildItcTimelinePoints_(events, timelineStartTs) {
  if (!events || events.length === 0) return [];
  const preferredBase = Number(timelineStartTs || 0) > 0 ? Number(timelineStartTs) : 0;
  const fallbackBase = Number(events[0].ts || 0);
  const baseTs = preferredBase || fallbackBase;
  if (!baseTs) return [];

  return events.map(ev => ({
    minute: Number(((ev.ts - baseTs) / 60000).toFixed(2)),
    codeNo: ev.codeNo,
    code: ev.code,
    seatNo: ev.seatNo,
    ts: ev.ts
  }));
}

function buildItcAutoComments_(summary) {
  const comments = [];
  const p = summary.percent || {};
  const c = summary.counts || {};
  const trans = summary.transition || {};
  const pAet = Number(p.ON_ACTIVE || 0);
  const pPet = Number(p.ON_PASSIVE || 0);
  const pOff = Number(p.OFF_TASK || 0);
  const helpCount = Number(c.SEEK_HELP || 0);
  const helpTo1 = Number((trans.fromHelp && trans.fromHelp.probability) || 0);

  if (pAet > 60) comments.push('高效探索型：主動在工作中比例高，學習投入度佳。');
  if (helpCount >= 8 && helpTo1 < 40 && pOff >= 20) comments.push('需求介入型：求助後回到主動工作的比例偏低，且離題偏高，建議即時引導。');
  if (pPet >= 45 && pAet < 30) comments.push('被動參與偏高：可增加任務分工與提問節點促進主動投入。');
  if (pOff >= 30) comments.push('離題風險偏高：建議縮短回饋間隔、明確切分任務階段。');
  if (Number((summary.transition && summary.transition.combined && summary.transition.combined.probability) || 0) >= 60) {
    comments.push('具備自我修復傾向：求助/離題後回到主動工作的轉換率良好。');
  }
  if (comments.length === 0) comments.push('整體行為分佈穩定，可持續觀察不同任務階段的變化。');
  return comments;
}

function round2_(val) {
  return Number(Number(val || 0).toFixed(2));
}

function mean_(arr) {
  const list = Array.isArray(arr) ? arr.filter(v => typeof v === 'number' && !isNaN(v)) : [];
  if (!list.length) return null;
  return list.reduce((acc, v) => acc + v, 0) / list.length;
}

function sampleSd_(arr) {
  const list = Array.isArray(arr) ? arr.filter(v => typeof v === 'number' && !isNaN(v)) : [];
  if (list.length < 2) return null;
  const m = mean_(list);
  const variance = list.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / (list.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function buildEnvironmentLevel_(peerAet) {
  const aet = Number(peerAet || 0);
  if (aet >= 70) return { light: '🟢', key: 'ENV_GOOD', label: '教學效能優良', condition: '平均 AET >= 70%' };
  if (aet >= 60) return { light: '🟡', key: 'ENV_FAIR', label: '教學效能普通', condition: '60% <= AET < 70%' };
  return { light: '🔴', key: 'ENV_ALERT', label: '教學效能警訊', condition: '平均 AET < 60%' };
}

function buildIndividualLevel_(gapPct) {
  const gap = Number(gapPct || 0);
  if (gap >= -10) return { light: '✅', key: 'IND_OK', label: '符合常模表現', emoji: '😊' };
  if (gap > -30) return { light: '⚠️', key: 'IND_WATCH', label: '個體關注對象', emoji: '🧐' };
  return { light: '🚨', key: 'IND_RISK', label: '顯著個體差異', emoji: '🆘' };
}

function classifyItcSeat_(seatSummary) {
  const aet = Number(seatSummary && seatSummary.aetRate || 0);
  const pet = Number(seatSummary && seatSummary.petRate || 0);
  const oft = Number(seatSummary && seatSummary.oftRate || 0);
  const helpToActive = Number(seatSummary && seatSummary.helpToActiveRate || 0);
  const total = Number(seatSummary && seatSummary.total || 0);

  if (total <= 0) return { key: 'NO_DATA', label: '資料不足型 (ND)', order: 99 };
  if (aet >= 60 && oft <= 20) return { key: 'HIGH_ENGAGE', label: '高投入探索型 (HE)', order: 1 };
  if (oft >= 35) return { key: 'OFF_RISK', label: '離題風險型 (OFF-RISK)', order: 2 };
  if (Number(seatSummary && seatSummary.helpCount || 0) >= 3 && helpToActive < 40) return { key: 'NEED_SUPPORT', label: '需求介入型 (NS)', order: 3 };
  if (pet >= 45 && aet < 35) return { key: 'PASSIVE_WAIT', label: '觀望待啟動型 (PW)', order: 4 };
  return { key: 'STABLE', label: '穩定發展型 (ST)', order: 5 };
}

function buildItcSeatAnalytics_(events, classStartTs, studentCount) {
  const codeKeys = ['ON_ACTIVE', 'ON_PASSIVE', 'SEEK_HELP', 'UNCLEAR', 'OFF_TASK', 'DISRUPTIVE'];
  const bySeat = {};
  let maxSeatNo = 0;

  (events || []).forEach(ev => {
    const seatNo = Number(ev && ev.seatNo || 0);
    if (seatNo <= 0) return;
    if (!bySeat[seatNo]) bySeat[seatNo] = [];
    bySeat[seatNo].push(ev);
    if (seatNo > maxSeatNo) maxSeatNo = seatNo;
  });

  const totalSeats = Math.max(Number(studentCount || 0), maxSeatNo, 0);
  if (totalSeats <= 0) {
    return {
      totalSeats: 0,
      activeSeats: 0,
      seats: [],
      classAverages: {
        countsPerSeat: {},
        rates: { aetRate: 0, petRate: 0, oftRate: 0, helpToActiveRate: 0 }
      }
    };
  }

  const seatRows = [];
  for (let seatNo = 1; seatNo <= totalSeats; seatNo++) {
    const seq = (bySeat[seatNo] || []).slice().sort((a, b) => a.ts - b.ts);
    const counts = {
      ON_ACTIVE: 0,
      ON_PASSIVE: 0,
      SEEK_HELP: 0,
      UNCLEAR: 0,
      OFF_TASK: 0,
      DISRUPTIVE: 0
    };
    seq.forEach(ev => {
      if (counts[ev.code] === undefined) return;
      counts[ev.code] += 1;
    });

    let helpTotal = 0;
    let helpToActive = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      const cur = seq[i];
      const nxt = seq[i + 1];
      if (cur.code === 'SEEK_HELP') {
        helpTotal += 1;
        if (nxt.code === 'ON_ACTIVE') helpToActive += 1;
      }
    }

    const firstActive = seq.find(ev => ev.code === 'ON_ACTIVE');
    const latencySec = (firstActive && Number(classStartTs || 0) > 0)
      ? Math.max(0, Math.round((firstActive.ts - Number(classStartTs)) / 1000))
      : null;

    const total = seq.length;
    const aetCount = Number(counts.ON_ACTIVE || 0) + Number(counts.SEEK_HELP || 0);
    const petCount = Number(counts.ON_PASSIVE || 0);
    const oftCount = Number(counts.OFF_TASK || 0) + Number(counts.DISRUPTIVE || 0);
    const denom = aetCount + petCount + oftCount;
    const aetRate = denom > 0 ? round2_(aetCount * 100 / denom) : 0;
    const petRate = denom > 0 ? round2_(petCount * 100 / denom) : 0;
    const oftRate = denom > 0 ? round2_(oftCount * 100 / denom) : 0;
    const rawScore = aetRate - (oftRate * 0.5) + (petRate * 0.1);
    const itcScore = round2_(Math.max(0, Math.min(100, rawScore)));
    const helpToActiveRate = helpTotal > 0 ? round2_(helpToActive * 100 / helpTotal) : 0;

    const row = {
      seatNo: seatNo,
      total: total,
      counts: counts,
      aetCount: aetCount,
      petCount: petCount,
      oftCount: oftCount,
      denominator: denom,
      aetRate: aetRate,
      petRate: petRate,
      oftRate: oftRate,
      itcScore: itcScore,
      helpCount: Number(counts.SEEK_HELP || 0),
      helpToActiveRate: helpToActiveRate,
      latencySec: latencySec
    };
    const cls = classifyItcSeat_(row);
    row.classification = cls;
    row.summaryLine = `${cls.label}：AET ${aetRate}%｜PET ${petRate}%｜OFT ${oftRate}%`;
    seatRows.push(row);
  }

  const activeSeatRows = seatRows.filter(r => Number(r.total || 0) > 0);
  const seatDivisor = seatRows.length || 1;
  const activeDivisor = activeSeatRows.length || 1;
  const sumByKey = {};
  codeKeys.forEach(k => { sumByKey[k] = 0; });

  seatRows.forEach(r => {
    codeKeys.forEach(k => { sumByKey[k] += Number(r.counts[k] || 0); });
  });

  const classAverages = {
    countsPerSeat: {
      ON_ACTIVE: round2_(sumByKey.ON_ACTIVE / seatDivisor),
      ON_PASSIVE: round2_(sumByKey.ON_PASSIVE / seatDivisor),
      SEEK_HELP: round2_(sumByKey.SEEK_HELP / seatDivisor),
      UNCLEAR: round2_(sumByKey.UNCLEAR / seatDivisor),
      OFF_TASK: round2_(sumByKey.OFF_TASK / seatDivisor),
      DISRUPTIVE: round2_(sumByKey.DISRUPTIVE / seatDivisor)
    },
    rates: {
      aetRate: round2_(activeSeatRows.reduce((acc, r) => acc + Number(r.aetRate || 0), 0) / activeDivisor),
      petRate: round2_(activeSeatRows.reduce((acc, r) => acc + Number(r.petRate || 0), 0) / activeDivisor),
      oftRate: round2_(activeSeatRows.reduce((acc, r) => acc + Number(r.oftRate || 0), 0) / activeDivisor),
      helpToActiveRate: round2_(activeSeatRows.reduce((acc, r) => acc + Number(r.helpToActiveRate || 0), 0) / activeDivisor)
    }
  };

  const classLayer2Flags = [];
  if (Number(classAverages.rates.aetRate || 0) < 60) classLayer2Flags.push('CLASS_LOW_AET');
  if (Number(classAverages.rates.oftRate || 0) > 20) classLayer2Flags.push('CLASS_HIGH_OFT');
  const classDiagnosis = {
    triggered: classLayer2Flags.length > 0,
    flags: classLayer2Flags,
    label: classLayer2Flags.length > 0 ? '教學效能警訊' : '教學節奏穩定',
    reason: classLayer2Flags.length > 0
      ? `全班平均 AET ${round2_(classAverages.rates.aetRate)}% / OFT ${round2_(classAverages.rates.oftRate)}%`
      : `全班平均 AET ${round2_(classAverages.rates.aetRate)}% / OFT ${round2_(classAverages.rates.oftRate)}%`,
    action: classLayer2Flags.length > 0
      ? '優先修正教學流程：拆解步驟、降低硬體門檻、縮短講解並增加引導。'
      : '維持現行教學節奏，持續觀察不同任務節點。'
  };

  const sumAet = activeSeatRows.reduce((acc, r) => acc + Number(r.aetRate || 0), 0);
  const sumPet = activeSeatRows.reduce((acc, r) => acc + Number(r.petRate || 0), 0);
  const sumOft = activeSeatRows.reduce((acc, r) => acc + Number(r.oftRate || 0), 0);
  const activeN = activeSeatRows.length;

  seatRows.forEach(r => {
    const isActive = Number(r.total || 0) > 0;
    const peerN = isActive ? (activeN - 1) : activeN;
    const peerAetList = activeSeatRows
      .filter(x => !isActive || Number(x.seatNo || 0) !== Number(r.seatNo || 0))
      .map(x => Number(x.aetRate || 0));
    const peerAetSd = sampleSd_(peerAetList);
    const peerAet = peerN > 0 ? round2_((sumAet - (isActive ? Number(r.aetRate || 0) : 0)) / peerN) : null;
    const peerPet = peerN > 0 ? round2_((sumPet - (isActive ? Number(r.petRate || 0) : 0)) / peerN) : null;
    const peerOft = peerN > 0 ? round2_((sumOft - (isActive ? Number(r.oftRate || 0) : 0)) / peerN) : null;
    const ratioAet = (peerAet !== null && peerAet > 0) ? round2_(Number(r.aetRate || 0) / peerAet) : null;
    const zAet = (peerAet !== null && peerAetSd !== null && peerAetSd > 0)
      ? round2_((Number(r.aetRate || 0) - peerAet) / peerAetSd)
      : null;
    const gapAet = peerAet === null ? null : round2_(Number(r.aetRate || 0) - peerAet);
    const envLevel = buildEnvironmentLevel_(peerAet == null ? 0 : peerAet);
    const indLevel = buildIndividualLevel_(gapAet == null ? 0 : gapAet);

    r.peerComparison = {
      aetRate: {
        seat: r.aetRate,
        classAvg: classAverages.rates.aetRate,
        peerAvg: peerAet,
        peerSd: peerAetSd == null ? null : round2_(peerAetSd),
        ratio: ratioAet,
        zScore: zAet,
        delta: round2_(r.aetRate - classAverages.rates.aetRate),
        deltaPeer: gapAet
      },
      petRate: {
        seat: r.petRate,
        classAvg: classAverages.rates.petRate,
        peerAvg: peerPet,
        delta: round2_(r.petRate - classAverages.rates.petRate),
        deltaPeer: peerPet === null ? null : round2_(r.petRate - peerPet)
      },
      oftRate: {
        seat: r.oftRate,
        classAvg: classAverages.rates.oftRate,
        peerAvg: peerOft,
        delta: round2_(r.oftRate - classAverages.rates.oftRate),
        deltaPeer: peerOft === null ? null : round2_(r.oftRate - peerOft)
      }
    };

    const tags = [];
    const deltaPeerAet = Number((r.peerComparison.aetRate && r.peerComparison.aetRate.deltaPeer) || 0);
    if (deltaPeerAet < -30) tags.push('顯著個體差異');
    if (Math.abs(deltaPeerAet) <= 10) tags.push('符合常模表現');
    if (classDiagnosis.triggered) tags.push('教學效能警訊');

    const individualTriggered = envLevel.key !== 'ENV_ALERT'
      && r.peerComparison.aetRate.peerAvg !== null
      && r.peerComparison.aetRate.peerSd !== null
      && Number(r.aetRate || 0) < Number(r.peerComparison.aetRate.peerAvg || 0) - 1.5 * Number(r.peerComparison.aetRate.peerSd || 0);
    const individualIsAdvisoryOnly = envLevel.key === 'ENV_ALERT';
    const priority = individualIsAdvisoryOnly ? 'SYSTEM_FIRST' : 'INDIVIDUAL_OK';

    let diagnosisLabel = '穩定觀察';
    let diagnosisReason = `AET ${r.aetRate}% / 同班其他同學平均 ${r.peerComparison.aetRate.peerAvg == null ? '--' : r.peerComparison.aetRate.peerAvg + '%'}`
    let diagnosisAction = '維持目前支持策略，持續追蹤。';
    if (individualIsAdvisoryOnly) {
      diagnosisLabel = '系統優化優先';
      diagnosisReason = `第一層 ${envLevel.light} ${envLevel.label}（全班平均 AET ${peerAet == null ? '--' : peerAet + '%'}）`;
      diagnosisAction = '第一層為紅燈，先修正教學與設備流程；第二層僅供參考，不作個案定案。';
    } else if (individualTriggered) {
      diagnosisLabel = '個案介入優先';
      diagnosisReason = `目標生 AET 明顯低於同班其他同學平均（1.5 SD）`;
      diagnosisAction = '建議啟動個別輔導，調整任務難度並提供一對一技術支持。';
    } else if (deltaPeerAet < -30) {
      diagnosisLabel = '顯著個體差異';
      diagnosisAction = '建議進行功能性行為評估 (FBA) 或一對一技術支持。';
    } else if (Math.abs(deltaPeerAet) <= 10) {
      diagnosisLabel = '符合常模表現';
      diagnosisAction = '學生與教學節奏同步，建議維持現行策略。';
    }

    r.diagnosis = {
      layer2Triggered: envLevel.key === 'ENV_ALERT',
      layer1Triggered: individualTriggered,
      priority: priority,
      individualIsAdvisoryOnly: individualIsAdvisoryOnly,
      label: diagnosisLabel,
      reason: diagnosisReason,
      action: diagnosisAction,
      advisoryNote: individualIsAdvisoryOnly ? '第一層為紅燈，第二層個體判讀僅供參考。' : '',
      environmentAdvice: envLevel.key === 'ENV_ALERT'
        ? '【教學效能警訊】建議修正教案或檢查設備穩定度。'
        : (envLevel.key === 'ENV_FAIR'
          ? '【教學效能普通】教學節奏尚可，但部分學生可能開始出現疲勞。'
          : '【教學效能優良】教學設計能引發多數學生主動參與，環境穩定。'),
      tags: tags,
      environment: Object.assign({}, envLevel, {
        peerAet: peerAet,
        peerOft: peerOft
      }),
      individual: Object.assign({}, indLevel, {
        gapAet: gapAet
      }),
      reportLine: `座號 ${r.seatNo} AET ${round2_(r.aetRate)}%，同班其他同學平均 ${peerAet == null ? '--' : round2_(peerAet) + '%'}，差值 ${gapAet == null ? '--' : round2_(gapAet) + '%'}。`
    };
  });

  return {
    totalSeats: seatRows.length,
    activeSeats: activeSeatRows.length,
    seats: seatRows,
    classAverages: classAverages,
    classDiagnosis: classDiagnosis
  };
}


function adminGetItcAnalytics(token, activityCode, fromTs, toTs) {
  assertAdminByToken_(token);
  const activity = db_getActivityByCode_(activityCode);
  if (!activity) throw new Error('Activity not found');
  const events = parseItcLogsForActivity_(activityCode, fromTs, toTs);
  const classStartTs = Number(activity.startTime || activity.createdAt || 0);
  const timelineMeta = buildItcTimeWindow_(events, fromTs, toTs, classStartTs);
  const summary = buildItcAnalyticsSummary_(events, Number(timelineMeta.startTs || 0));
  const timeline = buildItcTimelinePoints_(events, Number(timelineMeta.startTs || 0));
  const seatAnalytics = buildItcSeatAnalytics_(events, classStartTs, Number(activity.studentCount || 0));
  const comments = buildItcAutoComments_(summary);
  return {
    activityCode: activityCode,
    fromTs: Number(fromTs || 0),
    toTs: Number(toTs || 0),
    classStartTs: classStartTs,
    timelineMeta: timelineMeta,
    events: events,
    summary: summary,
    timeline: timeline,
    seatAnalytics: seatAnalytics,
    comments: comments
  };
}

function adminGuestGetItcAnalytics(activityCode, fromTs, toTs) {
  if (!String(activityCode || '').startsWith('G-')) throw new Error('Guest activity code required');
  const cache = CacheService.getScriptCache();
  const activity = JSON.parse(cache.get('ACT_' + activityCode) || 'null');
  if (!activity) throw new Error('Activity not found');
  const events = parseItcLogsForActivity_(activityCode, fromTs, toTs);
  const classStartTs = Number(activity.startTime || activity.createdAt || 0);
  const timelineMeta = buildItcTimeWindow_(events, fromTs, toTs, classStartTs);
  const summary = buildItcAnalyticsSummary_(events, Number(timelineMeta.startTs || 0));
  const timeline = buildItcTimelinePoints_(events, Number(timelineMeta.startTs || 0));
  const seatAnalytics = buildItcSeatAnalytics_(events, classStartTs, Number(activity.studentCount || 0));
  const comments = buildItcAutoComments_(summary);
  return {
    activityCode: activityCode,
    fromTs: Number(fromTs || 0),
    toTs: Number(toTs || 0),
    classStartTs: classStartTs,
    timelineMeta: timelineMeta,
    events: events,
    summary: summary,
    timeline: timeline,
    seatAnalytics: seatAnalytics,
    comments: comments
  };
}

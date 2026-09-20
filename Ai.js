/** Ai.gs - AI Provider abstraction (OpenAI / Gemini) */

function aiEvaluatePhoto_(ctx) {
  const provider = (Config_get('AI_PROVIDER') || 'OPENAI').toUpperCase();

  if (provider === 'GEMINI') {
    return aiEvalGemini_(ctx);
  }
  return aiEvalOpenAI_(ctx);
}

function aiEvalOpenAI_(ctx) {
  const apiKey = Config_get('AI_API_KEY');
  if (!apiKey) throw new Error('AI_API_KEY not set');

  const model = Config_get('OPENAI_MODEL') || 'gpt-5.1';

  // get image base64 from Drive fileId
  const { mimeType, b64 } = driveFileToBase64_(ctx.fileId);

  const promptData = buildAiPrompt_(ctx);
  const prompt = promptData.prompt;

  // OpenAI Chat Completions API
  const url = 'https://api.openai.com/v1/chat/completions';

  const payload = {
    model: model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${b64}`
            }
          }
        ]
      }
    ],
    response_format: { type: 'json_object' }
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('OpenAI API error: ' + body);
  }

  const json = JSON.parse(body);
  const content = json.choices[0].message.content;
  const parsed = safeJsonParse_(content);

  // Validate fields
  const score = Number(parsed.score);
  const suggestion = String(parsed.suggestion || '').trim();
  
  // Allow score=0
  if (isNaN(score)) throw new Error('Invalid score received');

  return {
    score: clamp_(score, 0, 100),
    suggestion,
    debugRubricText: promptData.debugRubricText
  };
}

function aiEvalGemini_(ctx) {
  // Minimal placeholder: implement similarly if you have Gemini key & endpoint.
  // To keep spec: must return JSON {score,suggestion} or throw.
  throw new Error('Gemini provider not implemented. Set AI_PROVIDER=OPENAI.');
}

function buildAiPrompt_(ctx) {
  const activityName = String(ctx.activity.activityName || '');
  const className = String(ctx.className || '');
  const seatNo = String(ctx.seatNo || '');
  const rubric = String(ctx.activity.rubric || '');

  let rubricText = '';
  if (rubric) {
    rubricText = `
請嚴格遵守以下的 rubric (評分方針) 進行評分。你的評分與建議必須完全基於此方針的標準：
${rubric}
    `.trim();
  }
  
  console.log("【目前活動的 AI 評分方針】\n" + (rubricText || "（無設定或空值）"));

  const promptText = `
你是國小作品的評量助理。請你根據學生上傳的「照片作品」給出 0~100 的評分（score）與一段具體可行、正向鼓勵的建議（suggestion），以利學生改進作品。

活動名稱：${activityName}
班級：${className}
座號：${seatNo}
${rubricText}

輸出必須是「純 JSON」，不要任何多餘文字，格式如下：
{"score": 0, "suggestion": "..."}

規則：
- score 是 0~100 的整數（可四捨五入）。分數必須嚴格對應 rubric (評分方針) 中所描述的給分標準，不可隨意給分。
- suggestion 請以繁體中文撰寫，具體且可行。必須明確點出作品符合 rubric (評分方針) 中的哪一項具體指標，並以此做為依據。
- 分段落說明，每一段空兩行，容易閱讀。
- 評語請盡量詳細，包含具體的「優點」與「建議改進的方向」，字數請至少 50~100 字以上。
`.trim();

  return { prompt: promptText, debugRubricText: rubricText };
}

function driveFileToBase64_(fileId) {
  if (!fileId) throw new Error('No fileId');
  const f = DriveApp.getFileById(fileId);
  const blob = f.getBlob();
  const bytes = blob.getBytes();
  const b64 = Utilities.base64Encode(bytes);
  const mimeType = blob.getContentType() || 'image/jpeg';
  return { mimeType, b64 };
}

function extractResponseText_(respJson) {
  // Try common fields for Responses API
  // 1) resp.output[0].content[0].text
  try {
    const out = respJson.output;
    if (Array.isArray(out) && out.length > 0) {
      const c = out[0].content;
      if (Array.isArray(c) && c.length > 0) {
        const t = c.find(x => x.type === 'output_text' || x.type === 'text') || c[0];
        if (t && t.text) return String(t.text);
      }
    }
  } catch (e) {}

  // 2) resp.output_text
  if (respJson.output_text) return String(respJson.output_text);

  // 3) fallback: stringify
  return JSON.stringify(respJson);
}

function safeJsonParse_(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // try to extract JSON substring
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw e;
  }
}

function aiEvaluateGuestPhoto_(ctx) {
  const apiKey = ctx.apiKey;
  if (!apiKey) throw new Error('訪客活動未設定 AI_API_KEY');

  const model = Config_get('OPENAI_MODEL') || 'gpt-4o-mini';

  // get image base64 from Drive fileId
  const { mimeType, b64 } = driveFileToBase64_(ctx.fileId);

  const promptData = buildAiPrompt_(ctx);
  const prompt = promptData.prompt;

  // OpenAI Chat Completions API
  const url = 'https://api.openai.com/v1/chat/completions';

  const payload = {
    model: model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${b64}`
            }
          }
        ]
      }
    ],
    response_format: { type: 'json_object' }
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('OpenAI API error: ' + body);
  }

  const json = JSON.parse(body);
  const content = json.choices[0].message.content;
  const parsed = safeJsonParse_(content);

  // Validate fields
  const score = Number(parsed.score);
  const suggestion = String(parsed.suggestion || '').trim();
  
  // Allow score=0
  if (isNaN(score)) throw new Error('Invalid score received');

  return {
    score: clamp_(score, 0, 100),
    suggestion,
    debugRubricText: promptData.debugRubricText
  };
}

function clamp_(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

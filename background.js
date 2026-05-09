const API_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-chat";
const API_TIMEOUT_MS = 15000;
const API_KEY_STORAGE_KEY = "deepseekApiKey";
const ENTRIES_STORAGE_KEY = "entries";
const LEGACY_CACHE_STORAGE_KEY = "lookupCache";

const SYSTEM_PROMPT = `你是一个多语言查词助手。用户会给你一个外语单词和它所在的句子。请分析这个词，返回严格的JSON格式，不要任何额外说明文字，不要markdown代码块标记。

返回格式：
{
  "word": "原词",
  "lang": "语言名称（中文，如：波斯语、俄语）",
  "translit": "拉丁转写（简化版，便于辅助记忆，不要求严格学术标准）",
  "etymology": "词源词根（一句话简述，可追溯到的最早语言层次）",
  "meaning": "核心词义（中文，1-2个最常用的义项）",
  "form": "形态与句法作用。如果该词是变体形式（变格、变位、复数等），先给出原形和形态信息，再说明在句中的语法成分。格式参考：'原形 形态信息，作XX'。如果该词本身就是原形，直接说明形态特征和句中作用。"
}

要求：
- 输出必须是合法的JSON
- 每个字段尽量简洁，不要展开成段落
- 用途是辅助记忆，不需要学术严谨

示例：
- 俄语 домами：'дом 复数工具格，作工具状语'
- 俄语 решил：'решить 完成体过去时阳性单数，作谓语'
- 波斯语 می‌روم：'رفتن 现在时第一人称单数，作谓语'
- 波斯语 کتاب：'名词单数，作主语'（本身是原形时的写法）`;

const storageReady = initializeEntriesStorage().catch((error) => {
  console.error("[多语言查词助手] 存储初始化失败", error);
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("[多语言查词助手] 未处理错误", error);
      sendResponse({
        ok: false,
        error: serializeError(error)
      });
    });

  return true;
});

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    return createFailure("bad_request", "请求格式不正确");
  }

  switch (message.type) {
    case "LOOKUP_WORD":
      return lookupWord(message);
    case "REANALYZE_FORM":
      return reanalyzeForm(message);
    case "TOGGLE_STAR":
      return toggleStar(message);
    case "GET_ENTRIES":
      return getEntriesForPage();
    case "TEST_API_KEY":
      return testApiKey(message);
    case "GET_CACHE_STATS":
      return getCacheStats();
    case "CLEAR_CACHE":
      return clearCache();
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return createFailure("bad_request", "未知请求类型");
  }
}

async function lookupWord(message) {
  const word = normalizeInput(message.word);
  const context = normalizeContext(message.sentence || word);

  if (!word) {
    return createFailure("bad_request", "未检测到可查询的单词");
  }

  const entries = await getEntries();
  const cached = findCachedEntry(entries, word, context);

  if (cached && message.useCache !== false) {
    return {
      ok: true,
      cached: true,
      id: cached.id,
      data: cached
    };
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return createFailure("missing_key", "请先在扩展设置中配置DeepSeek API Key");
  }

  const data = await queryDeepSeek(apiKey, word, context);
  const entry = createEntry(data, word, context);
  entries.push(entry);
  await saveEntries(entries);

  return {
    ok: true,
    cached: false,
    id: entry.id,
    data: entry
  };
}

async function reanalyzeForm(message) {
  const word = normalizeInput(message.word);
  const context = normalizeContext(message.sentence || word);

  if (!word) {
    return createFailure("bad_request", "未检测到可查询的单词");
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return createFailure("missing_key", "请先在扩展设置中配置DeepSeek API Key");
  }

  const entries = await getEntries();
  const entryIndex = findEntryIndex(entries, message.id, word, context);
  const cached = entryIndex >= 0 ? entries[entryIndex] : null;

  const fresh = await queryDeepSeek(apiKey, word, context);
  const merged = {
    id: cached?.id || generateId(),
    word: fresh.word || cached?.word || word,
    translit: fresh.translit || cached?.translit || "",
    etymology: fresh.etymology || cached?.etymology || "",
    meaning: fresh.meaning || cached?.meaning || "",
    form: fresh.form || cached?.form || "",
    lang: fresh.lang || cached?.lang || "未知语言",
    context,
    timestamp: Date.now(),
    starred: Boolean(cached?.starred)
  };

  if (entryIndex >= 0) {
    entries[entryIndex] = merged;
  } else {
    entries.push(merged);
  }
  await saveEntries(entries);

  return {
    ok: true,
    cached: false,
    id: merged.id,
    data: merged
  };
}

async function toggleStar(message) {
  const entries = await getEntries();
  const id = normalizeInput(message.id);
  const index = entries.findIndex((entry) => entry.id === id);

  if (index < 0) {
    return createFailure("not_found", "未找到这条查询记录");
  }

  const nextStarred = typeof message.starred === "boolean"
    ? message.starred
    : !entries[index].starred;

  entries[index] = {
    ...entries[index],
    starred: nextStarred
  };
  await saveEntries(entries);

  return {
    ok: true,
    data: entries[index]
  };
}

async function getEntriesForPage() {
  const entries = await getEntries();
  return {
    ok: true,
    entries
  };
}

async function testApiKey(message) {
  const apiKey = normalizeInput(message.apiKey);
  const word = normalizeInput(message.word) || "سلام";
  const sentence = normalizeInput(message.sentence) || `测试词：${word}`;

  if (!apiKey) {
    return createFailure("missing_key", "请先输入DeepSeek API Key");
  }

  const data = await queryDeepSeek(apiKey, word, sentence);
  return {
    ok: true,
    data
  };
}

async function getCacheStats() {
  const entries = await getEntries();
  return {
    ok: true,
    count: entries.length,
    starredCount: entries.filter((entry) => entry.starred).length
  };
}

async function clearCache() {
  const entries = await getEntries();
  const preservedEntries = entries.filter((entry) => entry.starred);
  await saveEntries(preservedEntries);
  await removeStorage([LEGACY_CACHE_STORAGE_KEY]);
  return {
    ok: true,
    count: preservedEntries.length,
    starredCount: preservedEntries.length
  };
}

async function queryDeepSeek(apiKey, word, sentence) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT
          },
          {
            role: "user",
            content: `单词：${word}\n句子：${sentence}`
          }
        ]
      })
    });

    const responseText = await response.text();
    const payload = parseApiResponseBody(responseText);

    if (!response.ok) {
      throw buildApiError(response.status, payload, responseText);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      const error = new Error("解析失败");
      error.type = "invalid_json";
      error.rawResponse = responseText;
      throw error;
    }

    return normalizeAnalysis(parseModelJson(content), word);
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("请求超时，请重试");
      timeoutError.type = "timeout";
      throw timeoutError;
    }

    if (error.type) {
      throw error;
    }

    const networkError = new Error("网络错误，请重试");
    networkError.type = "network";
    networkError.originalMessage = error.message;
    throw networkError;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseApiResponseBody(responseText) {
  try {
    return JSON.parse(responseText);
  } catch {
    return null;
  }
}

function parseModelJson(content) {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // 继续抛出统一的解析失败错误，便于 content script 展示。
      }
    }

    const error = new Error("解析失败");
    error.type = "invalid_json";
    error.rawResponse = content;
    throw error;
  }
}

function normalizeAnalysis(data, fallbackWord) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const error = new Error("解析失败");
    error.type = "invalid_json";
    error.rawResponse = JSON.stringify(data);
    throw error;
  }

  return {
    word: toShortString(data.word) || fallbackWord,
    lang: toShortString(data.lang) || "未知语言",
    translit: toShortString(data.translit),
    etymology: toShortString(data.etymology),
    meaning: toShortString(data.meaning),
    form: toShortString(data.form || data.role)
  };
}

function buildApiError(status, payload, responseText) {
  const apiMessage = payload?.error?.message || responseText || "API调用失败";
  const error = new Error(apiMessage);
  error.status = status;

  if (status === 401) {
    error.type = "invalid_key";
    error.message = "API Key无效";
    return error;
  }

  if (
    status === 402 ||
    /insufficient|balance|quota|余额|账户余额|欠费/i.test(apiMessage)
  ) {
    error.type = "insufficient_balance";
    error.message = "DeepSeek账户余额不足";
    return error;
  }

  error.type = "api_error";
  return error;
}

async function getApiKey() {
  const result = await getStorage([API_KEY_STORAGE_KEY]);
  return normalizeInput(result[API_KEY_STORAGE_KEY]);
}

async function initializeEntriesStorage() {
  const result = await getStorage([ENTRIES_STORAGE_KEY, LEGACY_CACHE_STORAGE_KEY]);
  const now = Date.now();
  const normalized = normalizeEntriesArray(result[ENTRIES_STORAGE_KEY], now);
  const legacyEntries = convertLegacyCache(result[LEGACY_CACHE_STORAGE_KEY], now);
  const mergedEntries = normalized.entries.concat(legacyEntries);
  const cleanedEntries = removeExpiredEntries(mergedEntries);

  if (
    normalized.changed ||
    legacyEntries.length > 0 ||
    cleanedEntries.length !== mergedEntries.length ||
    !Array.isArray(result[ENTRIES_STORAGE_KEY])
  ) {
    await setStorage({ [ENTRIES_STORAGE_KEY]: cleanedEntries });
  }

  if (result[LEGACY_CACHE_STORAGE_KEY]) {
    await removeStorage([LEGACY_CACHE_STORAGE_KEY]);
  }
}

async function getEntries() {
  await storageReady;

  const result = await getStorage([ENTRIES_STORAGE_KEY]);
  const normalized = normalizeEntriesArray(result[ENTRIES_STORAGE_KEY], Date.now());

  if (normalized.changed || !Array.isArray(result[ENTRIES_STORAGE_KEY])) {
    await saveEntries(normalized.entries);
  }

  return normalized.entries;
}

async function saveEntries(entries) {
  await setStorage({ [ENTRIES_STORAGE_KEY]: entries });
}

function createEntry(data, fallbackWord, context) {
  const timestamp = Date.now();

  return {
    id: generateId(),
    word: toShortString(data.word) || fallbackWord,
    translit: toShortString(data.translit),
    etymology: toShortString(data.etymology),
    meaning: toShortString(data.meaning),
    form: toShortString(data.form || data.role),
    lang: toShortString(data.lang) || "未知语言",
    context,
    timestamp,
    starred: false
  };
}

function normalizeEntriesArray(value, now) {
  if (!Array.isArray(value)) {
    return {
      entries: [],
      changed: value !== undefined
    };
  }

  let changed = false;
  const entries = [];

  for (const item of value) {
    const entry = normalizeEntry(item, now);
    if (!entry) {
      changed = true;
      continue;
    }

    entries.push(entry);
    if (!isEntryEquivalent(item, entry)) {
      changed = true;
    }
  }

  return {
    entries,
    changed
  };
}

function isEntryEquivalent(original, normalized) {
  return original.id === normalized.id &&
    original.word === normalized.word &&
    (original.translit || "") === normalized.translit &&
    (original.etymology || "") === normalized.etymology &&
    (original.meaning || "") === normalized.meaning &&
    (original.form || original.role || "") === normalized.form &&
    (original.lang || "未知语言") === normalized.lang &&
    normalizeContext(original.context || original.sentence || "") === normalized.context &&
    Number(original.timestamp ?? original.updatedAt) === normalized.timestamp &&
    Boolean(original.starred) === normalized.starred;
}

function normalizeEntry(item, now) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const word = toShortString(item.word);
  if (!word) {
    return null;
  }

  return {
    id: toShortString(item.id) || generateId(),
    word,
    translit: toShortString(item.translit),
    etymology: toShortString(item.etymology),
    meaning: toShortString(item.meaning),
    form: toShortString(item.form || item.role),
    lang: toShortString(item.lang) || "未知语言",
    context: normalizeContext(item.context || item.sentence || ""),
    timestamp: normalizeTimestamp(item.timestamp ?? item.updatedAt, now),
    starred: Boolean(item.starred)
  };
}

function convertLegacyCache(cache, now) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return [];
  }

  return Object.values(cache)
    .map((item) => normalizeEntry({
      ...item,
      id: item?.id || generateId(),
      context: item?.context || "",
      timestamp: now,
      starred: Boolean(item?.starred)
    }, now))
    .filter(Boolean);
}

function removeExpiredEntries(entries) {
  const cutoff = getSixMonthsAgoTimestamp();
  return entries.filter((entry) => entry.starred || entry.timestamp >= cutoff);
}

function getSixMonthsAgoTimestamp() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  return cutoff.getTime();
}

function findEntryIndex(entries, id, word, context) {
  const normalizedId = normalizeInput(id);
  if (normalizedId) {
    const idIndex = entries.findIndex((entry) => entry.id === normalizedId);
    if (idIndex >= 0) {
      return idIndex;
    }
  }

  return entries.findIndex((entry) => isSameLookup(entry, word, context));
}

function findCachedEntry(entries, word, context) {
  return entries.find((entry) => isSameLookup(entry, word, context)) || null;
}

function isSameLookup(entry, word, context) {
  const target = normalizeCacheWord(word);
  const targetContext = normalizeContext(context);

  return normalizeCacheWord(entry.word) === target && normalizeContext(entry.context) === targetContext;
}

function getStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function setStorage(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function removeStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createFailure(type, message, extra = {}) {
  return {
    ok: false,
    error: {
      type,
      message,
      ...extra
    }
  };
}

function serializeError(error) {
  return {
    type: error.type || "unknown",
    message: error.message || "未知错误",
    status: error.status,
    rawResponse: error.rawResponse,
    originalMessage: error.originalMessage
  };
}

function normalizeInput(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeContext(value) {
  return normalizeInput(value);
}

function normalizeCacheWord(value) {
  return normalizeInput(value).toLocaleLowerCase();
}

function normalizeTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function toShortString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim().replace(/\s+/g, " ");
}

function generateId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

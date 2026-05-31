import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 30 * 60 * 1000);
const REQUEST_TIMEOUT_MS = 18000;
const REQUEST_RETRIES = 2;
const DATA_DIR = path.join(__dirname, "data");
const LEARNING_STATE_FILE = path.join(DATA_DIR, "learning-state.json");
const STORED_PREDICTION_COUNT = 80;
const MAX_STORED_PREDICTIONS = 800;
const MAX_HISTORY = 500;

const DEFAULT_WEIGHTS = {
  bias: 0,
  changePct: 0.24,
  intradayPct: 0.2,
  closePosition: 0.24,
  averageGapPct: 0.12,
  liquidityScore: 0.08,
  valuationScore: 0.08,
  institutionRatio: 0.1,
  overheat: -0.25,
  peRisk: -0.12,
  pbRisk: -0.12
};

const FEATURE_LABELS = {
  changePct: "日漲跌動能",
  intradayPct: "盤中買盤延續",
  closePosition: "收盤位置",
  averageGapPct: "均價乖離",
  liquidityScore: "成交流動性",
  valuationScore: "估值條件",
  institutionRatio: "法人籌碼",
  overheat: "過熱風險",
  peRisk: "本益比風險",
  pbRisk: "淨值比風險"
};

const DATA_SOURCES = [
  {
    key: "listedRows",
    label: "TWSE 上市個股日成交資訊",
    url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
  },
  {
    key: "listedAverageRows",
    label: "TWSE 上市個股日收盤價及月平均價",
    url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL"
  },
  {
    key: "listedValueRows",
    label: "TWSE 上市個股本益比、殖利率、股價淨值比",
    url: "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL"
  },
  {
    key: "tpexRows",
    label: "TPEx 上櫃股票收盤行情",
    url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"
  },
  {
    key: "tpexValueRows",
    label: "TPEx 上櫃股票本益比、殖利率、股價淨值比",
    url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis"
  },
  {
    key: "tpexInstitutionRows",
    label: "TPEx 上櫃股票三大法人買賣明細",
    url: "https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading"
  }
];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let cache = {
  status: "cold",
  data: null,
  error: null,
  startedAt: null,
  finishedAt: null
};
let refreshPromise = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .replace(/,/g, "")
    .replace(/%/g, "")
    .replace(/^\+/, "")
    .trim();

  if (!normalized || ["N/A", "--", "---", "-", "X0.00"].includes(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function rocDateToIso(rocDate) {
  const value = String(rocDate || "").trim();
  const normalized = value.replace(/[./]/g, "/").replace(/-/g, "/");
  if (/^\d{3}\/\d{1,2}\/\d{1,2}$/.test(normalized)) {
    const [year, month, day] = normalized.split("/");
    return `${Number(year) + 1911}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(normalized)) {
    const [year, month, day] = normalized.split("/");
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  if (!/^\d{7}$/.test(value)) return value || null;
  const year = Number(value.slice(0, 3)) + 1911;
  const month = value.slice(3, 5);
  const day = value.slice(5, 7);
  return `${year}-${month}-${day}`;
}

function toTaipeiTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function getTaipeiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function createDefaultLearningState() {
  return {
    version: 2,
    learningRate: 0.08,
    weights: { ...DEFAULT_WEIGHTS },
    predictions: [],
    history: [],
    stats: {
      totalEvaluated: 0,
      correct: 0,
      accuracy: null,
      recentAccuracy: null,
      averageReturnPct: null,
      lastUpdatedAt: null
    }
  };
}

async function loadLearningState() {
  try {
    const raw = await fs.readFile(LEARNING_STATE_FILE, "utf8");
    const loaded = JSON.parse(raw);
    const fallback = createDefaultLearningState();
    const normalized = {
      ...fallback,
      ...loaded,
      weights: {
        ...fallback.weights,
        ...(loaded.weights || {})
      },
      predictions: Array.isArray(loaded.predictions) ? loaded.predictions : [],
      history: Array.isArray(loaded.history) ? loaded.history : [],
      stats: {
        ...fallback.stats,
        ...(loaded.stats || {})
      }
    };

    if (loaded.version !== fallback.version && !normalized.history.length) {
      normalized.weights = { ...fallback.weights };
      normalized.version = fallback.version;
    }

    return normalized;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("[learning] reset unreadable state:", error.message);
    }

    return createDefaultLearningState();
  }
}

async function saveLearningState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(LEARNING_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-clamp(value, -12, 12)));
}

function scoreFeatures(features, weights) {
  return Object.entries(features).reduce((sum, [key, value]) => {
    return sum + (weights[key] || 0) * value;
  }, weights.bias || 0);
}

function extractLearningFeatures(stock, metrics) {
  const institutionRatio = metrics.institutionRatio ?? 0;

  return {
    changePct: clamp(metrics.changePct / 10, -1, 1),
    intradayPct: clamp(metrics.intradayPct / 8, -1, 1),
    closePosition: clamp((metrics.closePosition - 50) / 50, -1, 1),
    averageGapPct: clamp(metrics.averageGapPct / 15, -1, 1),
    liquidityScore: clamp((metrics.liquidityScore - 50) / 50, -1, 1),
    valuationScore: clamp((metrics.valuationScore - 50) / 50, -1, 1),
    institutionRatio: clamp(institutionRatio / 18, -1, 1),
    overheat: clamp((metrics.changePct - 6) / 6, 0, 1),
    peRisk: stock.pe ? clamp((stock.pe - 35) / 60, 0, 1) : 0,
    pbRisk: stock.pb ? clamp((stock.pb - 4) / 8, 0, 1) : 0
  };
}

function applyLearningResult(state, prediction, actualUp, wasCorrect) {
  const features = prediction.features || {};
  const predicted = sigmoid(scoreFeatures(features, state.weights));
  const error = (actualUp ? 1 : 0) - predicted;
  const learningRate = Number(state.learningRate || 0.08) * (wasCorrect ? 0.65 : 1.35);

  state.weights.bias = clamp((state.weights.bias || 0) + learningRate * error, -3, 3);

  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    if (key === "bias") continue;
    const current = state.weights[key] ?? DEFAULT_WEIGHTS[key];
    state.weights[key] = Number(clamp(current + learningRate * error * (features[key] || 0), -3, 3).toFixed(5));
  }

  state.weights.bias = Number(state.weights.bias.toFixed(5));
}

function evaluatePendingPredictions(state, stocks, latestDate) {
  const byCode = new Map(stocks.map((stock) => [stock.code, stock]));
  const events = [];

  for (const prediction of state.predictions) {
    if (prediction.evaluated || !prediction.sourceDate || prediction.sourceDate >= latestDate) continue;

    const actual = byCode.get(prediction.code);
    if (!actual || !prediction.close) continue;

    const returnPct = ((actual.close - prediction.close) / prediction.close) * 100;
    const actualDirection = returnPct > 0 ? "up" : "down";
    const predictedDirection = prediction.prediction?.direction === "跌" ? "down" : "up";
    const correct = actualDirection === predictedDirection;

    applyLearningResult(state, prediction, actualDirection === "up", correct);

    const event = {
      sourceDate: prediction.sourceDate,
      evaluatedDate: latestDate,
      code: prediction.code,
      name: prediction.name,
      market: prediction.market,
      predictedDirection,
      predictedProbability: prediction.prediction?.probability ?? null,
      previousClose: prediction.close,
      currentClose: actual.close,
      returnPct: Number(returnPct.toFixed(2)),
      actualDirection,
      correct,
      evaluatedAt: new Date().toISOString()
    };

    prediction.evaluated = true;
    prediction.evaluatedDate = latestDate;
    events.push(event);
    state.history.push(event);
  }

  state.history = state.history.slice(-MAX_HISTORY);
  state.predictions = state.predictions.slice(-MAX_STORED_PREDICTIONS);
  updateLearningStats(state);

  return events;
}

function updateLearningStats(state) {
  const history = state.history || [];
  const recent = history.slice(-30);
  const correct = history.filter((item) => item.correct).length;
  const recentCorrect = recent.filter((item) => item.correct).length;
  const averageReturn = history.length
    ? history.reduce((sum, item) => sum + item.returnPct, 0) / history.length
    : null;

  state.stats = {
    totalEvaluated: history.length,
    correct,
    accuracy: history.length ? Number(((correct / history.length) * 100).toFixed(1)) : null,
    recentAccuracy: recent.length ? Number(((recentCorrect / recent.length) * 100).toFixed(1)) : null,
    averageReturnPct: averageReturn === null ? null : Number(averageReturn.toFixed(2)),
    lastUpdatedAt: history.length ? history[history.length - 1].evaluatedAt : null
  };
}

function recordCurrentPredictions(state, candidates, latestDate) {
  const now = new Date().toISOString();
  const sampleIndices = new Set();
  for (let index = 0; index < Math.min(50, candidates.length); index += 1) {
    sampleIndices.add(index);
  }
  for (let offset = 0; offset < Math.min(30, candidates.length); offset += 1) {
    sampleIndices.add(candidates.length - 1 - offset);
  }

  const additions = [...sampleIndices].sort((a, b) => a - b).slice(0, STORED_PREDICTION_COUNT).map((candidateIndex) => {
    const stock = candidates[candidateIndex];

    return {
    id: `${latestDate}:${stock.code}`,
    rank: candidateIndex + 1,
    sourceDate: latestDate,
    code: stock.code,
    name: stock.name,
    market: stock.market,
    close: stock.close,
    score: stock.score,
    prediction: stock.prediction,
    metrics: stock.metrics,
    features: stock.features,
    evaluated: false,
    createdAt: now
    };
  });

  const existingPending = state.predictions.filter((prediction) => {
    return prediction.sourceDate === latestDate && !prediction.evaluated;
  });
  const existingById = new Map(existingPending.map((prediction) => [prediction.id, prediction]));
  const unchanged = additions.length === existingPending.length && additions.every((addition) => {
    const existing = existingById.get(addition.id);
    return existing
      && existing.rank === addition.rank
      && existing.close === addition.close
      && existing.score === addition.score
      && existing.prediction?.direction === addition.prediction?.direction
      && existing.prediction?.probability === addition.prediction?.probability;
  });

  if (unchanged) {
    updateLearningStats(state);
    return;
  }

  state.predictions = state.predictions.filter((prediction) => {
    return prediction.sourceDate !== latestDate || prediction.evaluated;
  });
  state.predictions.push(...additions);
  state.predictions = state.predictions.slice(-MAX_STORED_PREDICTIONS);
  updateLearningStats(state);
}

function buildLearningSummary(state, events, latestDate) {
  const pending = state.predictions.filter((prediction) => !prediction.evaluated).length;
  const weightEntries = Object.entries(state.weights)
    .filter(([key]) => key !== "bias")
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 6)
    .map(([key, value]) => ({
      key,
      label: FEATURE_LABELS[key] || key,
      weight: Number(value.toFixed(3)),
      direction: value >= 0 ? "positive" : "negative"
    }));

  return {
    latestDate,
    enabled: true,
    stateStore: "data/learning-state.json",
    learningRate: state.learningRate,
    stats: state.stats,
    pendingPredictions: pending,
    evaluatedThisRefresh: events.length,
    lastEvents: state.history.slice(-8).reverse(),
    topWeights: weightEntries
  };
}

async function fetchJson(source) {
  let lastError;

  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(source.url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "taiwan-stock-tomorrow-lab/1.0"
        }
      });

      if (!response.ok) {
        throw new Error(`${source.label} returned ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error(`${source.label} returned non-JSON data`);
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error(`${source.label} returned an unexpected payload`);
      }

      return data;
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function fetchAllSources() {
  const results = await Promise.all(DATA_SOURCES.map(async (source) => {
    try {
      const rows = await fetchJson(source);
      return {
        source,
        rows,
        status: {
          key: source.key,
          label: source.label,
          url: source.url,
          ok: true,
          rowCount: rows.length
        }
      };
    } catch (error) {
      console.warn(`[source] ${source.label}: ${error.message}`);
      return {
        source,
        rows: [],
        status: {
          key: source.key,
          label: source.label,
          url: source.url,
          ok: false,
          rowCount: 0,
          error: error.message
        }
      };
    }
  }));

  const rowsByKey = Object.fromEntries(results.map((result) => [result.source.key, result.rows]));
  const statuses = results.map((result) => result.status);

  return { rowsByKey, statuses };
}

function mapByCode(rows, codeKey = "Code") {
  const map = new Map();
  for (const row of rows || []) {
    const code = String(row?.[codeKey] || "").trim();
    if (code) map.set(code, row);
  }
  return map;
}

function isCommonStockCode(code) {
  const value = String(code || "");
  const numericCode = Number(value);
  return /^\d{4}$/.test(value) && numericCode >= 1100 && !value.startsWith("91");
}

function normalizeListed(row, averageRow, valueRow) {
  const code = String(row.Code || "").trim();
  const close = safeNumber(row.ClosingPrice);
  const change = safeNumber(row.Change);
  const open = safeNumber(row.OpeningPrice);
  const high = safeNumber(row.HighestPrice);
  const low = safeNumber(row.LowestPrice);
  const volume = safeNumber(row.TradeVolume);
  const tradeValue = safeNumber(row.TradeValue);

  if (!isCommonStockCode(code) || !close || !open || !high || !low || !volume || !tradeValue) {
    return null;
  }

  return {
    market: "上市",
    code,
    name: row.Name,
    date: rocDateToIso(row.Date),
    close,
    change: change ?? 0,
    open,
    high,
    low,
    volume,
    tradeValue,
    transactions: safeNumber(row.Transaction),
    averagePrice: safeNumber(averageRow?.MonthlyAveragePrice),
    pe: safeNumber(valueRow?.PEratio),
    dividendYield: safeNumber(valueRow?.DividendYield),
    pb: safeNumber(valueRow?.PBratio),
    institutionNet: null,
    nextLimitUp: null
  };
}

function normalizeTpex(row, valueRow, institutionRow) {
  const code = String(row.SecuritiesCompanyCode || "").trim();
  const close = safeNumber(row.Close);
  const change = safeNumber(row.Change);
  const open = safeNumber(row.Open);
  const high = safeNumber(row.High);
  const low = safeNumber(row.Low);
  const volume = safeNumber(row.TradingShares);
  const tradeValue = safeNumber(row.TransactionAmount);

  if (!isCommonStockCode(code) || !close || !open || !high || !low || !volume || !tradeValue) {
    return null;
  }

  return {
    market: "上櫃",
    code,
    name: row.CompanyName,
    date: rocDateToIso(row.Date),
    close,
    change: change ?? 0,
    open,
    high,
    low,
    volume,
    tradeValue,
    transactions: safeNumber(row.TransactionNumber),
    averagePrice: safeNumber(row.Average),
    pe: safeNumber(valueRow?.PriceEarningRatio),
    dividendYield: safeNumber(valueRow?.YieldRatio),
    pb: safeNumber(valueRow?.PriceBookRatio),
    institutionNet: safeNumber(institutionRow?.TotalDifference),
    nextLimitUp: safeNumber(row.NextLimitUp)
  };
}

function calculateCandidate(stock, learningState = createDefaultLearningState()) {
  const previousClose = stock.close - stock.change;
  const changePct = previousClose > 0 ? (stock.change / previousClose) * 100 : 0;
  const intradayPct = stock.open > 0 ? ((stock.close - stock.open) / stock.open) * 100 : 0;
  const range = stock.high - stock.low;
  const closePosition = range > 0 ? (stock.close - stock.low) / range : 0.5;
  const averageGapPct = stock.averagePrice > 0 ? ((stock.close - stock.averagePrice) / stock.averagePrice) * 100 : 0;
  const liquidityScore = clamp((Math.log10(stock.tradeValue) - 6.7) / 1.25, 0, 1);
  const volumeScore = clamp((Math.log10(stock.volume) - 5.8) / 1.15, 0, 1);
  const valuationScore = calculateValuationScore(stock);
  const institutionRatio = Number.isFinite(stock.institutionNet) && stock.volume > 0
    ? stock.institutionNet / stock.volume
    : null;
  const institutionScore = institutionRatio === null
    ? 0
    : clamp(institutionRatio, -0.18, 0.18) / 0.18;
  const overheatPenalty = changePct > 7 ? (changePct - 7) * 1.8 : 0;
  const weaknessPenalty = closePosition < 0.35 ? (0.35 - closePosition) * 16 : 0;

  const overextendedPenalty = Math.max(0, changePct - 6) * 2.2 + Math.max(0, averageGapPct - 12) * 0.65;

  const rawScore =
    45 +
    clamp(changePct, -5, 6) * 1.8 +
    clamp(intradayPct, -4, 4) * 1.5 +
    (closePosition - 0.5) * 18 +
    clamp(averageGapPct, -6, 8) * 1.1 +
    liquidityScore * 7 +
    volumeScore * 3 +
    valuationScore * 7 +
    institutionScore * 5 -
    overextendedPenalty -
    overheatPenalty -
    weaknessPenalty;

  const baseScore = clamp(rawScore, 0, 100);
  const metricSnapshot = {
    changePct: Number(changePct.toFixed(2)),
    intradayPct: Number(intradayPct.toFixed(2)),
    closePosition: Number((closePosition * 100).toFixed(0)),
    averageGapPct: Number(averageGapPct.toFixed(2)),
    liquidityScore: Number((liquidityScore * 100).toFixed(0)),
    valuationScore: Number((valuationScore * 100).toFixed(0)),
    institutionRatio: institutionRatio === null ? null : Number((institutionRatio * 100).toFixed(2))
  };
  const features = extractLearningFeatures(stock, metricSnapshot);
  const learningLogit = scoreFeatures(features, learningState.weights);
  const learningAdjustment = clamp(learningLogit * 3, -8, 8);
  const score = clamp(baseScore + learningAdjustment, 0, 100);
  const probability = sigmoid((baseScore - 60) / 18 + learningLogit * 0.6) * 100;
  const confidence = clamp(44 + score * 0.48, 44, 92);

  return {
    ...stock,
    baseScore: Number(baseScore.toFixed(1)),
    score: Number(score.toFixed(1)),
    confidence: Number(confidence.toFixed(1)),
    metrics: metricSnapshot,
    features,
    prediction: {
      direction: probability >= 50 ? "漲" : "跌",
      probability: Number(probability.toFixed(1)),
      learningAdjustment: Number(learningAdjustment.toFixed(1))
    },
    reasons: buildReasons({
      stock,
      changePct,
      intradayPct,
      closePosition,
      averageGapPct,
      liquidityScore,
      valuationScore,
      institutionScore
    }),
    risks: buildRisks({
      stock,
      changePct,
      closePosition,
      averageGapPct,
      liquidityScore
    })
  };
}

function calculateValuationScore(stock) {
  let score = 0.5;

  if (stock.pe !== null) {
    if (stock.pe >= 6 && stock.pe <= 24) score += 0.2;
    else if (stock.pe > 45) score -= 0.22;
    else if (stock.pe <= 0) score -= 0.18;
  }

  if (stock.pb !== null) {
    if (stock.pb > 0 && stock.pb <= 2.5) score += 0.18;
    else if (stock.pb > 6) score -= 0.2;
  }

  if (stock.dividendYield !== null) {
    if (stock.dividendYield >= 3) score += 0.12;
    if (stock.dividendYield > 9) score -= 0.05;
  }

  return clamp(score, 0, 1);
}

function buildReasons(context) {
  const { stock, changePct, intradayPct, closePosition, averageGapPct, liquidityScore, valuationScore, institutionScore } = context;
  const reasons = [];

  if (changePct > 0) reasons.push(`日漲幅 ${changePct.toFixed(2)}%，短線動能偏強`);
  if (intradayPct > 0.8) reasons.push(`收盤高於開盤 ${intradayPct.toFixed(2)}%，買盤延續到尾盤`);
  if (closePosition >= 0.72) reasons.push(`收在日內區間上緣 ${Math.round(closePosition * 100)}%`);
  if (averageGapPct > 0) reasons.push(`股價高於均價 ${averageGapPct.toFixed(2)}%`);
  if (liquidityScore >= 0.62) reasons.push(`成交金額 ${formatCompact(stock.tradeValue)}，流動性足夠`);
  if (valuationScore >= 0.7) reasons.push("估值條件未明顯過熱");
  if (institutionScore > 0.08) reasons.push(`三大法人買超 ${formatCompact(stock.institutionNet)}`);

  return reasons.slice(0, 4);
}

function buildRisks(context) {
  const { stock, changePct, closePosition, averageGapPct, liquidityScore } = context;
  const risks = [];

  if (changePct > 6) risks.push("今日漲幅偏大，隔日容易震盪");
  if (closePosition < 0.45) risks.push("收盤未站上日內高位，追價力道不足");
  if (averageGapPct < -1) risks.push("股價仍低於均價，趨勢尚未轉強");
  if (averageGapPct > 12) risks.push("股價相對均價偏離較大，短線可能回檔");
  if (liquidityScore < 0.42) risks.push("成交金額偏低，進出成本可能放大");
  if (stock.pe && stock.pe > 45) risks.push("本益比偏高，評價壓力較大");
  if (stock.pb && stock.pb > 6) risks.push("股價淨值比偏高，波動風險較高");

  return risks.slice(0, 3);
}

function formatCompact(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "N/A";
  return new Intl.NumberFormat("zh-TW", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function buildMarketSummary(candidates) {
  const valid = candidates.filter((stock) => Number.isFinite(stock.metrics.changePct));
  const advancing = valid.filter((stock) => stock.metrics.changePct > 0).length;
  const declining = valid.filter((stock) => stock.metrics.changePct < 0).length;
  const totalValue = valid.reduce((sum, stock) => sum + stock.tradeValue, 0);
  const averageScore = valid.length
    ? valid.reduce((sum, stock) => sum + stock.score, 0) / valid.length
    : 0;

  return {
    totalStocks: valid.length,
    advancing,
    declining,
    advanceDeclineRatio: declining ? Number((advancing / declining).toFixed(2)) : advancing,
    totalTradeValue: totalValue,
    averageScore: Number(averageScore.toFixed(1))
  };
}

export async function refreshAnalysis(reason = "scheduled") {
  if (refreshPromise) return refreshPromise;

  refreshPromise = runRefreshAnalysis(reason).finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function runRefreshAnalysis(reason) {
  cache = {
    ...cache,
    status: "refreshing",
    error: null,
    startedAt: new Date().toISOString()
  };

  try {
    const { rowsByKey, statuses: sourceStatuses } = await fetchAllSources();
    const {
      listedRows = [],
      listedAverageRows = [],
      listedValueRows = [],
      tpexRows = [],
      tpexValueRows = [],
      tpexInstitutionRows = []
    } = rowsByKey;

    const listedAverageByCode = mapByCode(listedAverageRows);
    const listedValueByCode = mapByCode(listedValueRows);
    const tpexValueByCode = mapByCode(tpexValueRows, "SecuritiesCompanyCode");
    const tpexInstitutionByCode = mapByCode(tpexInstitutionRows, "SecuritiesCompanyCode");

    const listedStocks = listedRows
      .map((row) => {
        const code = String(row.Code || "").trim();
        return normalizeListed(row, listedAverageByCode.get(code), listedValueByCode.get(code));
      })
      .filter(Boolean);

    const tpexStocks = tpexRows
      .map((row) => {
        const code = String(row.SecuritiesCompanyCode || "").trim();
        return normalizeTpex(row, tpexValueByCode.get(code), tpexInstitutionByCode.get(code));
      })
      .filter(Boolean);

    const stocks = [...listedStocks, ...tpexStocks];
    if (!stocks.length) {
      throw new Error("官方資料來源暫時沒有可用股票行情");
    }

    const latestDate = stocks.reduce((latest, stock) => {
      return stock.date && stock.date > latest ? stock.date : latest;
    }, "");
    const learningState = await loadLearningState();
    const learningEvents = latestDate
      ? evaluatePendingPredictions(learningState, stocks, latestDate)
      : [];

    const candidates = stocks
      .filter((stock) => stock.close >= 8)
      .filter((stock) => stock.tradeValue >= 12_000_000)
      .map((stock) => calculateCandidate(stock, learningState))
      .sort((a, b) => b.score - a.score);
    const bullishCandidates = candidates.filter((stock) => stock.prediction.direction === "漲");

    if (latestDate) {
      recordCurrentPredictions(learningState, candidates, latestDate);
      await saveLearningState(learningState);
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      generatedAtTaipei: toTaipeiTimestamp(),
      reason,
      latestTradingDate: latestDate,
      topPicks: (bullishCandidates.length >= 3 ? bullishCandidates : candidates).slice(0, 3),
      candidates: candidates.slice(0, 80),
      marketSummary: buildMarketSummary(candidates),
      learning: buildLearningSummary(learningState, learningEvents, latestDate),
      sources: sourceStatuses,
      model: {
        name: "Adaptive Momentum-Value-Liquidity v2",
        factors: [
          "日漲幅與盤中收盤位置",
          "收盤相對均價",
          "成交金額與成交量",
          "估值條件",
          "上櫃三大法人買賣超",
          "錯誤回饋後自動調整權重"
        ],
        caveat: "模型會用隔日實際收盤結果修正權重，但排名只代表量化研究分數，不保證隔日上漲，也不是投資建議。"
      }
    };

    cache = {
      status: "ready",
      data: payload,
      error: null,
      startedAt: cache.startedAt,
      finishedAt: new Date().toISOString()
    };

    return payload;
  } catch (error) {
    cache = {
      ...cache,
      status: cache.data ? "ready" : "error",
      error: error.message,
      finishedAt: new Date().toISOString()
    };

    if (cache.data) return cache.data;
    throw error;
  }
}

function shouldAutoRefresh() {
  const { weekday, hour } = getTaipeiParts();
  const numericHour = Number(hour);
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  return isWeekday && numericHour >= 13 && numericHour <= 20;
}

app.get("/api/analysis", async (_request, response) => {
  try {
    if (!cache.data) {
      await refreshAnalysis("first-load");
    }

    response.json({
      ...cache.data,
      cacheStatus: cache.status,
      cacheError: cache.error,
      nextAutoRefreshMinutes: Math.round(REFRESH_INTERVAL_MS / 60000)
    });
  } catch (error) {
    response.status(502).json({
      error: "資料更新失敗",
      detail: error.message,
      sources: DATA_SOURCES
    });
  }
});

app.post("/api/refresh", async (_request, response) => {
  try {
    const data = await refreshAnalysis("manual");
    response.json({
      ...data,
      cacheStatus: cache.status,
      cacheError: cache.error
    });
  } catch (error) {
    response.status(502).json({
      error: "資料更新失敗",
      detail: error.message,
      sources: DATA_SOURCES
    });
  }
});

export { app };

export function startServer() {
  const refreshTimer = setInterval(() => {
    if (shouldAutoRefresh()) {
      refreshAnalysis("auto-window").catch((error) => {
        console.error("[refresh]", error);
      });
    }
  }, REFRESH_INTERVAL_MS);

  const server = app.listen(PORT, () => {
    console.log(`Taiwan stock research site: http://localhost:${PORT}`);
    refreshAnalysis("startup").catch((error) => {
      console.error("[startup refresh]", error);
    });
  });

  return { server, refreshTimer };
}

if (path.resolve(process.argv[1] || "") === __filename) {
  startServer();
}

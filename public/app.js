const state = {
  analysis: null,
  market: "all"
};

const elements = {
  statusBadge: document.querySelector("#statusBadge"),
  refreshButton: document.querySelector("#refreshButton"),
  totalStocks: document.querySelector("#totalStocks"),
  breadth: document.querySelector("#breadth"),
  totalTradeValue: document.querySelector("#totalTradeValue"),
  averageScore: document.querySelector("#averageScore"),
  updatedAt: document.querySelector("#updatedAt"),
  topPicks: document.querySelector("#topPicks"),
  factorList: document.querySelector("#factorList"),
  modelCaveat: document.querySelector("#modelCaveat"),
  learningBadge: document.querySelector("#learningBadge"),
  learningAccuracy: document.querySelector("#learningAccuracy"),
  learningEvaluated: document.querySelector("#learningEvaluated"),
  learningRecent: document.querySelector("#learningRecent"),
  learningPending: document.querySelector("#learningPending"),
  learningWeights: document.querySelector("#learningWeights"),
  learningEvents: document.querySelector("#learningEvents"),
  candidateRows: document.querySelector("#candidateRows"),
  sourceLinks: document.querySelector("#sourceLinks"),
  scoreChart: document.querySelector("#scoreChart"),
  filters: document.querySelectorAll(".filter")
};

const numberFormat = new Intl.NumberFormat("zh-TW");
const compactFormat = new Intl.NumberFormat("zh-TW", {
  notation: "compact",
  maximumFractionDigits: 1
});

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? numberFormat.format(value) : "--";
}

function formatCompact(value) {
  return Number.isFinite(Number(value)) ? compactFormat.format(value) : "--";
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(2)}%`;
}

function formatSigned(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(1)}`;
}

function formatMoney(value) {
  if (!Number.isFinite(Number(value))) return "--";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 億`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(0)} 萬`;
  return formatNumber(value);
}

function setLoading(isLoading) {
  elements.refreshButton.disabled = isLoading;
  if (isLoading) elements.statusBadge.textContent = "更新中";
}

function boundedPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, numeric));
}

function formatProbability(stock) {
  const value = stock?.prediction?.probability ?? stock?.confidence;
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : "--";
}

function formatPrediction(stock) {
  const direction = stock?.prediction?.direction || "--";
  const value = stock?.prediction?.probability;
  return Number.isFinite(Number(value)) ? `${direction} ${Number(value).toFixed(1)}%` : direction;
}

async function loadAnalysis(manual = false) {
  setLoading(true);

  try {
    const data = await fetchAnalysis(manual);

    state.analysis = data;
    render(data);
    elements.statusBadge.textContent = data.staticMode
      ? "靜態資料"
      : data.cacheError ? "快取資料" : "已更新";
  } catch (error) {
    elements.statusBadge.textContent = "失敗";
    elements.topPicks.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  } finally {
    setLoading(false);
    if (window.lucide) window.lucide.createIcons();
  }
}

async function fetchAnalysis(manual) {
  if (usesStaticAnalysis()) {
    return fetchStaticAnalysis();
  }

  const dynamicPath = manual ? "api/refresh" : "api/analysis";

  try {
    const response = await fetch(dynamicPath, {
      method: manual ? "POST" : "GET",
      headers: {
        accept: "application/json"
      }
    });
    return readJsonResponse(response, "即時資料讀取失敗");
  } catch (dynamicError) {
    try {
      return await fetchStaticAnalysis();
    } catch {
      throw dynamicError;
    }
  }
}

function usesStaticAnalysis() {
  return window.location.hostname.endsWith("github.io")
    || window.location.protocol === "file:"
    || window.location.port === "4173";
}

async function fetchStaticAnalysis() {
  const staticResponse = await fetch(`api/analysis.json?ts=${Date.now()}`, {
    headers: {
      accept: "application/json"
    }
  });

  return {
    ...(await readJsonResponse(staticResponse, "靜態資料讀取失敗")),
    staticMode: true
  };
}

async function readJsonResponse(response, fallbackMessage) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${fallbackMessage} (${response.status})`);
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || data.error || `${fallbackMessage} (${response.status})`);
  }

  return data;
}

function render(data) {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  renderSummary(data.marketSummary || {});
  renderTopPicks(Array.isArray(data.topPicks) ? data.topPicks : []);
  renderModel(data.model || { factors: [], caveat: "" });
  renderLearning(data.learning);
  renderTable(candidates);
  renderSources(Array.isArray(data.sources) ? data.sources : []);
  renderChart(candidates);
  elements.updatedAt.textContent = data.generatedAtTaipei || "--";
}

function renderSummary(summary) {
  elements.totalStocks.textContent = formatNumber(summary.totalStocks);
  elements.breadth.textContent = `${formatNumber(summary.advancing)} / ${formatNumber(summary.declining)}`;
  elements.totalTradeValue.textContent = formatMoney(summary.totalTradeValue);
  elements.averageScore.textContent = summary.averageScore?.toFixed?.(1) ?? "--";
}

function renderTopPicks(picks) {
  if (!picks?.length) {
    elements.topPicks.innerHTML = `<div class="empty-state">目前沒有符合篩選條件的候選股。</div>`;
    return;
  }

  elements.topPicks.innerHTML = picks.map((stock, index) => `
    <article class="pick-card rank-${index + 1}">
      <span class="rank-pill">#${index + 1}</span>
      <div class="stock-title">
        <div>
          <h3>${escapeHtml(stock.name)}</h3>
          <p>${escapeHtml(stock.code)}</p>
        </div>
        <span class="market-tag">${escapeHtml(stock.market)}</span>
      </div>

      <div class="confidence">
        <div class="confidence-head">
          <span>AI 上漲機率</span>
          <strong>${formatProbability(stock)}</strong>
        </div>
        <div class="bar"><span style="width:${boundedPercent(stock.prediction?.probability ?? stock.confidence)}%"></span></div>
      </div>

      <div class="quote-grid">
        <div class="quote-item">
          <span>收盤價</span>
          <strong>${stock.close.toFixed(2)}</strong>
        </div>
        <div class="quote-item">
          <span>日漲跌</span>
          <strong class="${stock.metrics.changePct >= 0 ? "positive" : "negative"}">${formatPercent(stock.metrics.changePct)}</strong>
        </div>
        <div class="quote-item">
          <span>成交金額</span>
          <strong>${formatMoney(stock.tradeValue)}</strong>
        </div>
        <div class="quote-item">
          <span>收盤位置</span>
          <strong>${stock.metrics.closePosition}%</strong>
        </div>
        <div class="quote-item">
          <span>AI修正</span>
          <strong class="${(stock.prediction?.learningAdjustment ?? 0) >= 0 ? "positive" : "negative"}">${formatSigned(stock.prediction?.learningAdjustment ?? 0)}</strong>
        </div>
      </div>

      <ul class="reason-list">
        ${stock.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
      </ul>
      <ul class="risk-list">
        ${(stock.risks.length ? stock.risks : ["隔日仍可能受大盤、消息面與流動性影響"]).map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}
      </ul>
    </article>
  `).join("");
}

function renderModel(model) {
  elements.factorList.innerHTML = model.factors
    .map((factor) => `<li>${escapeHtml(factor)}</li>`)
    .join("");
  elements.modelCaveat.textContent = model.caveat;
}

function renderLearning(learning) {
  if (!learning) return;

  const stats = learning.stats || {};
  const accuracy = stats.accuracy === null || stats.accuracy === undefined ? "--" : `${stats.accuracy}%`;
  const recentAccuracy = stats.recentAccuracy === null || stats.recentAccuracy === undefined ? "--" : `${stats.recentAccuracy}%`;

  elements.learningBadge.textContent = learning.evaluatedThisRefresh > 0
    ? `本次驗證 ${learning.evaluatedThisRefresh} 筆`
    : "等待下一交易日";
  elements.learningAccuracy.textContent = accuracy;
  elements.learningEvaluated.textContent = formatNumber(stats.totalEvaluated || 0);
  elements.learningRecent.textContent = recentAccuracy;
  elements.learningPending.textContent = formatNumber(learning.pendingPredictions || 0);

  elements.learningWeights.innerHTML = (learning.topWeights || []).map((item) => `
    <div class="weight-item">
      <span>${escapeHtml(item.label)}</span>
      <strong class="${item.direction === "positive" ? "positive" : "negative"}">${item.weight > 0 ? "+" : ""}${item.weight}</strong>
    </div>
  `).join("");

  elements.learningEvents.innerHTML = (learning.lastEvents || []).slice(0, 4).map((event) => `
    <div class="event-item">
      <span>${escapeHtml(event.code)} ${escapeHtml(event.name)}</span>
      <strong class="${event.correct ? "positive" : "negative"}">${event.correct ? "命中" : "修正"} ${formatPercent(event.returnPct)}</strong>
    </div>
  `).join("") || `<div class="event-item muted-event">下一個交易日收盤後開始驗證。</div>`;
}

function renderTable(candidates) {
  const filtered = state.market === "all"
    ? candidates
    : candidates.filter((stock) => stock.market === state.market);

  if (!filtered.length) {
    elements.candidateRows.innerHTML = `<tr><td colspan="9" class="empty-row">目前沒有符合篩選條件的候選股。</td></tr>`;
    return;
  }

  elements.candidateRows.innerHTML = filtered.slice(0, 40).map((stock, index) => `
    <tr>
      <td>${index + 1}</td>
      <td class="stock-cell">
        <strong>${escapeHtml(stock.name)}</strong>
        <span>${escapeHtml(stock.code)}</span>
      </td>
      <td>${escapeHtml(stock.market)}</td>
      <td>${stock.close.toFixed(2)}</td>
      <td class="${stock.metrics.changePct >= 0 ? "positive" : "negative"}">${formatPercent(stock.metrics.changePct)}</td>
      <td>${formatMoney(stock.tradeValue)}</td>
      <td>${formatPrediction(stock)}</td>
      <td>PE ${stock.pe ?? "--"} / PB ${stock.pb ?? "--"}</td>
      <td><span class="score-chip">${stock.score.toFixed(1)}</span></td>
    </tr>
  `).join("");
}

function renderSources(sources) {
  elements.sourceLinks.innerHTML = sources.map((source) => `
    <a class="${source.ok === false ? "source-warning" : ""}" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.label)}</a>
  `).join("");
}

function renderChart(candidates) {
  const canvas = elements.scoreChart;
  const context = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || 520));
  const height = 300;

  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const padding = { top: 24, right: 22, bottom: 46, left: 46 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const top = candidates.slice(0, 12).reverse();

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fbfcfd";
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "#dce4ea";
  context.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (chartHeight / 4) * i;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }

  if (!top.length) {
    context.fillStyle = "#64717f";
    context.font = "700 14px Arial";
    context.fillText("暫無候選資料", padding.left, padding.top + 22);
    return;
  }

  const barGap = 7;
  const barHeight = Math.max(8, (chartHeight - barGap * (top.length - 1)) / top.length);

  top.forEach((stock, index) => {
    const y = padding.top + index * (barHeight + barGap);
    const barWidth = (stock.score / 100) * chartWidth;
    const gradient = context.createLinearGradient(padding.left, 0, padding.left + chartWidth, 0);
    gradient.addColorStop(0, "#12805c");
    gradient.addColorStop(1, "#2364a7");

    context.fillStyle = gradient;
    roundRect(context, padding.left, y, barWidth, barHeight, 5);
    context.fill();

    context.fillStyle = "#17212b";
    context.font = "700 13px Arial";
    context.fillText(`${stock.code} ${stock.name}`.slice(0, 16), padding.left + 4, y + barHeight - 5);

    context.fillStyle = "#64717f";
    context.textAlign = "right";
    context.fillText(stock.score.toFixed(1), width - padding.right, y + barHeight - 5);
    context.textAlign = "left";
  });

  context.fillStyle = "#64717f";
  context.font = "700 12px Arial";
  context.fillText("Score", padding.left, height - 16);
}

function roundRect(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

elements.refreshButton.addEventListener("click", () => loadAnalysis(true));
elements.filters.forEach((button) => {
  button.addEventListener("click", () => {
    elements.filters.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.market = button.dataset.market;
    if (state.analysis) renderTable(state.analysis.candidates);
  });
});

window.addEventListener("resize", () => {
  if (state.analysis) renderChart(Array.isArray(state.analysis.candidates) ? state.analysis.candidates : []);
});

loadAnalysis();

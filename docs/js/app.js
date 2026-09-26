/* 电费管理系统 - SPA 前端逻辑 */
"use strict";

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
const fmtNum = n => (n === null || n === undefined || n === "") ? "-" : Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const fmtDate = s => (s || "").slice(0, 16).replace("T", " ");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let charts = [];
function renderChart(el, option) {
  const c = echarts.init(el);
  c.setOption(option);
  charts.push(c);
  return c;
}
function disposeCharts() { charts.forEach(c => { try { c.dispose(); } catch (e) {} }); charts = []; }

/* ---------- 基础请求 ---------- */
// 认证接口（login/logout/me）：401 交给调用方处理，不触发全局"会话失效"跳转
function isAuthEndpoint(path) { return String(path || "").indexOf("/api/auth/") === 0; }

// 会话失效统一处理：稳定停留在登录页，绝不整页 reload（避免未登录时 location.reload 死循环导致页面持续闪烁）
let lastExpiredAt = 0;
function handleSessionExpired(msg) {
  const now = Date.now();
  if (now - lastExpiredAt < 1000) return;   // 并发请求节流，避免重复提示
  lastExpiredAt = now;
  state.me = null;
  state.menus = [];
  try { disposeCharts(); } catch (e) {}
  const box = $("#pageContent");
  if (box) box.innerHTML = "";
  showLogin();
  const tip = $("#loginMsg");
  if (tip) tip.textContent = msg || "登录已过期，请重新登录";
}

async function api(path, opts = {}) {
  const o = { headers: { "Content-Type": "application/json" }, ...opts };
  if (o.body && typeof o.body !== "string") o.body = JSON.stringify(o.body);
  const res = await fetch(path, o);
  let data = null;
  try { data = await res.json(); } catch (e) {}
  const code = data ? data.code : null;
  const unauthorized = res.status === 401 || code === 401;
  if (unauthorized && !isAuthEndpoint(path)) {
    handleSessionExpired();
    const err = new Error("登录已过期，请重新登录");
    err.code = 401;
    throw err;
  }
  if (!res.ok || (code && code !== 0)) {
    const err = new Error((data && data.msg) || `请求失败(${res.status})`);
    err.code = code || res.status;
    throw err;
  }
  return data && data.data !== undefined ? data.data : data;
}
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

/* ---------- 登录 ---------- */
const state = { me: null, menus: [], page: "overview", filters: {} };

// 加载左侧菜单：登录成功与恢复会话共用，避免登录后菜单为空（需手动刷新才出现）
async function loadMenus() {
  try {
    const meta = await api("/api/meta/menu");
    state.menus = (meta && meta.menus) || [];
  } catch (e) {
    state.menus = [];                   // 菜单拉取失败不应把已登录用户踢回登录页
  }
}

async function doLogin() {
  const username = $("#loginUser").value.trim();
  const password = $("#loginPass").value;
  $("#loginMsg").textContent = "";
  if (!username || !password) { $("#loginMsg").textContent = "请输入账号和密码"; return; }
  try {
    const d = await api("/api/auth/login", { method: "POST", body: { username, password } });
    state.me = d;
    await loadMenus();                  // 登录成功后立即拉取菜单，使左侧菜单即时渲染
    $("#loginPass").value = "";
    enterApp();
  } catch (e) { $("#loginMsg").textContent = e.message; }
}

async function initSession() {
  let me = null;
  try {
    me = await api("/api/auth/me");     // 未登录/会话过期 -> 401，直接停在登录页，不再整页 reload
  } catch (e) {
    state.me = null;
    state.menus = [];
    showLogin();
    return;
  }
  state.me = me;
  await loadMenus();
  enterApp();
}

function showLogin() {
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
}
function enterApp() {
  if (!state.me) { showLogin(); return; }
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#topUser").textContent = (state.me.display_name || state.me.username) + " · " + (state.me.role || "");
  renderMenu();
  gotoPage("overview");
}

/* ---------- 菜单 ---------- */
const PAGE_TITLES = {
  overview: "结算概览", warnings: "电费预警", settlements: "结算单明细",
  expense_overview: "支出总览", expense_unit: "场地/分成统计", expense_bills: "费用账单明细",
  profile_list: "商户资料", profile_submits: "扫码提交审核",
  cab_estimator: "换电柜电费估算",
  users: "用户与角色",
};

function renderMenu() {
  const nav = $("#menuNav");
  if (!state.menus.length) {
    nav.innerHTML = '<div class="menu-group"><div class="mg-title">暂无可用菜单</div></div>';
    return;
  }
  nav.innerHTML = state.menus.map(g => `
    <div class="menu-group">
      <div class="mg-title"><span class="mg-icon">${esc(g.icon || "•")}</span>${esc(g.name)}</div>
      ${g.children.map(c => `<a class="menu-item" data-page="${esc(c.key)}">${esc(c.name)}</a>`).join("")}
    </div>`).join("");
  $$(".menu-item", nav).forEach(el => el.onclick = () => gotoPage(el.dataset.page));
}

function gotoPage(page) {
  state.page = page;
  $$(".menu-item").forEach(el => el.classList.toggle("active", el.dataset.page === page));
  $("#crumb").textContent = PAGE_TITLES[page] || page;
  loadPage(page);
}

async function loadPage(page) {
  disposeCharts();
  const box = $("#pageContent");
  box.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const render = { overview: pOverview, warnings: pWarnings, settlements: pSettlements,
      expense_overview: pExpenseOverview, expense_unit: pExpenseUnit, expense_bills: pExpenseBills,
      profile_list: pProfiles, profile_submits: pSubmits, users: pUsers,
      cab_estimator: pCabEstimator }[page];
    if (!render) { box.innerHTML = ""; return; }
    await render(box);
  } catch (e) {
    box.innerHTML = `<div class="card"><div class="empty">加载失败：${esc(e.message)}</div></div>`;
  }
}

/* ---------- 通用分页器 ---------- */
function pagerHtml(page, total, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return `<div class="pager">共 ${total} 条 · 第 ${page}/${pages} 页
    <button class="btn small" data-act="prev" ${page <= 1 ? "disabled" : ""}>上一页</button>
    <button class="btn small" data-act="next" ${page >= pages ? "disabled" : ""}>下一页</button></div>`;
}
function bindPager(root, fn) {
  $$(".pager button", root).forEach(b => b.onclick = () => fn(b.dataset.act));
}

/* =================================================================
 * 1. 结算概览
 * ================================================================= */
async function pOverview(box) {
  const months = 12;
  const d = await api(`/api/dashboard/kpi?months=${months}`);
  const cm = d.cur_month || {};
  box.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi blue"><span class="k-label">${cm.month} 已结电费</span><span class="k-value">¥ ${fmtNum(cm.finish_amount)}</span><span class="k-sub">${fmtNum(cm.finish_count)} 笔结算单</span></div>
      <div class="kpi amber"><span class="k-label">结算中待跟进</span><span class="k-value">${fmtNum(d.process_count)}</span><span class="k-sub">线上/线下未完成打款</span></div>
      <div class="kpi red"><span class="k-label">抄表待审核</span><span class="k-value">${fmtNum(d.meter_init_count)}</span><span class="k-sub">将触发新电费结算</span></div>
      <div class="kpi purple"><span class="k-label">更新时间</span><span class="k-value" style="font-size:15px;line-height:34px">${esc(d.updated_at || "")}</span><span class="k-sub">业务库实时抽取</span></div>
    </div>
    <div class="grid-2-1">
      <div class="card"><div class="card-title">近 12 个月已结电费趋势</div><div class="chart-box" id="cTrend"></div></div>
      <div class="card"><div class="card-title">结算方式结构（近12个月）</div><div class="chart-box" id="cWay"></div></div>
    </div>
    <div class="card"><div class="card-title">结算状态结构（全量）</div>
      <table><thead><tr><th>状态</th><th class="num">结算单数</th><th class="num">结算金额(元)</th></tr></thead>
      <tbody>${(d.statuses || []).map(s => `<tr><td><span class="tag ${s.status === "finish_settle" ? "green" : s.status === "process_settle" ? "amber" : s.status === "wait_settle" ? "red" : "gray"}">${esc(s.status_cn)}</span></td><td class="num">${fmtNum(s.count)}</td><td class="num">¥ ${fmtNum(s.amount)}</td></tr>`).join("")}</tbody></table>
    </div>`;
  renderChart($("#cTrend"), {
    tooltip: { trigger: "axis" }, grid: { left: 70, right: 20, top: 30, bottom: 30 },
    xAxis: { type: "category", data: d.trend.map(t => t.month) },
    yAxis: { type: "value", name: "元" },
    series: [{ name: "已结电费", type: "bar", barMaxWidth: 26, itemStyle: { color: "#2563eb", borderRadius: [4, 4, 0, 0] },
      data: d.trend.map(t => t.amount) }],
  });
  renderChart($("#cWay"), {
    tooltip: { trigger: "item", formatter: p => `${p.name}<br/>${fmtNum(p.value)} 元 (${p.percent}%)` },
    legend: { bottom: 0 }, series: [{ type: "pie", radius: ["38%", "66%"], center: ["50%", "45%"],
      itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
      data: d.ways.map(w => ({ name: w.way_cn, value: w.amount })) }],
  });
}

/* =================================================================
 * 2. 电费预警
 * ================================================================= */
async function pWarnings(box) {
  let days = 30, level = "", keyword = "", page = 1;
  const pageSize = 50;
  const load = async () => {
    const d = await api(`/api/dashboard/warnings?days=${days}&level=${level}&keyword=${encodeURIComponent(keyword)}&page=${page}&page_size=${pageSize}`);
    const st = d.level_stats || {};
    box.innerHTML = `
      <div class="card">
        <div class="card-title">电费提前预警
          <span style="font-size:12px;color:var(--muted);font-weight:400">预警窗口：未来 ${days} 天</span>
        </div>
        <div class="summary-strip">
          <span>高优先级 <b class="tag high">${fmtNum(st.high || 0)}</b></span>
          <span>中优先级 <b class="tag mid">${fmtNum(st.mid || 0)}</b></span>
          <span>低优先级 <b class="tag low">${fmtNum(st.low || 0)}</b></span>
          <span>合计 <b>${fmtNum(d.total)}</b> 条</span>
        </div>
        <div class="toolbar">
          <select id="wDays">
            ${[7, 15, 30, 60, 90].map(x => `<option value="${x}" ${x === days ? "selected" : ""}>${x}天内到期</option>`).join("")}
          </select>
          <select id="wLevel">
            <option value="">全部级别</option>
            <option value="high" ${level === "high" ? "selected" : ""}>高优先级</option>
            <option value="mid" ${level === "mid" ? "selected" : ""}>中优先级</option>
          </select>
          <input type="text" id="wKw" placeholder="搜索网点/物业/预警项" value="${esc(keyword)}" style="width:220px">
          <button class="btn primary" id="wSearch">查询</button>
          <button class="btn" id="wExport">导出CSV</button>
        </div>
        <div class="table-wrap">
          <table><thead><tr><th>级别</th><th>类型</th><th>预警项</th><th>说明</th><th>关联时间</th><th class="num">金额(元)</th></tr></thead>
          <tbody>${d.items.length ? d.items.map(i => `<tr>
            <td><span class="tag ${i.level}">${esc(i.level_cn)}</span></td>
            <td><span class="tag ${i.warn_type === "meter_init" ? "red" : i.warn_type === "process_hold" ? "amber" : "blue"}">${esc(i.warn_type_cn)}</span></td>
            <td class="fw-600">${esc(i.title)}</td>
            <td style="white-space:normal;max-width:520px;color:var(--muted)">${esc(i.desc || "")}</td>
            <td>${esc(i.rel_time_fmt || "-")}</td>
            <td class="num">${i.amount_y ? "¥ " + fmtNum(i.amount_y) : "-"}</td></tr>`).join("")
            : `<tr><td colspan="6"><div class="empty">暂无预警</div></td></tr>`}</tbody></table>
        </div>
        ${pagerHtml(page, d.total, pageSize)}
        <div class="mini-note">口径：① 线上抄表待审核 ② 结算中超过7天未打款 ③ 台账登记需结算/下次结算时间已到期或即将到期（取 Excel 台账与扫码沉淀数据）</div>
      </div>`;
    bindWarnEvents(box, { load });
  };
  await load();
}

function bindWarnEvents(box, ctx) {
  $("#wDays", box).onchange = e => { days = +e.target.value; page = 1; ctx.load(); };
  $("#wLevel", box).onchange = e => { level = e.target.value; page = 1; ctx.load(); };
  $("#wKw", box).onkeydown = e => { if (e.key === "Enter") { keyword = e.target.value.trim(); page = 1; ctx.load(); } };
  $("#wSearch", box).onclick = () => { keyword = $("#wKw", box).value.trim(); page = 1; ctx.load(); };
  $("#wExport", box).onclick = () => location.href = `/api/export/warnings?days=${days}`;
  bindPager(box, act => { page += act === "next" ? 1 : -1; ctx.load(); });
}

/* =================================================================
 * 3. 结算单明细
 * ================================================================= */
async function pSettlements(box) {
  let page = 1, pageSize = 20, status = "", way = "", month = "", keyword = "";
  const load = async () => {
    const q = new URLSearchParams({ page, page_size: pageSize, status, way, keyword, month });
    const d = await api(`/api/dashboard/settlements?${q}`);
    const stCn = { process_settle: ["结算中", "amber"], finish_settle: ["已完成", "green"], cancel_settle: ["已取消", "gray"], abolish_settle: ["已作废", "red"] };
    const wyCn = { online: "线上结算", offline: "线下结算(公对公)", gdj_deduct: "供电局划扣", not_settle: "未结算" };
    const monthsOpt = [];
    const now = new Date();
    for (let i = 0; i < 8; i++) { const dt = new Date(now.getFullYear(), now.getMonth() - i, 1); monthsOpt.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`); }
    box.innerHTML = `
      <div class="card">
        <div class="card-title">结算单明细 <span class="mini-note">来源：业务库 cb_exchange_electric_settlement</span></div>
        <div class="toolbar">
          <select id="sStatus">
            <option value="">全部状态</option>
            ${Object.entries(stCn).map(([k, v]) => `<option value="${k}" ${status === k ? "selected" : ""}>${v[0]}</option>`).join("")}
          </select>
          <select id="sWay">
            <option value="">全部结算方式</option>
            ${Object.entries(wyCn).map(([k, v]) => `<option value="${k}" ${way === k ? "selected" : ""}>${v}</option>`).join("")}
          </select>
          <select id="sMonth"><option value="">全部月份</option>
            ${monthsOpt.map(m => `<option value="${m}" ${month === m ? "selected" : ""}>${m}</option>`).join("")}</select>
          <input id="sKw" type="text" placeholder="搜索网点ID/名称" value="${esc(keyword)}" style="width:200px">
          <button class="btn primary" id="sSearch">查询</button>
        </div>
        <div class="table-wrap"><table><thead><tr>
          <th>网点</th><th>结算状态</th><th>结算方式</th><th class="num">电费金额(元)</th>
          <th>结算周期</th><th>结算时间</th><th>打款时间</th><th>收款方</th></tr></thead>
          <tbody>${d.items.length ? d.items.map(i => `<tr>
            <td><div class="fw-600">${esc(i.site_name || "-")}</div><div class="mini-note">${esc(i.site_id || "")}</div></td>
            <td><span class="tag ${(stCn[i.status] || [,"gray"])[1]}">${esc(i.settle_status_cn)}</span></td>
            <td>${esc(i.settle_way_cn || "-")}</td>
            <td class="num">¥ ${fmtNum(i.settle_amount_y)}</td>
            <td>${esc(i.start_time_fmt || "-")}</td>
            <td>${esc(i.settle_time_fmt || "-")}</td>
            <td>${esc(i.pay_time_fmt || "-")}</td>
            <td>${esc(i.receiver || "-")}</td></tr>`).join("")
            : `<tr><td colspan="8"><div class="empty">暂无数据</div></td></tr>`}</tbody></table></div>
        ${pagerHtml(page, d.total, pageSize)}
      </div>`;
    bindSettleEvents(box, { load });
  };
  await load();
}

function bindSettleEvents(box, ctx) {
  $("#sStatus", box).onchange = e => { status = e.target.value; ctx.load(); };
  $("#sWay", box).onchange = e => { way = e.target.value; ctx.load(); };
  $("#sMonth", box).onchange = e => { month = e.target.value; ctx.load(); };
  $("#sKw", box).onkeydown = e => { if (e.key === "Enter") { keyword = e.target.value.trim(); ctx.load(); } };
  $("#sSearch", box).onclick = () => { keyword = $("#sKw", box).value.trim(); ctx.load(); };
  bindPager(box, act => { page += act === "next" ? 1 : -1; ctx.load(); });
}

/* =================================================================
 * 4. 费用支出总览
 * ================================================================= */
async function pExpenseOverview(box) {
  let months = 6;
  const load = async () => {
    const d = await api(`/api/expense/overview?months=${months}`);
    const byType = d.by_type || [];
    const byName = d.by_name || [];
    const t = d.trend_by_class || [];
    const cost = byType.find(x => x.type === "costOut");
    const profit = byType.find(x => x.type === "profitOut");
    const manage = byType.find(x => x.type === "manageOut");
    const typeColors = { costOut: "#2563eb", profitOut: "#7c3aed", manageOut: "#d97706", withdraw: "#64748b", promoter: "#16a34a" };
    box.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi blue"><span class="k-label">近${months}个月费用总支出</span><span class="k-value">¥ ${fmtNum(d.total_amount)}</span><span class="k-sub">已结算账单</span></div>
        <div class="kpi"><span class="k-label">成本支出 costOut</span><span class="k-value">¥ ${fmtNum(cost ? cost.amount : 0)}</span><span class="k-sub">${fmtNum(cost ? cost.count : 0)} 笔</span></div>
        <div class="kpi purple"><span class="k-label">分成支出 profitOut</span><span class="k-value">¥ ${fmtNum(profit ? profit.amount : 0)}</span><span class="k-sub">${fmtNum(profit ? profit.count : 0)} 笔</span></div>
        <div class="kpi amber"><span class="k-label">管理支出 manageOut</span><span class="k-value">¥ ${fmtNum(manage ? manage.amount : 0)}</span><span class="k-sub">${fmtNum(manage ? manage.count : 0)} 笔</span></div>
      </div>
      <div class="toolbar" style="margin:-4px 0 12px">
        <span class="mini-note">统计口径：近</span>
        ${[3, 6, 12].map(m => `<button class="btn small ${m === months ? "primary" : ""}" data-m="${m}">${m}个月</button>`).join("")}
      </div>
      <div class="card"><div class="card-title">月度支出趋势（按大类：电费/分成/补贴）</div><div class="chart-box" id="cClass"></div></div>
      <div class="grid-2-1">
        <div class="card"><div class="card-title">按结算类型（expense_type）</div>
          <table><thead><tr><th>类型</th><th class="num">金额(元)</th><th class="num">笔数</th><th>占比</th></tr></thead>
          <tbody>${byType.map(x => `<tr><td><span class="tag" style="background:${typeColors[x.type] || "#64748b"}1a;color:${typeColors[x.type] || "#64748b"}">${esc(x.type_cn)}</span> <span class="mini-note">${esc(x.type)}</span></td><td class="num">¥ ${fmtNum(x.amount)}</td><td class="num">${fmtNum(x.count)}</td><td>${d.total_amount ? ((x.amount / d.total_amount) * 100).toFixed(1) : 0}%</td></tr>`).join("")}</tbody></table>
        </div>
        <div class="card"><div class="card-title">支出结构</div><div class="chart-box" id="cTypePie"></div></div>
      </div>
      <div class="card"><div class="card-title">费用项目 TOP（按支出金额）</div>
        <table><thead><tr><th>费用项目</th><th>大类</th><th class="num">金额(元)</th><th class="num">笔数</th></tr></thead>
        <tbody>${byName.map(x => `<tr><td class="fw-600">${esc(x.expense_name || "-")}</td><td><span class="tag blue">${esc(x.class)}</span></td><td class="num">¥ ${fmtNum(x.amount)}</td><td class="num">${fmtNum(x.count)}</td></tr>`).join("")}</tbody></table>
      </div>`;
    $$(".toolbar button", box).forEach(b => b.onclick = () => { months = +b.dataset.m; load(); });
    const clsColors = { electric: "#2563eb", profit: "#7c3aed", subsidy: "#16a34a", other: "#94a3b8" };
    renderChart($("#cClass"), {
      tooltip: { trigger: "axis" }, legend: { top: 0 }, grid: { left: 70, right: 20, top: 40, bottom: 30 },
      xAxis: { type: "category", data: t.map(x => x.month) },
      yAxis: { type: "value", name: "元" },
      series: [
        { name: "电费", type: "bar", stack: "t", itemStyle: { color: clsColors.electric }, data: t.map(x => x.electric) },
        { name: "分成", type: "bar", stack: "t", itemStyle: { color: clsColors.profit }, data: t.map(x => x.profit) },
        { name: "补贴", type: "bar", stack: "t", itemStyle: { color: clsColors.subsidy }, data: t.map(x => x.subsidy) },
        { name: "其他", type: "bar", stack: "t", itemStyle: { color: clsColors.other }, data: t.map(x => x.other) },
      ],
    });
    renderChart($("#cTypePie"), {
      tooltip: { trigger: "item", formatter: p => `${p.name}<br/>¥ ${fmtNum(p.value)} (${p.percent}%)` },
      legend: { bottom: 0 }, series: [{ type: "pie", radius: ["36%", "64%"], center: ["50%", "44%"],
        itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
        data: byType.map(x => ({ name: x.type_cn, value: x.amount, itemStyle: { color: typeColors[x.type] || "#64748b" } })) }],
    });
  };
  await load();
}

/* =================================================================
 * 5. 场地/分成统计
 * ================================================================= */
async function pExpenseUnit(box) {
  let months = 6, kind = "electric";
  const load = async () => {
    const [unit, ways] = await Promise.all([
      api(`/api/expense/unit?months=${months}&kind=${kind}&limit=15`),
      api(`/api/expense/ways?months=${months}`),
    ]);
    const kindTxt = { electric: "电费成本（场地维度）", profit: "分成支出（场地维度）" };
    box.innerHTML = `
      <div class="card">
        <div class="card-title">${kindTxt[kind]} TOP 场地
          <span>
            ${[3, 6, 12].map(m => `<button class="btn small ${m === months ? "primary" : ""}" data-m="${m}">${m}个月</button>`).join(" ")}
          </span>
        </div>
        <div class="sub-tabs">
          <span class="sub-tab ${kind === "electric" ? "active" : ""}" data-k="electric">电费场地</span>
          <span class="sub-tab ${kind === "profit" ? "active" : ""}" data-k="profit">分成场地</span>
        </div>
        <div class="chart-box" id="cUnitBar"></div>
        <table style="margin-top:6px"><thead><tr><th>场地/商户（in_unit_name）</th><th class="num">金额(元)</th><th class="num">笔数</th><th>类型构成</th></tr></thead>
        <tbody>${unit.items.map(x => `<tr><td class="fw-600">${esc(x.unit)}</td><td class="num">¥ ${fmtNum(x.amount)}</td><td class="num">${fmtNum(x.count)}</td>
          <td class="mini-note">${Object.entries(x.types).map(([k, v]) => `${k}:¥${fmtNum(v)}`).join(" · ")}</td></tr>`).join("")}</tbody></table>
      </div>
      <div class="card"><div class="card-title">按结算类型统计（结算单 settle_way：线上/线下/供电局划扣）</div>
        <div class="chart-box" id="cWayBar"></div>
      </div>`;
    $$("[data-m]", box).forEach(b => b.onclick = () => { months = +b.dataset.m; load(); });
    $$("[data-k]", box).forEach(b => b.onclick = () => { kind = b.dataset.k; load(); });
    const items = [...unit.items].reverse();
    renderChart($("#cUnitBar"), {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } }, grid: { left: 180, right: 50, top: 20, bottom: 30 },
      xAxis: { type: "value", name: "元" }, yAxis: { type: "category", data: items.map(x => x.unit) },
      series: [{ type: "bar", barMaxWidth: 16, itemStyle: { color: kind === "electric" ? "#2563eb" : "#7c3aed", borderRadius: [0, 4, 4, 0] }, data: items.map(x => x.amount) }],
    });
    renderChart($("#cWayBar"), {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } }, grid: { left: 80, right: 50, top: 20, bottom: 30 },
      xAxis: { type: "category", data: ways.items.map(x => x.way_cn) },
      yAxis: { type: "value", name: "元" },
      series: [{ name: "金额", type: "bar", barMaxWidth: 34, itemStyle: { color: "#0ea5e9", borderRadius: [4, 4, 0, 0] }, data: ways.items.map(x => x.amount) }],
    });
  };
  await load();
}

/* =================================================================
 * 6. 费用账单明细
 * ================================================================= */
async function pExpenseBills(box) {
  let page = 1, pageSize = 20, months = 3, expense_type = "", keyword = "", unit = "";
  const load = async () => {
    const q = new URLSearchParams({ page, page_size: pageSize, months, expense_type, keyword, unit });
    const d = await api(`/api/expense/bills?${q}`);
    const typeColors = { costOut: ["成本", "red"], profitOut: ["分成", "purple"], manageOut: ["管理", "amber"], withdraw: ["提现", "gray"] };
    box.innerHTML = `
      <div class="card">
        <div class="card-title">费用账单明细 <span class="mini-note">默认近3个月 · 已结算口径可按类型/场地筛选</span></div>
        <div class="toolbar">
          <select id="bType">
            <option value="">全部结算类型</option>
            ${Object.entries(typeColors).map(([k, v]) => `<option value="${k}" ${expense_type === k ? "selected" : ""}>${v[0]}支出 ${k}</option>`).join("")}
          </select>
          <input id="bKw" placeholder="搜索费用项目/收付款方" value="${esc(keyword)}" style="width:200px">
          <input id="bUnit" placeholder="场地/商户关键词" value="${esc(unit)}" style="width:180px">
          <button class="btn primary" id="bSearch">查询</button>
        </div>
        <div class="table-wrap"><table><thead><tr>
          <th>费用项目</th><th>类型</th><th class="num">金额(元)</th><th>支出方</th><th>场地/收入方</th><th>创建时间</th><th>结算时间</th></tr></thead>
          <tbody>${d.items.length ? d.items.map(i => `<tr>
            <td class="fw-600">${esc(i.expense_name || "-")}</td>
            <td><span class="tag ${(typeColors[i.expense_type] || [,"gray"])[1]}">${esc(i.type_cn || i.expense_type)}</span></td>
            <td class="num">¥ ${fmtNum(i.amount)}</td>
            <td>${esc(i.out_unit_name || "-")}</td>
            <td>${esc(i.in_unit_name || "-")}</td>
            <td>${esc(i.create_time_fmt || "-")}</td><td>${esc(i.settle_time_fmt || "-")}</td></tr>`).join("")
            : `<tr><td colspan="7"><div class="empty">暂无数据</div></td></tr>`}</tbody></table></div>
        ${pagerHtml(page, d.total, pageSize)}
      </div>`;
    bindExpenseBills(box, { load });
  };
  await load();
}

function bindExpenseBills(box, ctx) {
  $("#bType", box).onchange = e => { expense_type = e.target.value; ctx.load(); };
  $("#bKw", box).onkeydown = e => { if (e.key === "Enter") { keyword = e.target.value.trim(); ctx.load(); } };
  $("#bUnit", box).onkeydown = e => { if (e.key === "Enter") { unit = e.target.value.trim(); ctx.load(); } };
  $("#bSearch", box).onclick = () => { keyword = $("#bKw", box).value.trim(); unit = $("#bUnit", box).value.trim(); ctx.load(); };
  bindPager(box, act => { page += act === "next" ? 1 : -1; ctx.load(); });
}

/* =================================================================
 * 7. 商户资料库
 * ================================================================= */
async function pProfiles(box) {
  let page = 1, pageSize = 50, keyword = "", city = "", need_settle = "", source = "";
  const load = async () => {
    const q = new URLSearchParams({ page, page_size: pageSize, keyword, city, need_settle, source });
    const [d, stats] = await Promise.all([api(`/api/profiles?${q}`), api(`/api/profiles/stats`)]);
    const p = stats.profiles || {};
    const cities = (p.cities || []).map(x => x.city).filter(Boolean);
    box.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi blue"><span class="k-label">商户资料总数</span><span class="k-value">${fmtNum(p.total)}</span><span class="k-sub">Excel整合 + 扫码沉淀</span></div>
        <div class="kpi amber"><span class="k-label">需结算电费</span><span class="k-value">${fmtNum(p.need_settle)}</span></div>
        <div class="kpi purple"><span class="k-label">待审核提交</span><span class="k-value">${fmtNum((stats.submits || {}).pending || 0)}</span><span class="k-sub">扫码提交待处理</span></div>
      </div>
      <div class="card">
        <div class="card-title">商户基本资料
          <span>
            <button class="btn" id="pExport">导出CSV</button>
            <a class="btn primary" href="/scan" target="_blank">+ 打开扫码提交页</a>
          </span>
        </div>
        <div class="toolbar">
          <input id="pKw" placeholder="搜索网点ID/名称/物业/负责人" value="${esc(keyword)}" style="width:220px">
          <select id="pCity"><option value="">全部城市</option>
            ${cities.map(c => `<option value="${esc(c)}" ${city === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
          <select id="pNeed">
            <option value="">是否需结算</option>
            <option value="是" ${need_settle === "是" ? "selected" : ""}>需要结算</option>
            <option value="否" ${need_settle === "否" ? "selected" : ""}>不需要结算</option>
          </select>
          <select id="pSource"><option value="">全部来源</option>
            <option value="excel" ${source === "excel" ? "selected" : ""}>Excel台账</option>
            <option value="scan" ${source === "scan" ? "selected" : ""}>扫码提交</option>
            <option value="manual" ${source === "manual" ? "selected" : ""}>手工编辑</option>
          </select>
          <button class="btn primary" id="pSearch">查询</button>
        </div>
        <div class="table-wrap"><table><thead><tr>
          <th>网点ID</th><th>网点名称</th><th>城市/区域</th><th>物业公司</th><th>需结算</th><th>结算周期</th>
          <th>下次结算时间</th><th>电表状态</th><th>电单价</th><th>分成比例</th><th>联系人/电话</th><th>来源</th><th>操作</th></tr></thead>
          <tbody>${d.items.length ? d.items.map(x => `<tr>
            <td class="mini-note">${esc(x.site_id || "-")}</td>
            <td class="fw-600">${esc(x.site_name || "-")}</td>
            <td>${esc(x.city || "-")}${x.area ? "/" + esc(x.area) : ""}</td>
            <td>${esc(x.property_name || "-")}</td>
            <td>${x.need_settle === "是" ? `<span class="tag red">是</span>` : x.need_settle === "否" ? `<span class="tag gray">否</span>` : "-"}</td>
            <td>${esc(x.settle_cycle || "-")}</td>
            <td>${esc(x.next_settle_time || "-")}</td>
            <td>${esc(x.meter_status || "-")}</td>
            <td>${esc(x.electric_price || "-")}</td>
            <td>${esc(x.profit_ratio || "-")}</td>
            <td class="mini-note">${esc(x.contact_name || "")}${x.contact_phone ? "<br>" + esc(x.contact_phone) : ""}</td>
            <td><span class="tag ${x.source === "excel" ? "gray" : x.source === "scan" ? "green" : "blue"}">${esc(x.source || "-")}</span></td>
            <td><a class="link" data-edit="${esc(x.site_id)}">编辑</a> <a class="link" style="color:var(--red)" data-del="${esc(x.site_id)}">删除</a></td></tr>`).join("")
            : `<tr><td colspan="13"><div class="empty">暂无商户资料</div></td></tr>`}</tbody></table></div>
        ${pagerHtml(page, d.total, pageSize)}
      </div>`;
    $("#pExport", box).onclick = () => location.href = `/api/export/profiles?keyword=${encodeURIComponent(keyword)}`;
    $("#pKw", box).onkeydown = e => { if (e.key === "Enter") { keyword = e.target.value.trim(); page = 1; load(); } };
    $("#pCity", box).onchange = e => { city = e.target.value; page = 1; load(); };
    $("#pNeed", box).onchange = e => { need_settle = e.target.value; page = 1; load(); };
    $("#pSource", box).onchange = e => { source = e.target.value; page = 1; load(); };
    $("#pSearch", box).onclick = () => { keyword = $("#pKw", box).value.trim(); page = 1; load(); };
    bindPager(box, act => { page += act === "next" ? 1 : -1; load(); });
    $$("[data-edit]", box).forEach(el => el.onclick = () => openProfileModal(el.dataset.edit, load));
    $$("[data-del]", box).forEach(el => el.onclick = async () => {
      if (!confirm(`确认删除网点 ${el.dataset.del} 的资料？（删除后可通过扫码/编辑重新录入）`)) return;
      try { await api(`/api/profiles/${encodeURIComponent(el.dataset.del)}`, { method: "DELETE" }); toast("已删除"); load(); }
      catch (e) { alert(e.message); }
    });
  };
  await load();
}

const PROFILE_FIELDS = [
  ["site_name", "网点名称"], ["city", "城市"], ["area", "区域"], ["address", "地址"],
  ["property_name", "物业公司名称"], ["property_phone", "物业电话"], ["meter_no", "电表号"],
  ["meter_status", "独立电表状态"], ["electric_price", "电单价(元/度)"], ["settle_cycle", "电费结算周期"],
  ["settle_way", "电费结算方式"], ["profit_ratio", "分成比例"], ["need_settle", "是否要结算电费"],
  ["last_settle_time", "上次结算时间"], ["next_settle_time", "下次结算时间"], ["last_meter_value", "上次抄表度数"],
  ["contact_name", "负责人/联系人"], ["contact_phone", "联系电话"], ["bank_name", "收款银行"],
  ["bank_account", "收款账号"], ["remark", "备注"],
];

async function openProfileModal(siteId, afterSave) {
  let base = {};
  if (siteId) {
    try { base = await api(`/api/profiles/${encodeURIComponent(siteId)}`); } catch (e) { toast("读取失败"); return; }
  }
  const body = `<div class="form-grid">
    <div class="form-item full"><label>网点ID</label><input id="f_site_id" value="${esc(base.site_id || siteId || "")}" ${siteId ? "readonly" : ""}></div>
    ${PROFILE_FIELDS.map(([k, label]) => {
      let tag = "input";
      let extra = "";
      if (k === "remark") tag = "textarea";
      if (k === "need_settle") {
        return `<div class="form-item"><label>${label}</label><select id="f_${k}">
          <option value="">未知</option><option value="是" ${base[k] === "是" ? "selected" : ""}>是</option>
          <option value="否" ${base[k] === "否" ? "selected" : ""}>否</option></select></div>`;
      }
      if (["last_settle_time", "next_settle_time"].includes(k)) tag = "date";
      return `<div class="form-item"><label>${label}</label><${tag} id="f_${k}" ${extra}>${esc(base[k] || "")}</${tag}></div>`;
    }).join("")}
  </div>`;
  showModal(`编辑商户资料（${siteId || "新建"}）`, body, async () => {
    const row = {};
    row.site_id = ($("#f_site_id").value || "").trim();
    if (!row.site_id) { toast("网点ID必填"); return; }
    PROFILE_FIELDS.forEach(([k]) => { const el = $(`#f_${k}`); if (el) row[k] = el.value.trim(); });
    try {
      await api(`/api/profiles/${encodeURIComponent(row.site_id)}`, { method: "POST", body: row });
      toast("保存成功"); afterSave && afterSave(); return true;
    } catch (e) { alert(e.message); }
  });
}

/* =================================================================
 * 8. 扫码提交审核
 * ================================================================= */
async function pSubmits(box) {
  let page = 1, pageSize = 50, status = "", keyword = "";
  const load = async () => {
    const q = new URLSearchParams({ page, page_size: pageSize, status, keyword });
    const d = await api(`/api/submits?${q}`);
    const stCn = { pending: ["待审核", "amber"], approved: ["已通过", "green"], rejected: ["已驳回", "red"] };
    box.innerHTML = `
      <div class="card">
        <div class="card-title">扫码提交审核 <span class="mini-note">物业/业务员/商户扫公共码提交的资料，审核通过后并入商户资料库</span></div>
        <div class="toolbar">
          <select id="tStatus">
            <option value="">全部状态</option>
            ${Object.entries(stCn).map(([k, v]) => `<option value="${k}" ${status === k ? "selected" : ""}>${v[0]}</option>`).join("")}
          </select>
          <input id="tKw" placeholder="搜索提交人/商户/网点" value="${esc(keyword)}" style="width:220px">
          <button class="btn primary" id="tSearch">查询</button>
          <button class="btn" id="tExport">导出CSV</button>
          <button class="btn" id="tQr">扫码二维码</button>
        </div>
        <div class="table-wrap"><table><thead><tr>
          <th>ID</th><th>提交角色</th><th>网点/商户</th><th>物业/联系人</th><th>联系电话</th><th>结算周期</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead>
          <tbody>${d.items.length ? d.items.map(x => `<tr>
            <td>#${x.id}</td>
            <td>${esc(roleCn(x.role))}</td>
            <td><div class="fw-600">${esc(x.site_name || "-")}</div><div class="mini-note">${esc(x.site_id || "")}</div></td>
            <td class="mini-note">${esc(x.property_name || "-")}${x.contact_name ? "<br>" + esc(x.contact_name) : ""}</td>
            <td>${esc(x.contact_phone || x.property_phone || "-")}</td>
            <td>${esc(x.settle_cycle || "-")}</td>
            <td><span class="tag ${(stCn[x.status] || [,"gray"])[1]}">${esc((stCn[x.status] || ["-"])[0])}</span></td>
            <td class="mini-note">${esc(x.created_at || "-")}</td>
            <td>${x.status === "pending" ? `<a class="link" data-view="${x.id}">详情</a> · <a class="link" style="color:var(--green)" data-ok="${x.id}">通过</a> · <a class="link" style="color:var(--red)" data-no="${x.id}">驳回</a>`
              : `<a class="link" data-view="${x.id}">详情</a>`}</td></tr>`).join("")
            : `<tr><td colspan="9"><div class="empty">暂无提交记录</div></td></tr>`}</tbody></table></div>
        ${pagerHtml(page, d.total, pageSize)}
      </div>`;
    const reload = load;
    $("#tStatus", box).onchange = e => { status = e.target.value; page = 1; reload(); };
    $("#tKw", box).onkeydown = e => { if (e.key === "Enter") { keyword = e.target.value.trim(); page = 1; reload(); } };
    $("#tSearch", box).onclick = () => { keyword = $("#tKw", box).value.trim(); page = 1; reload(); };
    $("#tExport", box).onclick = () => location.href = `/api/export/submits?status=${status}`;
    $("#tQr", box).onclick = () => window.open("/scan/qr", "_blank");
    bindPager(box, act => { page += act === "next" ? 1 : -1; reload(); });
    $$("[data-view]", box).forEach(el => el.onclick = () => viewSubmit(el.dataset.view));
    $$("[data-ok]", box).forEach(el => el.onclick = async () => {
      if (!confirm("确认通过该提交并并入商户资料库？")) return;
      try { await api(`/api/submits/${el.dataset.ok}/review`, { method: "POST", body: { action: "approve" } }); toast("已通过并归档"); reload(); } catch (e) { alert(e.message); }
    });
    $$("[data-no]", box).forEach(el => el.onclick = async () => {
      const note = prompt("驳回原因（可选）", ""); if (note === null) return;
      try { await api(`/api/submits/${el.dataset.no}/review`, { method: "POST", body: { action: "reject", note } }); toast("已驳回"); reload(); } catch (e) { alert(e.message); }
    });
  };
  await load();
}

function roleCn(r) {
  return { property: "物业", sales: "业务员", merchant: "商户", operator: "运营", unknown: "未填写" }[r] || r || "未填写";
}

async function viewSubmit(id) {
  try {
    const x = await api(`/api/submits/${encodeURIComponent(id)}`);
    if (!x) { toast("未找到"); return; }
    const keys = ["site_id", "site_name", "city", "area", "address", "property_name", "property_phone",
      "contact_name", "contact_phone", "meter_no", "meter_status", "electric_price", "settle_cycle",
      "settle_way", "profit_ratio", "bank_name", "bank_account", "last_meter_value", "last_settle_time",
      "next_settle_time", "remark"];
    const labelMap = { site_id: "网点ID", site_name: "网点名称", city: "城市", area: "区域", address: "地址",
      property_name: "物业公司/商户名", property_phone: "物业电话", contact_name: "联系人", contact_phone: "联系电话",
      meter_no: "电表号", meter_status: "独立电表状态", electric_price: "电单价", settle_cycle: "结算周期",
      settle_way: "结算方式", profit_ratio: "分成比例", bank_name: "收款银行", bank_account: "收款账号",
      last_meter_value: "上次抄表度数", last_settle_time: "上次结算时间", next_settle_time: "下次结算时间", remark: "备注" };
    const rows = keys.filter(k => x[k]).map(k => `<div class="form-item full"><label>${labelMap[k]}</label><div class="mini-note" style="white-space:pre-wrap">${esc(x[k])}</div></div>`).join("");
    showModal(`提交详情 #${x.id}（${roleCn(x.role)}）`, `<div class="form-grid">${rows}</div>`, null, true);
  } catch (e) { alert(e.message); }
}

/* =================================================================
 * 9. 用户与角色
 * ================================================================= */
async function pUsers(box) {
  const [u, r] = await Promise.all([api("/api/users"), api("/api/roles")]);
  const roleName = Object.fromEntries((r.roles || []).map(x => [x.key, x.name]));
  const permName = Object.fromEntries((r.permissions || []).map(x => [x.key, x.name]));
  const fmtPerms = p => (Array.isArray(p) ? p : JSON.parse(p || "[]")).map(k => permName[k] || k).join("、") || "-";
  box.innerHTML = `
    <div class="grid-2-1">
      <div class="card">
        <div class="card-title">用户管理 <button class="btn small primary" id="addUser">+ 新增用户</button></div>
        <div class="table-wrap"><table><thead><tr><th>ID</th><th>用户名</th><th>显示名</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>${(u || []).map(x => `<tr><td>${x.id}</td><td class="fw-600">${esc(x.username)}</td><td>${esc(x.display_name || "-")}</td>
          <td><span class="tag ${x.role === "admin" ? "red" : x.role === "manager" ? "blue" : "gray"}">${esc(roleName[x.role] || x.role)}</span></td>
          <td class="mini-note">${esc(x.created_at || "")}</td>
          <td><a class="link" data-uu="${x.id}" data-name="${esc(x.username)}" data-role="${esc(x.role)}" data-dn="${esc(x.display_name || "")}">编辑</a>
          ${x.role !== "admin" ? ` · <a class="link" style="color:var(--red)" data-ud="${x.id}">删除</a>` : ""}</td></tr>`).join("")}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-title">角色与权限</div>
        <div class="table-wrap"><table><thead><tr><th>角色</th><th>权限点</th></tr></thead>
        <tbody>${(r.roles || []).map(x => `<tr><td><span class="tag ${x.is_system ? "blue" : "green"}">${esc(x.name)}</span><div class="mini-note">${esc(x.key)}</div></td>
          <td class="mini-note" style="white-space:normal;max-width:320px">${fmtPerms(x.permissions)}</td></tr>`).join("")}</tbody></table></div>
        <div class="mini-note" style="margin-top:8px">admin 拥有全部权限；manager 可审核扫码提交并编辑资料；viewer 只读。</div>
      </div>
    </div>`;
  $("#addUser", box).onclick = () => userModal(null, pUsers);
  $$("[data-uu]", box).forEach(el => el.onclick = () => userModal({
    id: el.dataset.uu, username: el.dataset.name, role: el.dataset.role, display_name: el.dataset.dn
  }, pUsers));
  $$("[data-ud]", box).forEach(el => el.onclick = async () => {
    if (!confirm("确认删除该用户？")) return;
    try { await api(`/api/users/${el.dataset.ud}`, { method: "DELETE" }); toast("已删除"); pUsers(box); } catch (e) { alert(e.message); }
  });
}

function userModal(user, after) {
  const roles = ["admin", "manager", "viewer"];
  showModal(user ? `编辑用户 ${user.username}` : "新增用户", `
    <div class="form-grid">
      <div class="form-item"><label>用户名</label><input id="uName" value="${esc(user ? user.username : "")}" ${user ? "readonly" : ""}></div>
      <div class="form-item"><label>密码${user ? "（留空则不修改）" : ""}</label><input id="uPass" type="password"></div>
      <div class="form-item"><label>显示名</label><input id="uDn" value="${esc(user ? user.display_name : "")}"></div>
      <div class="form-item"><label>角色</label><select id="uRole">${roles.map(x => `<option value="${x}" ${user && user.role === x ? "selected" : ""}>${x === "admin" ? "管理员" : x === "manager" ? "客户经理" : "查看者"}</option>`).join("")}</select></div>
    </div>`, async () => {
    const body = { username: $("#uName").value.trim(), password: $("#uPass").value, role: $("#uRole").value, display_name: $("#uDn").value.trim() };
    try {
      if (user) await api(`/api/users/${user.id}`, { method: "PUT", body });
      else { if (!body.password) { toast("请输入初始密码"); return; } await api("/api/users", { method: "POST", body }); }
      toast("保存成功"); after && after($("#pageContent")); return true;
    } catch (e) { alert(e.message); }
  });
}

/* =================================================================
 * 换电柜电费估算 —— 内嵌独立工具页（/estimator）
 * 原工具为纯前端单页计算（实物容量口径 + 平台 12Wh/% 双口径对照），
 * 无后端依赖，故以 iframe 原样内嵌，保证计算能力与交互 100% 保留。
 * ================================================================= */
async function pCabEstimator(box) {
  box.innerHTML = `
    <div class="card embed-card">
      <iframe class="embed-frame" src="/estimator" title="换电柜电费估算工具"></iframe>
    </div>`;
}

/* ---------- 通用弹窗 ---------- */
function showModal(title, bodyHtml, onOk, hideOk) {
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `<div class="modal">
    <div class="modal-head"><span>${esc(title)}</span><span class="modal-close">×</span></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot">${hideOk ? "" : '<button class="btn" id="mCancel">取消</button><button class="btn primary" id="mOk">保存</button>'}</div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  $(".modal-close", mask).onclick = close;
  const cb = $("#mCancel", mask); if (cb) cb.onclick = close;
  const ok = $("#mOk", mask);
  if (ok) ok.onclick = async () => { if (onOk) { const r = await onOk(); if (r === false) return; } close(); };
  mask.addEventListener("click", e => { if (e.target === mask && hideOk) close(); });
}

/* ---------- 启动 ---------- */
$("#loginBtn").onclick = doLogin;
$("#loginPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
$("#logoutBtn").onclick = async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (e) {}
  state.me = null; state.menus = [];
  disposeCharts();
  const box = $("#pageContent"); if (box) box.innerHTML = "";
  const tip = $("#loginMsg"); if (tip) tip.textContent = "";
  showLogin();
};
window.addEventListener("resize", () => charts.forEach(c => c.resize()));
initSession();

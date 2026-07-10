// ======================== pages_explore.js ========================
// 探索页：方向驱动 → 主动探知，避免算法投喂

// ====== 探索主页 ======
function pageDisplayExplore() {
  return `<h2 style="font-size:18px;color:#f0f6fc;margin-bottom:4px">🔍 探索</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:16px">设定方向，主动发现，避免刷抖音式迷失自我</p>

  <!-- 方向选择卡 -->
  <div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <span style="font-size:13px;color:#f0f6fc">🎯 探索方向</span>
      <button class="btn sm" onclick="navTo('display','explore_directions')">⚙ 管理方向</button>
    </div>
    <div id="exploreDirCards" style="display:flex;flex-wrap:wrap;gap:8px">加载中...</div>
  </div>

  <!-- 操作栏 -->
  <div class="card" style="margin-top:8px">
    <div class="row">
      <input type="text" id="exploreQ" placeholder="在结果中搜索关键词..." style="flex:1;max-width:400px">
      <button class="btn pri" onclick="doExploreFilter()">筛选</button>
    </div>
    <button class="btn" id="exploreCrawlBtn" onclick="startExplore()" style="margin-top:4px;background:#238636;color:#fff">🚀 开始探索</button>
    <span id="exploreStatus" style="font-size:11px;color:#8b949e;margin-left:8px"></span>
  </div>

  <!-- 结果列表 -->
  <div id="exploreResults" style="margin-top:8px">
    <p style="text-align:center;color:#8b949e;padding:40px">👆 选择一个方向，点击"开始探索"</p>
  </div>

  <!-- 统计条 -->
  <div class="stats" id="exploreStats" style="margin-top:12px"></div>`;
}

let _exploreSelDir = null, _exploreFilter = '';

function bindExploreEvents() {
  loadExploreDirCards();
  loadExploreStats();
  const sq = document.getElementById('exploreQ');
  if (sq) sq.addEventListener('keydown', e => { if (e.key === 'Enter') doExploreFilter(); });
}

async function loadExploreDirCards() {
  const el = document.getElementById('exploreDirCards');
  if (!el) return;
  try {
    const dirs = await api('/api/explore/directions');
    const activeDirs = dirs.filter(d => d.is_active);
    el.innerHTML = activeDirs.map(d => `
      <div class="explore-dir-card${_exploreSelDir === d.id ? ' sel' : ''}"
           onclick="selectExploreDir(${d.id})"
           style="cursor:pointer;padding:8px 14px;border:1px solid #30363d;border-radius:8px;background:#161b22;transition:all .2s;font-size:13px"
           data-dir="${d.id}">
        <span style="font-size:20px">${esc(d.icon)}</span>
        <span style="margin-left:4px">${esc(d.direction_name)}</span>
      </div>`).join('');
    if (activeDirs.length === 0) el.innerHTML = '<span style="color:#8b949e;font-size:12px">暂无活跃方向，去<a href="#" onclick="navTo(\'display\',\'explore_directions\')" style="color:#58a6ff">管理方向</a>启用</span>';
    if (activeDirs.length > 0 && !_exploreSelDir) selectExploreDir(activeDirs[0].id);
  } catch (e) { el.innerHTML = `<span style="color:#f85149">加载失败: ${e.message}</span>`; }
}

function selectExploreDir(id) {
  _exploreSelDir = id;
  document.querySelectorAll('.explore-dir-card').forEach(c => {
    if (+c.dataset.dir === id) { c.style.borderColor = '#1f6feb'; c.style.background = '#1a2332'; }
    else { c.style.borderColor = '#30363d'; c.style.background = '#161b22'; }
  });
  loadExploreResults();
}

async function startExplore() {
  if (!_exploreSelDir) { toast('请先选择一个探索方向', true); return; }
  const btn = document.getElementById('exploreCrawlBtn');
  const st = document.getElementById('exploreStatus');
  btn.disabled = true; btn.textContent = '⏳ 探索中...';
  st.textContent = '';
  try {
    const r = await api('/api/explore/crawl', { method: 'POST', body: JSON.stringify({ direction_id: _exploreSelDir }) });
    st.textContent = `发现 ${r.new} 条新内容 (${r.crawled} 条扫描, ${r.skipped_dup} 条跳过重复)`;
    toast(`✨ 发现 ${r.new} 条新内容`);
    loadExploreResults();
    loadExploreStats();
  } catch (e) { toast('探索失败: ' + e.message, true); }
  btn.disabled = false; btn.textContent = '🚀 开始探索';
}

async function loadExploreResults() {
  const el = document.getElementById('exploreResults');
  if (!el) return;
  if (!_exploreSelDir) { el.innerHTML = '<p style="text-align:center;color:#8b949e;padding:40px">请先选择探索方向</p>'; return; }
  el.innerHTML = '<p style="text-align:center;color:#8b949e;padding:20px">加载中...</p>';
  try {
    let url = `/api/explore/results?direction_id=${_exploreSelDir}&limit=50`;
    if (_exploreFilter) url += '&q=' + encodeURIComponent(_exploreFilter);
    const results = await api(url);
    if (results.length === 0) {
      el.innerHTML = `<div class="card" style="text-align:center;padding:40px;color:#8b949e">
        <div style="font-size:40px;margin-bottom:8px">🔍</div>
        <p>还没有收录内容，点击"🚀 开始探索"来收集</p></div>`;
      return;
    }
    el.innerHTML = results.map(item => `
      <div class="card" style="margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1">
            <h4 style="margin:0 0 4px 0;font-size:14px">
              <a href="${esc(item.url||'#')}" target="_blank" style="color:#58a6ff;text-decoration:none" rel="noopener">${esc(item.title)}</a>
            </h4>
            <p style="font-size:12px;color:#8b949e;margin:0 0 4px 0">${esc((item.summary||'').substring(0,200))}</p>
            <div class="meta">
              <span>${esc(item.source_domain||'')}</span>
              ${item.similarity_pct < 100 ? `<span style="margin-left:8px;color:#e3b341">相似度 ${item.similarity_pct}%</span>` : ''}
              <span style="margin-left:8px">${fmtDate(item.collected_at)}</span>
              ${item.tags ? `<span style="margin-left:8px;font-size:10px;color:#484f58">🏷 ${esc(item.tags)}</span>` : ''}
            </div>
          </div>
          <div style="margin-left:12px;flex-shrink:0">
            <button class="btn sm" onclick="toggleSaveResult(${item.id},${!item.is_saved})">${item.is_saved ? '💾' : '📌'}</button>
            <button class="btn sm" onclick="deleteExploreResult(${item.id})" style="color:#f85149">✕</button>
          </div>
        </div>
      </div>`).join('');
  } catch (e) { el.innerHTML = `<p style="color:#f85149;text-align:center;padding:20px">加载失败: ${e.message}</p>`; }
}

function doExploreFilter() {
  _exploreFilter = document.getElementById('exploreQ')?.value || '';
  loadExploreResults();
}

async function toggleSaveResult(id, save) {
  try {
    await api(`/api/explore/results/${id}/${save ? 'save' : 'unsave'}`, { method: 'POST' });
    loadExploreResults();
  } catch (e) { toast('操作失败: ' + e.message, true); }
}

async function deleteExploreResult(id) {
  if (!confirm('确认删除？')) return;
  try {
    await api('/api/explore/results/' + id, { method: 'DELETE' });
    toast('已删除');
    loadExploreResults();
    loadExploreStats();
  } catch (e) { toast('删除失败: ' + e.message, true); }
}

async function loadExploreStats() {
  const el = document.getElementById('exploreStats');
  if (!el) return;
  try {
    const s = await api('/api/explore/stats');
    el.innerHTML = `<div class="stat"><b>${s.total_results}</b><span>收录</span></div>
      <div class="stat"><b>${s.saved_results}</b><span>已存</span></div>
      <div class="stat"><b>${s.active_directions}</b><span>方向</span></div>
      <div class="stat"><b>${s.total_directions}</b><span>总方向</span></div>`;
  } catch (e) {}
}

// ====== 方向管理 ======
function pageExploreDirections() {
  return `<h2 style="font-size:18px;color:#f0f6fc;margin-bottom:16px">🎯 探索方向设置</h2>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:8px">添加自定义方向</h3>
    <div class="row">
      <input id="newDirIcon" placeholder="图标emoji" style="width:60px;text-align:center" value="🔍">
      <input id="newDirName" placeholder="方向名称" style="width:120px">
      <input id="newDirKeys" placeholder="关键词 (空格分隔)" style="flex:1">
      <button class="btn pri sm" onclick="addCustomDirection()">添加</button>
    </div>
  </div>
  <div id="exploreDirectionsList" style="margin-top:8px">加载中...</div>`;
}

async function loadExploreDirectionsList() {
  const el = document.getElementById('exploreDirectionsList');
  if (!el) return;
  try {
    const dirs = await api('/api/explore/directions');
    el.innerHTML = dirs.map(d => `
      <div class="card" style="margin-bottom:6px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px;flex:1">
            <span style="font-size:20px">${esc(d.icon)}</span>
            <div>
              <b style="font-size:13px">${esc(d.direction_name)}</b>
              ${d.is_preset ? '<span class="badge ok" style="margin-left:4px">预设</span>' : ''}
              <br><span style="font-size:11px;color:#8b949e">${esc(d.keywords)}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <label class="toggle">
              <input type="checkbox" ${d.is_active ? 'checked' : ''} onchange="toggleExploreDir(${d.id},this.checked)">
              <span class="slider"></span>
            </label>
            ${!d.is_preset ? `<button class="btn sm" onclick="deleteExploreDir(${d.id})" style="color:#f85149" title="删除">✕</button>` : ''}
          </div>
        </div>
      </div>`).join('');
  } catch (e) { el.innerHTML = `<p style="color:#f85149">加载失败: ${e.message}</p>`; }
}

async function addCustomDirection() {
  const name = document.getElementById('newDirName')?.value.trim();
  const keys = document.getElementById('newDirKeys')?.value.trim();
  const icon = document.getElementById('newDirIcon')?.value || '🔍';
  if (!name) { toast('请输入方向名称', true); return; }
  try {
    await api('/api/explore/directions', { method: 'POST', body: JSON.stringify({ direction_name: name, keywords: keys, icon }) });
    toast('方向已添加');
    loadExploreDirectionsList();
    document.getElementById('newDirName').value = '';
    document.getElementById('newDirKeys').value = '';
  } catch (e) { toast('添加失败: ' + e.message, true); }
}

async function toggleExploreDir(id, active) {
  try {
    await api(`/api/explore/directions/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: active }) });
  } catch (e) { toast('切换失败: ' + e.message, true); loadExploreDirectionsList(); }
}

async function deleteExploreDir(id) {
  if (!confirm('确认删除该方向？')) return;
  try {
    await api(`/api/explore/directions/${id}`, { method: 'DELETE' });
    toast('已删除');
    loadExploreDirectionsList();
  } catch (e) { toast('删除失败: ' + e.message, true); }
}

// ====== 黑名单管理 ======
function pageExploreBlacklist() {
  return `<h2 style="font-size:18px;color:#f0f6fc;margin-bottom:4px">🚫 内容过滤黑名单</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:16px">含有这些关键词的内容将被自动过滤，不会收录到探索结果中</p>
  <div class="card">
    <h3 style="font-size:14px;margin-bottom:8px">添加过滤词</h3>
    <div class="row">
      <input id="newBlPattern" placeholder="关键词" style="width:150px">
      <input id="newBlReason" placeholder="过滤原因" style="flex:1">
      <button class="btn pri sm" onclick="addBlacklist()">添加</button>
    </div>
  </div>
  <div id="exploreBlacklistList" style="margin-top:8px">加载中...</div>`;
}

async function loadExploreBlacklistList() {
  const el = document.getElementById('exploreBlacklistList');
  if (!el) return;
  try {
    const bl = await api('/api/explore/blacklist');
    el.innerHTML = bl.map(b => `
      <div class="card" style="margin-bottom:6px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="flex:1">
            <span style="font-size:13px">🔒 ${esc(b.pattern)}</span>
            <span style="font-size:11px;color:#8b949e;margin-left:8px">${esc(b.reason)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <label class="toggle">
              <input type="checkbox" ${b.is_active ? 'checked' : ''} onchange="toggleBlacklist(${b.id},this.checked)">
              <span class="slider"></span>
            </label>
            <button class="btn sm" onclick="deleteBlacklist(${b.id})" style="color:#f85149" title="删除">✕</button>
          </div>
        </div>
      </div>`).join('');
  } catch (e) { el.innerHTML = `<p style="color:#f85149">加载失败: ${e.message}</p>`; }
}

async function addBlacklist() {
  const pattern = document.getElementById('newBlPattern')?.value.trim();
  const reason = document.getElementById('newBlReason')?.value.trim() || pattern;
  if (!pattern) { toast('请输入关键词', true); return; }
  try {
    await api('/api/explore/blacklist', { method: 'POST', body: JSON.stringify({ pattern, reason }) });
    toast('已添加');
    loadExploreBlacklistList();
    document.getElementById('newBlPattern').value = '';
    document.getElementById('newBlReason').value = '';
  } catch (e) { toast('添加失败: ' + e.message, true); }
}

async function toggleBlacklist(id, active) {
  try {
    await api(`/api/explore/blacklist/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: active }) });
  } catch (e) { toast('切换失败: ' + e.message, true); loadExploreBlacklistList(); }
}

async function deleteBlacklist(id) {
  if (!confirm('确认删除？')) return;
  try {
    await api(`/api/explore/blacklist/${id}`, { method: 'DELETE' });
    toast('已删除');
    loadExploreBlacklistList();
  } catch (e) { toast('删除失败: ' + e.message, true); }
}

// Backward compat
const pageDisplaySearch = pageDisplayExplore;

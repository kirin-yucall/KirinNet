// ======================== Content Pages ===========================
// 草稿 / 回收站 / 足迹 / 订阅 / 粉丝
// Global deps: api(), esc(), fmtDate(), toast(), DOMAIN, PORT, AUTH

// --- 草稿箱 ---
function pageContentDrafts() {
  return `<h2>📝 草稿箱</h2>
  <div class="row" style="margin-bottom:12px">
    <button class="btn pri" onclick="navTo('content','content_upload')">+ 新建内容</button>
  </div>
  <div id="drafts-container"><div class="loading">加载中...</div></div>`;
}

async function pageContentDraftsData() {
  const c = document.getElementById('drafts-container');
  try {
    const items = await api('/api/drafts');
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无草稿</p></div>'; return; }
    let h = '';
    items.forEach(item => {
      h += `<div class="card" id="draft-${item.id}">
        <h3>${esc(item.title||'(无标题)')} <span class="badge ok">${esc(item.content_type)}</span></h3>
        <p class="desc">保存于 ${fmtDate(item.saved_at||item.updated_at)}</p>
        <div class="row" style="gap:6px">
          <button class="btn pri sm" onclick="editDraft(${item.id},'${esc((item.title||'').replace(/'/g,"\\'"))}','${esc(item.content_type)}')">编辑</button>
          <button class="btn sm" onclick="publishDraft(${item.id})">发布</button>
          <button class="btn danger sm" onclick="deleteDraft(${item.id})">删除</button>
        </div>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function editDraft(id, title, type) {
  const newTitle = prompt('修改标题:', title);
  if (newTitle === null) return;
  try {
    await api('/api/drafts/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle }) });
    toast('✅ 已更新');
    pageContentDraftsData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function publishDraft(id) {
  if (!confirm('确定发布此草稿？发布后草稿将被删除。')) return;
  try {
    const r = await api('/api/drafts/' + id + '/publish', { method: 'POST' });
    toast('✅ 已发布: ' + (r.title || r.content_id));
    pageContentDraftsData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function deleteDraft(id) {
  if (!confirm('确定删除此草稿？')) return;
  try {
    await api('/api/drafts/' + id, { method: 'DELETE' });
    toast('已删除');
    pageContentDraftsData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// --- 回收站 ---
function pageContentRecycle() {
  return `<h2>🗑️ 回收站</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">被删除的内容会在此暂存，可恢复或永久删除</p>
  <div id="recycle-container"><div class="loading">加载中...</div></div>`;
}

async function pageContentRecycleData() {
  const c = document.getElementById('recycle-container');
  try {
    // 尝试获取被软删除的内容 (GET /api/content?deleted=true)
    let items = [];
    try {
      items = await api('/api/content?deleted=true');
    } catch (_) {
      // 如果后端不支持 deleted 参数，回退到本地 mock
      c.innerHTML = '<div class="card"><p style="color:#8b949e">回收站为空</p><p style="font-size:11px;color:#484f58">后端软删除支持开发中，删除的内容将显示在这里</p></div>';
      return;
    }
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">回收站为空</p></div>'; return; }
    let h = '';
    items.forEach(item => {
      h += `<div class="card">
        <h3>${esc(item.title)} <span class="badge ok">${esc(item.content_type)}</span></h3>
        <p class="desc">删除于 ${fmtDate(item.deleted_at||item.updated_at)}</p>
        <div class="row" style="gap:6px">
          <button class="btn pri sm" onclick="restoreContent('${item.id}')">🔄 恢复</button>
          <button class="btn danger sm" onclick="permDeleteContent('${item.id}')">⛔ 永久删除</button>
        </div>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function restoreContent(id) {
  if (!confirm('确定恢复此内容？')) return;
  try {
    await api('/api/content/' + id + '/restore', { method: 'POST' });
    toast('✅ 已恢复');
    pageContentRecycleData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function permDeleteContent(id) {
  if (!confirm('永久删除后无法恢复，确定？')) return;
  try {
    await api('/api/content/' + id, { method: 'DELETE' });
    toast('已永久删除');
    pageContentRecycleData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// --- 足迹 ---
function pageContentHistory() {
  return `<h2>👣 浏览足迹</h2>
  <div class="row" style="margin-bottom:12px">
    <span style="font-size:12px;color:#8b949e">域名: <b style="color:#3fb950">${DOMAIN||'self'}</b></span>
    <button class="btn danger sm" onclick="clearHistory()">🗑️ 清空全部</button>
  </div>
  <div id="history-container"><div class="loading">加载中...</div></div>`;
}

async function pageContentHistoryData() {
  const c = document.getElementById('history-container');
  try {
    const items = await api('/api/history?domain=' + (DOMAIN || 'self'));
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无浏览记录</p></div>'; return; }
    let h = '';
    items.forEach(item => {
      h += `<div class="card">
        <h3>${esc(item.content_id)}</h3>
        <p class="desc">来源: <span class="domain">${esc(item.domain)}</span> · ${fmtDate(item.viewed_at)}</p>
        <button class="btn danger sm" onclick="delHistory(${item.id})">删除</button>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function delHistory(id) {
  try {
    await api('/api/history/' + id, { method: 'DELETE' });
    toast('已删除');
    pageContentHistoryData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function clearHistory() {
  if (!confirm('确定清空全部足迹？')) return;
  try {
    await api('/api/history/clear/' + (DOMAIN || 'self'), { method: 'DELETE' });
    toast('已清空');
    pageContentHistoryData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// --- 订阅管理 (我关注的) ---
function pageContentSubscribe() {
  return `<h2>📌 订阅管理</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">我关注的节点域名</p>
  <div id="subscribe-container"><div class="loading">加载中...</div></div>
  <div class="card" style="margin-top:16px">
    <h3>+ 关注新节点</h3>
    <div class="row" style="margin-top:8px">
      <input type="text" id="subDomain" placeholder="对方域名" style="width:240px">
      <button class="btn pri sm" onclick="doSubscribe()">关注</button>
    </div>
  </div>`;
}

async function pageContentSubscribeData() {
  const c = document.getElementById('subscribe-container');
  try {
    // GET /api/followers 返回的是关注我的人，这里需要"我关注的"列表
    // 使用 /api/followers?direction=following 或本地存储
    let items = [];
    try {
      items = await api('/api/followers?direction=following');
    } catch (_) {
      // 回退：从 contacts 获取
      try {
        items = await api('/api/contacts');
        items = items.filter(x => x.contact_type === 'following' || x.direction === 'outgoing');
      } catch (_2) {
        c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无订阅</p><p style="font-size:11px;color:#484f58">关注其他节点后显示在此处</p></div>';
        return;
      }
    }
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无订阅</p></div>'; return; }
    let h = '';
    items.forEach(item => {
      const domain = item.following_domain || item.contact_domain || item.domain || '';
      h += `<div class="card">
        <h3>${esc(domain)}</h3>
        <p class="desc">订阅于 ${fmtDate(item.created_at||item.subscribed_at)}</p>
        <button class="btn danger sm" onclick="unsubscribeNode('${esc(domain.replace(/'/g,"\\'"))}')">取消关注</button>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function doSubscribe() {
  const domain = document.getElementById('subDomain').value.trim();
  if (!domain) return toast('请输入域名', 'err');
  try {
    await api('/api/followers/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ follower_domain: domain, public_key: '' })
    });
    toast('✅ 已关注 ' + domain);
    pageContentSubscribeData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function unsubscribeNode(domain) {
  if (!confirm('确定取消关注 ' + domain + '？')) return;
  try {
    await api('/api/followers/' + domain, { method: 'DELETE' });
    toast('已取消关注');
    pageContentSubscribeData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// --- 粉丝管理 ---
function pageContentFans() {
  return `<h2>👥 粉丝管理</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">关注了我的节点域名</p>
  <div id="fans-container"><div class="loading">加载中...</div></div>`;
}

async function pageContentFansData() {
  const c = document.getElementById('fans-container');
  try {
    const data = await api('/api/followers');
    const items = data.followers || data || [];
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无粉丝</p></div>'; return; }
    let h = '';
    items.forEach(f => {
      h += `<div class="card">
        <h3>${esc(f.follower_domain)}</h3>
        <p class="desc">关注于 ${fmtDate(f.subscribed_at||f.created_at)}</p>
        <button class="btn sm" onclick="viewFollowerPush('${esc((f.follower_domain||'').replace(/'/g,"\\'"))}')">查看推送</button>
        <button class="btn danger sm" onclick="removeFan('${esc((f.follower_domain||'').replace(/'/g,"\\'"))}')">移除</button>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function viewFollowerPush(domain) {
  try {
    const data = await api('/api/followers/' + domain + '/pushes');
    if (!data.pushes || !data.pushes.length) {
      toast('该粉丝暂无加密推送', 'err');
      return;
    }
    let msg = '粉丝 ' + domain + ' 的加密推送 (' + data.pushes.length + '条):\n\n';
    data.pushes.forEach((p, i) => {
      msg += (i + 1) + '. ' + (p.title || p.content_id) + ' @ ' + fmtDate(p.created_at) + '\n';
    });
    alert(msg);
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function removeFan(domain) {
  if (!confirm('确定移除粉丝 ' + domain + '？')) return;
  try {
    await api('/api/followers/' + domain, { method: 'DELETE' });
    toast('已移除');
    pageContentFansData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

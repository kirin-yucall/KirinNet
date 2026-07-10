// ======================== pages_display.js ========================
// Display 扩展页面：分类浏览、探索

// --- Display: 探索（委托 pages_explore.js） ---
function pageDisplayExplore(){
  return typeof pageExploreRender === 'function'
    ? pageExploreRender()
    : `<h2>🔍 探索</h2><div class="card"><p style="color:#8b949e">探索模块加载中...</p></div>`;
}
// 向前兼容别名
const pageDisplaySearch = pageDisplayExplore;

// --- Display: 分类浏览 ---
async function pageDisplayCategories() {
  const tabs = [
    { key: 'article', icon: '📄', label: '文章' },
    { key: 'commodity', icon: '🛒', label: '商品' },
    { key: 'post', icon: '📝', label: '帖子' },
    { key: 'video', icon: '🎬', label: '视频' }
  ];

  return `<h2 style="font-size:18px;color:#f0f6fc;margin-bottom:16px">📂 分类浏览</h2>
  <!-- Tab 切换 -->
  <div style="display:flex;gap:4px;margin-bottom:16px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:4px;width:fit-content">
    ${tabs.map((t, i) => `<button class="cat-tab btn sm" data-cat="${t.key}" onclick="switchCategory('${t.key}')" style="${i === 0 ? 'background:#1f6feb;color:#fff;border-color:#1f6feb' : ''}">${t.icon} ${t.label}</button>`).join('')}
  </div>
  <!-- 内容区域 -->
  <div id="catContent">
    <p style="text-align:center;color:#8b949e;padding:40px">加载中...</p>
  </div>`;
}

// 分类加载函数：在 bindEvents 后由 switchCategory 触发初始加载
let _currentCategory = 'article';
let _allContentCache = null;

async function switchCategory(cat) {
  _currentCategory = cat;
  // 更新 tab 样式
  document.querySelectorAll('.cat-tab').forEach(btn => {
    if (btn.dataset.cat === cat) {
      btn.style.background = '#1f6feb';
      btn.style.color = '#fff';
      btn.style.borderColor = '#1f6feb';
    } else {
      btn.style.background = '#21262d';
      btn.style.color = '#c9d1d9';
      btn.style.borderColor = '#30363d';
    }
  });
  // 加载并显示该分类内容
  await loadCategoryContent(cat);
}

async function loadCategoryContent(cat) {
  const container = document.getElementById('catContent');
  if (!container) return;
  container.innerHTML = '<p style="text-align:center;color:#8b949e;padding:40px">加载中...</p>';

  try {
    // 获取内容列表，按 domain=x (自己的内容)
    let items;
    if (!_allContentCache) {
      items = await api('/api/content?limit=200');
      _allContentCache = items || [];
    } else {
      items = _allContentCache;
    }

    const filtered = items.filter(item => (item.content_type || 'article') === cat);

    if (!filtered.length) {
      const icons = { article: '📄', commodity: '🛒', post: '📝', video: '🎬' };
      container.innerHTML = `<div class="card" style="text-align:center;padding:40px">
        <div style="font-size:40px;margin-bottom:12px">${icons[cat] || '📂'}</div>
        <p style="color:#8b949e">暂无${cat === 'article' ? '文章' : cat === 'commodity' ? '商品' : cat === 'post' ? '帖子' : '视频'}内容</p>
        <button class="btn pri" style="margin-top:12px" onclick="navTo('content','content_upload')">📤 发布内容</button>
      </div>`;
      return;
    }

    container.innerHTML = `<p style="color:#8b949e;font-size:12px;margin-bottom:12px">共 <b style="color:#58a6ff">${filtered.length}</b> 条</p>` +
      filtered.map(item => {
        const typeBadge = { article: 'badge ok', commodity: 'badge warn', post: 'badge', video: 'badge ok' };
        const typeLabel = { article: '文章', commodity: '商品', post: '帖子', video: '视频' };
        const thumbIcons = { article: '📄', commodity: '🛒', post: '📝', video: '🎬' };
        return `<div class="card" style="display:flex;gap:12px;align-items:flex-start">
          <div class="thumb" style="width:60px;height:60px;font-size:22px;flex-shrink:0">${thumbIcons[item.content_type] || '📄'}</div>
          <div style="flex:1;min-width:0">
            <h3 style="font-size:14px;color:#58a6ff;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.title || '无标题')}</h3>
            <p class="desc" style="margin-bottom:6px">${esc((item.description || item.body || '').substring(0, 120))}</p>
            <div class="meta" style="font-size:11px;color:#8b949e">
              <span class="${typeBadge[item.content_type] || 'badge'}">${typeLabel[item.content_type] || item.content_type}</span>
              <span style="margin-left:8px">${fmtDate(item.created_at)}</span>
              ${item.views ? `<span style="margin-left:8px">👁 ${item.views}</span>` : ''}
              ${item.likes ? `<span style="margin-left:8px">❤️ ${item.likes}</span>` : ''}
            </div>
          </div>
        </div>`;
      }).join('');
  } catch (e) {
    container.innerHTML = `<div class="card"><p style="color:#f85149">加载分类内容失败: ${e.message}</p></div>`;
  }
}

// ======================== pages_center.js ========================
// Center 扩展页面：数据统计 + 运行日志 + 关于

// --- Center: 数据统计 ---
async function pageCenterStats() {
  let statsCards = '';
  let errorMsg = '';

  try {
    const status = await api('/api/init/status');

    // 尝试获取各种统计数据
    let contentCount = 0, followerCount = 0, todayVisits = 0, pointsIncome = 0, adIncome = 0;

    try {
      const content = await api('/api/content?limit=1');
      contentCount = Array.isArray(content) ? content.length : (content.total || 0);
      // 再获取实际总数
      const allContent = await api('/api/content?limit=500');
      contentCount = Array.isArray(allContent) ? allContent.length : (allContent.total || contentCount);
    } catch (e) { /* 使用默认 0 */ }

    try {
      const followers = await api('/api/followers/list');
      followerCount = Array.isArray(followers) ? followers.length : (followers.total || 0);
    } catch (e) { /* 使用默认 0 */ }

    try {
      const initStatus = await fetch('/api/init/status').then(r => r.json());
      todayVisits = initStatus.today_visits || initStatus.visits || 0;
      pointsIncome = initStatus.points_income || initStatus.points || 0;
      adIncome = initStatus.ad_income || initStatus.ads_revenue || 0;
    } catch (e) { /* 使用默认 0 */ }

    const stats = [
      { num: contentCount, label: '内容总数', icon: '📝', color: '#58a6ff' },
      { num: followerCount, label: '粉丝数', icon: '👥', color: '#3fb950' },
      { num: todayVisits, label: '今日访问', icon: '👁', color: '#e3b341' },
      { num: pointsIncome, label: '积分收入', icon: '💎', color: '#bc8cff' },
      { num: adIncome, label: '广告收入', icon: '💰', color: '#f0883e' },
      { num: status.port || PORT || '8080', label: '服务端口', icon: '🔌', color: '#8b949e' }
    ];

    statsCards = stats.map(s => `
      <div class="stat" style="border-left:3px solid ${s.color}">
        <div style="font-size:12px;color:#8b949e;margin-bottom:4px">${s.icon} ${s.label}</div>
        <div class="num" style="color:${s.color}">${s.num}</div>
      </div>`).join('');

  } catch (e) {
    errorMsg = e.message;
    statsCards = `<div class="stat"><div class="num" style="color:#f85149">!</div><div class="label">加载失败</div></div>`;
  }

  return `<h2 style="font-size:18px;color:#f0f6fc;margin-bottom:20px">📊 数据统计</h2>
  ${errorMsg ? `<div class="card" style="border-color:#f85149"><p style="color:#f85149">⚠️ 部分数据加载失败: ${errorMsg}</p></div>` : ''}
  <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
    ${statsCards}
  </div>
  <div class="card" style="margin-top:16px">
    <h3>📈 节点运行状态</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
      <div>
        <span style="font-size:11px;color:#8b949e">域名</span>
        <p style="font-size:14px;color:#58a6ff;margin-top:2px">${esc(DOMAIN || '未设置')}</p>
      </div>
      <div>
        <span style="font-size:11px;color:#8b949e">端口</span>
        <p style="font-size:14px;color:#3fb950;margin-top:2px">${esc(PORT || '8080')}</p>
      </div>
      <div>
        <span style="font-size:11px;color:#8b949e">数据引擎</span>
        <p style="font-size:14px;color:#c9d1d9;margin-top:2px">DuckDB</p>
      </div>
      <div>
        <span style="font-size:11px;color:#8b949e">运行平台</span>
        <p style="font-size:14px;color:#c9d1d9;margin-top:2px">Node.js</p>
      </div>
    </div>
  </div>
  <div style="display:flex;gap:8px;margin-top:12px">
    <button class="btn sm" onclick="refreshStats()">🔄 刷新数据</button>
    <button class="btn sm" onclick="navTo('center','center_logs')">📋 查看日志</button>
    <button class="btn sm" onclick="navTo('center','center_about')">ℹ️ 关于</button>
  </div>`;
}

async function refreshStats() {
  const m = document.getElementById('main');
  m.innerHTML = await pageCenterStats();
  bindEvents('center_stats');
  toast('✅ 已刷新');
}

// --- Center: 运行日志 ---
function pageCenterLogs() {
  return `<h2 style="font-size:18px;color:#f0f6fc;margin-bottom:20px">📋 运行日志</h2>
  <div class="card" style="text-align:center;padding:40px">
    <div style="font-size:48px;margin-bottom:16px">📋</div>
    <h3 style="color:#f0f6fc;margin-bottom:8px">日志功能开发中...</h3>
    <p style="color:#8b949e;font-size:13px;line-height:1.8;max-width:500px;margin:0 auto 20px">
      实时日志查看器即将上线。<br>
      目前可通过以下方式查看服务器日志：
    </p>
    <div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:16px;text-align:left;max-width:500px;margin:0 auto;font-family:monospace;font-size:12px">
      <div style="color:#8b949e;margin-bottom:8px"># Docker 容器日志</div>
      <div style="color:#58a6ff">$ docker logs -f kirin-node</div>
      <div style="color:#8b949e;margin-top:12px;margin-bottom:8px"># 或查看 PM2 日志</div>
      <div style="color:#58a6ff">$ pm2 logs kirin-node</div>
      <div style="color:#8b949e;margin-top:12px;margin-bottom:8px"># 直接查看日志文件</div>
      <div style="color:#58a6ff">$ tail -f /var/log/kirin-node.log</div>
    </div>
  </div>
  <div style="display:flex;gap:8px;margin-top:12px">
    <button class="btn sm" onclick="navTo('center','center_stats')">📊 返回统计</button>
    <button class="btn sm" onclick="navTo('center','center_about')">ℹ️ 关于</button>
  </div>`;
}

// --- Center: 关于 ---
function pageCenterAbout() {
  return `<h2 style="font-size:18px;color:#f0f6fc;margin-bottom:20px">ℹ️ 关于 KirinNet</h2>

  <!-- 版本信息 -->
  <div class="card" style="text-align:center;padding:28px 20px">
    <div style="font-size:48px;margin-bottom:12px">🦄</div>
    <h3 style="font-size:20px;color:#58a6ff;margin-bottom:4px">KirinNet</h3>
    <p style="color:#8b949e;font-size:13px">去中心化内容与广告网络</p>
    <div style="margin-top:12px">
      <span class="badge ok" style="font-size:12px;padding:3px 10px">v1.0.0</span>
    </div>
  </div>

  <!-- 节点信息 -->
  <div class="card" style="margin-top:12px">
    <h3>🌐 节点信息</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <div>
        <span style="font-size:11px;color:#8b949e">域名</span>
        <p style="font-size:15px;color:#58a6ff;font-family:monospace;margin-top:2px">${esc(DOMAIN || '未配置')}</p>
      </div>
      <div>
        <span style="font-size:11px;color:#8b949e">端口</span>
        <p style="font-size:15px;color:#3fb950;font-family:monospace;margin-top:2px">${esc(PORT || '8080')}</p>
      </div>
    </div>
  </div>

  <!-- 技术栈 -->
  <div class="card" style="margin-top:12px">
    <h3>🛠 技术栈</h3>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
      <span class="badge ok" style="font-size:12px;padding:4px 12px">Node.js</span>
      <span class="badge ok" style="font-size:12px;padding:4px 12px">DuckDB</span>
      <span class="badge" style="font-size:12px;padding:4px 12px;background:#21262d;color:#c9d1d9">Express</span>
      <span class="badge" style="font-size:12px;padding:4px 12px;background:#21262d;color:#c9d1d9">P2P 网络</span>
      <span class="badge" style="font-size:12px;padding:4px 12px;background:#21262d;color:#c9d1d9">广告竞价</span>
      <span class="badge" style="font-size:12px;padding:4px 12px;background:#21262d;color:#c9d1d9">内容索引</span>
      <span class="badge" style="font-size:12px;padding:4px 12px;background:#21262d;color:#c9d1d9">即时通讯</span>
      <span class="badge" style="font-size:12px;padding:4px 12px;background:#21262d;color:#c9d1d9">积分系统</span>
    </div>
  </div>

  <!-- 链接 -->
  <div class="card" style="margin-top:12px">
    <h3>🔗 相关链接</h3>
    <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
      <a href="https://github.com/nousresearch" target="_blank" style="color:#58a6ff;text-decoration:none;font-size:13px;display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">🐙</span> GitHub
      </a>
      <a href="#" style="color:#58a6ff;text-decoration:none;font-size:13px;display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">📖</span> 文档 (即将上线)
      </a>
      <a href="#" style="color:#58a6ff;text-decoration:none;font-size:13px;display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">💬</span> 社区 (即将上线)
      </a>
    </div>
  </div>

  <!-- 底部操作 -->
  <div style="display:flex;gap:8px;margin-top:16px">
    <button class="btn sm" onclick="navTo('center','center_stats')">📊 数据统计</button>
    <button class="btn sm" onclick="navTo('center','center_logs')">📋 运行日志</button>
  </div>`;
}

// ======================== pages_im.js ========================
// IM 扩展页面：私聊 + 通知中心

// --- IM: 私聊 ---
async function pageIMPrivateChat() {
  let contactsHtml = '<p style="text-align:center;color:#8b949e;padding:20px">加载中...</p>';
  try {
    const contacts = await api('/api/contacts');
    const unblocked = (contacts || []).filter(c => c.status !== 'blocked');
    if (!unblocked.length) {
      contactsHtml = '<p style="text-align:center;color:#8b949e;padding:20px">暂无联系人</p>';
    } else {
      contactsHtml = unblocked.map(c => {
        const avatar = (c.avatar || '').substring(0, 2).toUpperCase() || c.domain.substring(0, 2).toUpperCase();
        return `<div class="im-contact-item" onclick="selectPrivateContact('${esc(c.domain)}', '${esc(c.nickname || c.domain)}')"
          data-domain="${esc(c.domain)}"
          style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;border-radius:6px;margin-bottom:2px;transition:.2s">
          <div style="width:32px;height:32px;border-radius:50%;background:#21262d;display:flex;align-items:center;justify-content:center;font-size:11px;color:#58a6ff;flex-shrink:0">${avatar}</div>
          <div style="min-width:0"><div style="font-size:13px;color:#f0f6fc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.nickname || c.domain)}</div>
          <div style="font-size:10px;color:#484f58">${esc(c.domain)}</div></div>
          ${c.unread_count ? `<span style="margin-left:auto;background:#da3633;color:#fff;font-size:10px;padding:1px 6px;border-radius:10px;flex-shrink:0">${c.unread_count}</span>` : ''}
        </div>`;
      }).join('');
    }
  } catch (e) {
    contactsHtml = `<p style="text-align:center;color:#f85149;padding:20px">加载联系人失败: ${e.message}</p>`;
  }

  return `<h2 style="font-size:18px;color:#f0f6fc;margin-bottom:16px">💬 私聊</h2>
  <div style="display:flex;gap:12px;min-height:480px;max-height:calc(100vh - 200px)">
    <!-- 左侧联系人列表 -->
    <div style="width:240px;background:#161b22;border:1px solid #30363d;border-radius:8px;display:flex;flex-direction:column;flex-shrink:0">
      <div style="padding:10px 12px;border-bottom:1px solid #30363d;color:#f0f6fc;font-size:13px;font-weight:600">📋 联系人</div>
      <div id="imContactList" style="flex:1;overflow-y:auto;padding:6px">
        ${contactsHtml}
      </div>
    </div>
    <!-- 右侧聊天区域 70% -->
    <div style="flex:1;background:#161b22;border:1px solid #30363d;border-radius:8px;display:flex;flex-direction:column;min-width:0">
      <div id="imChatHeader" style="padding:10px 14px;border-bottom:1px solid #30363d;color:#8b949e;font-size:13px">← 选择联系人开始私聊</div>
      <div id="imMessages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px">
        <p style="text-align:center;color:#8b949e;margin-top:100px">👈 从左侧选择一个联系人</p>
      </div>
      <div style="padding:10px;border-top:1px solid #30363d;display:flex;gap:8px">
        <input type="text" id="imMsgInput" placeholder="输入消息..." style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:8px 12px;font-size:13px" onkeydown="if(event.key==='Enter')sendPrivateMsg()" disabled>
        <button class="btn pri sm" id="imSendBtn" onclick="sendPrivateMsg()" disabled style="width:60px">发送</button>
      </div>
    </div>
  </div>`;
}

// 私聊状态
let _privateContactDomain = null;
let _privateContactName = '';

function selectPrivateContact(domain, name) {
  _privateContactDomain = domain;
  _privateContactName = name;
  document.getElementById('imChatHeader').innerHTML = `<span style="color:#58a6ff">💬</span> ${esc(name)} <span style="font-size:10px;color:#484f58">@${esc(domain)}</span>`;
  document.getElementById('imMsgInput').disabled = false;
  document.getElementById('imSendBtn').disabled = false;
  // 高亮选中联系人
  document.querySelectorAll('.im-contact-item').forEach(el => {
    el.style.background = el.dataset.domain === domain ? '#1f2937' : '';
  });
  // 加载消息历史
  loadPrivateMessages(domain);
  document.getElementById('imMsgInput').focus();
}

async function loadPrivateMessages(domain) {
  const area = document.getElementById('imMessages');
  area.innerHTML = '<p style="text-align:center;color:#8b949e;padding:20px">加载中...</p>';
  try {
    const msgs = await api(`/api/im/messages?with=${encodeURIComponent(domain)}`);
    if (!msgs || !msgs.length) {
      area.innerHTML = '<p style="text-align:center;color:#8b949e;margin-top:100px">暂无消息，发送第一条吧 ✨</p>';
      return;
    }
    area.innerHTML = msgs.map(m => {
      const isMine = m.from_domain !== domain;
      const align = isMine ? 'flex-end' : 'flex-start';
      const bg = isMine ? '#238636' : '#21262d';
      const color = isMine ? '#fff' : '#c9d1d9';
      return `<div style="display:flex;flex-direction:column;align-items:${align};margin-bottom:6px">
        <div style="max-width:70%;background:${bg};color:${color};padding:8px 14px;border-radius:16px;font-size:13px;word-break:break-word;line-height:1.5">${esc(m.body || m.content || '')}</div>
        <span style="font-size:10px;color:#484f58;margin-top:2px;padding:0 6px">${fmtDate(m.created_at || m.timestamp)}</span>
      </div>`;
    }).join('');
  } catch (e) {
    area.innerHTML = `<p style="text-align:center;color:#f85149;padding:20px">加载失败: ${e.message}</p>`;
  }
  area.scrollTop = area.scrollHeight;
}

async function sendPrivateMsg() {
  const input = document.getElementById('imMsgInput');
  const msg = input.value.trim();
  if (!msg || !_privateContactDomain) return;
  // 立即显示到界面
  const area = document.getElementById('imMessages');
  if (area.querySelector('p')) area.innerHTML = ''; // 清除 "暂无消息" 提示
  area.innerHTML += `<div style="display:flex;flex-direction:column;align-items:flex-end;margin-bottom:6px">
    <div style="max-width:70%;background:#238636;color:#fff;padding:8px 14px;border-radius:16px;font-size:13px;word-break:break-word;line-height:1.5">${esc(msg)}</div>
  </div>`;
  area.scrollTop = area.scrollHeight;
  input.value = '';
  input.focus();
  // 发送到后端
  try {
    await api('/api/im/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_domain: _privateContactDomain, body: msg })
    });
  } catch (e) {
    toast('❌ 发送失败: ' + e.message, 'err');
  }
}

// --- IM: 通知中心 ---
async function pageIMNotifications() {
  let notifications = [];
  let unreadCount = 0;
  let errorMsg = '';

  try {
    notifications = await api('/api/notifications');
    unreadCount = (notifications || []).filter(n => !n.read).length;
  } catch (e) {
    errorMsg = e.message;
  }

  // 通知类型图标映射
  const typeIcons = {
    'follow': '👤',
    'unfollow': '👋',
    'comment': '💬',
    'like': '❤️',
    'mention': '📢',
    'system': '⚙️',
    'trade': '💰',
    'message': '💬',
    'ad': '📢',
    'points': '💎',
    'default': '🔔'
  };

  let html = `<h2 style="font-size:18px;color:#f0f6fc;margin-bottom:16px">🔔 通知中心</h2>`;

  // 顶部未读数 + 全部已读按钮
  html += `<div class="card" style="display:flex;align-items:center;justify-content:space-between">
    <div>
      <span style="font-size:15px;color:#f0f6fc">通知</span>
      ${unreadCount > 0 ? `<span class="badge" style="background:#da3633;color:#fff;font-size:12px;padding:2px 10px;margin-left:8px">${unreadCount} 条未读</span>` : '<span style="font-size:12px;color:#3fb950;margin-left:8px">✅ 全部已读</span>'}
    </div>
    <button class="btn sm" onclick="markAllNotifRead()" ${unreadCount === 0 ? 'disabled style="opacity:0.4"' : ''}>📖 全部已读</button>
  </div>`;

  if (errorMsg) {
    html += `<div class="card"><p style="color:#f85149">加载失败: ${errorMsg}</p></div>`;
  } else if (!notifications || !notifications.length) {
    html += `<div class="card"><p style="text-align:center;color:#8b949e;padding:40px">🎉 暂无通知</p></div>`;
  } else {
    notifications.forEach(n => {
      const icon = typeIcons[n.type] || typeIcons['default'];
      const isUnread = !n.read;
      const bg = isUnread ? 'background:rgba(88,166,255,0.06);' : '';
      html += `<div class="card" style="${bg}display:flex;align-items:flex-start;gap:12px;padding:14px 16px" data-nid="${n.id}">
        <div style="font-size:24px;flex-shrink:0;margin-top:2px">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <strong style="font-size:14px;color:#f0f6fc">${esc(n.title || n.type)}</strong>
            ${isUnread ? '<span style="width:7px;height:7px;border-radius:50%;background:#58a6ff;flex-shrink:0"></span>' : ''}
          </div>
          <p style="font-size:13px;color:#8b949e;margin-bottom:4px;line-height:1.5">${esc(n.content || n.body || '')}</p>
          <div style="display:flex;align-items:center;gap:12px;font-size:11px;color:#484f58">
            ${n.source_domain ? `<span>来源: <span style="color:#58a6ff">${esc(n.source_domain)}</span></span>` : ''}
            <span>${fmtDate(n.created_at)}</span>
            ${isUnread ? `<span style="color:#e3b341">● 未读</span>` : '<span style="color:#3fb950">✓ 已读</span>'}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
          ${isUnread ? `<button class="btn sm pri" onclick="markNotifRead(${n.id})">标记已读</button>` : ''}
          <button class="btn sm danger" onclick="delNotif(${n.id})" style="font-size:10px;padding:3px 8px">🗑</button>
        </div>
      </div>`;
    });
  }

  return html;
}

async function markNotifRead(id) {
  try {
    await api(`/api/notifications/${id}/read`, { method: 'PUT' });
    toast('✅ 已标记为已读');
    // 刷新通知页面
    const m = document.getElementById('main');
    m.innerHTML = await pageIMNotifications();
    bindEvents('im_notifications');
  } catch (e) {
    toast('❌ ' + e.message, 'err');
  }
}

async function markAllNotifRead() {
  try {
    await api('/api/notifications/read-all', { method: 'PUT' });
    toast('✅ 全部已读');
    const m = document.getElementById('main');
    m.innerHTML = await pageIMNotifications();
    bindEvents('im_notifications');
  } catch (e) {
    toast('❌ ' + e.message, 'err');
  }
}

async function delNotif(id) {
  if (!confirm('确定删除此通知？')) return;
  try {
    await api(`/api/notifications/${id}`, { method: 'DELETE' });
    toast('已删除');
    const m = document.getElementById('main');
    m.innerHTML = await pageIMNotifications();
    bindEvents('im_notifications');
  } catch (e) {
    toast('❌ ' + e.message, 'err');
  }
}

// ======================== Trade Pages ===========================
// 卖出 / 购买 / 购物车 / 收藏 / 卡券 / 支付 / 收款
// Global deps: api(), esc(), fmtDate(), toast(), DOMAIN, PORT, AUTH

// --- 卖出订单 ---
function pageTradeSellOrders() {
  return `<h2>📤 卖出订单</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">作为卖家的订单 (seller: <b style="color:#3fb950">${DOMAIN||'self'}</b>)</p>
  <div id="sell-orders-container"><div class="loading">加载中...</div></div>`;
}

async function pageTradeSellOrdersData() {
  const c = document.getElementById('sell-orders-container');
  try {
    const items = await api('/api/orders?seller=' + (DOMAIN || 'self'));
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无卖出订单</p></div>'; return; }
    let h = '';
    items.forEach(o => {
      const statusMap = { pending: 'badge warn', paid: 'badge ok', shipped: 'badge ok', completed: 'badge ok', cancelled: 'badge red' };
      const statusClass = statusMap[o.status] || 'badge';
      const itemsList = Array.isArray(o.items) ? o.items.map(i => typeof i === 'string' ? i : (i.name || i.content_id || '')).join(', ') : '';
      h += `<div class="card" id="sell-order-${o.id}">
        <h3>订单 #${o.id} <span class="${statusClass}">${o.status}</span></h3>
        <p class="desc">买家: ${esc(o.buyer)} · 总额: ${o.total} ${o.currency||'CNY'} · ${fmtDate(o.created_at)}</p>
        ${itemsList ? '<p style="font-size:11px;color:#8b949e">商品: ' + esc(itemsList) + '</p>' : ''}
        <div class="row" style="gap:6px;margin-top:6px">`;
      if (o.status === 'pending') {
        h += `<button class="btn pri sm" onclick="updateOrderStatus(${o.id},'paid')">标记已付款</button>
              <button class="btn danger sm" onclick="updateOrderStatus(${o.id},'cancelled')">取消</button>`;
      } else if (o.status === 'paid') {
        h += `<button class="btn pri sm" onclick="updateOrderStatus(${o.id},'shipped')">标记已发货</button>
              <button class="btn danger sm" onclick="updateOrderStatus(${o.id},'cancelled')">取消</button>`;
      } else if (o.status === 'shipped') {
        h += `<button class="btn pri sm" onclick="updateOrderStatus(${o.id},'completed')">标记已完成</button>`;
      }
      h += `</div></div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function updateOrderStatus(id, status) {
  const labels = { paid: '标记已付款', shipped: '标记已发货', completed: '标记已完成', cancelled: '取消订单' };
  if (!confirm('确定' + (labels[status] || status) + '？')) return;
  try {
    await api('/api/orders/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }) });
    toast('✅ 状态已更新');
    pageTradeSellOrdersData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// --- 购买订单 ---
function pageTradeBuyOrders() {
  return `<h2>📥 购买订单</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">作为买家的订单 (buyer: <b style="color:#3fb950">${DOMAIN||'self'}</b>)</p>
  <div id="buy-orders-container"><div class="loading">加载中...</div></div>`;
}

async function pageTradeBuyOrdersData() {
  const c = document.getElementById('buy-orders-container');
  try {
    const items = await api('/api/orders?buyer=' + (DOMAIN || 'self'));
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无购买订单</p></div>'; return; }
    let h = '';
    items.forEach(o => {
      const statusMap = { pending: 'badge warn', paid: 'badge ok', shipped: 'badge ok', completed: 'badge ok', cancelled: 'badge red' };
      const statusClass = statusMap[o.status] || 'badge';
      const itemsList = Array.isArray(o.items) ? o.items.map(i => typeof i === 'string' ? i : (i.name || i.content_id || '')).join(', ') : '';
      h += `<div class="card" id="buy-order-${o.id}">
        <h3>订单 #${o.id} <span class="${statusClass}">${o.status}</span></h3>
        <p class="desc">卖家: ${esc(o.seller)} · 总额: ${o.total} ${o.currency||'CNY'} · ${fmtDate(o.created_at)}</p>
        ${itemsList ? '<p style="font-size:11px;color:#8b949e">商品: ' + esc(itemsList) + '</p>' : ''}
        <div class="row" style="gap:6px;margin-top:6px">`;
      if (o.status === 'pending') {
        h += `<button class="btn danger sm" onclick="updateOrderStatus(${o.id},'cancelled')">取消订单</button>`;
      } else if (o.status === 'shipped') {
        h += `<button class="btn pri sm" onclick="updateOrderStatus(${o.id},'completed')">确认收货</button>`;
      }
      h += `</div></div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

// --- 购物车 ---
function pageTradeCart() {
  return `<h2>🛒 购物车</h2>
  <div id="cart-container"><div class="loading">加载中...</div></div>
  <div class="card" style="margin-top:16px">
    <h3>+ 添加到购物车</h3>
    <div class="row" style="margin-top:8px">
      <input type="text" id="cartContentId" placeholder="内容ID" style="width:200px">
      <input type="number" id="cartQty" value="1" min="1" style="width:70px">
      <button class="btn pri sm" onclick="addToCart()">添加</button>
    </div>
  </div>`;
}

async function pageTradeCartData() {
  const c = document.getElementById('cart-container');
  try {
    const items = await api('/api/cart?domain=' + (DOMAIN || 'self'));
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">购物车为空</p></div>'; return; }
    let h = '';
    items.forEach(item => {
      h += `<div class="card">
        <h3>${esc(item.content_id)}</h3>
        <p class="desc">数量: ${item.qty||1} · 添加于 ${fmtDate(item.added_at)}</p>
        <div class="row" style="gap:6px">
          <button class="btn pri sm" onclick="checkoutCart('${esc((item.content_id||'').replace(/'/g,"\\'"))}',${item.qty||1})">结算</button>
          <button class="btn danger sm" onclick="removeCartItem(${item.id})">删除</button>
        </div>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function addToCart() {
  const contentId = document.getElementById('cartContentId').value.trim();
  const qty = parseInt(document.getElementById('cartQty').value) || 1;
  if (!contentId) return toast('请输入内容ID', 'err');
  try {
    await api('/api/cart', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_id: contentId, domain: DOMAIN || 'self', qty }) });
    toast('✅ 已添加到购物车');
    document.getElementById('cartContentId').value = '';
    document.getElementById('cartQty').value = '1';
    pageTradeCartData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function removeCartItem(id) {
  if (!confirm('确定移除此商品？')) return;
  try {
    await api('/api/cart/' + id, { method: 'DELETE' });
    toast('已移除');
    pageTradeCartData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function checkoutCart(contentId, qty) {
  if (!confirm('确定结算？将创建购买订单。')) return;
  try {
    const order = await api('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_type: 'buy',
        buyer: DOMAIN || 'self',
        seller: '', // 需要从内容获取卖家域名，暂留空
        items: [{ content_id: contentId, qty }],
        total: 0,
        currency: 'CNY'
      })
    });
    toast('✅ 订单已创建 #' + order.id);
    pageTradeCartData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// --- 收藏 ---
function pageTradeFavorites() {
  return `<h2>⭐ 我的收藏</h2>
  <div id="favorites-container"><div class="loading">加载中...</div></div>`;
}

async function pageTradeFavoritesData() {
  const c = document.getElementById('favorites-container');
  try {
    const items = await api('/api/favorites?domain=' + (DOMAIN || 'self'));
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无收藏</p></div>'; return; }
    let h = '';
    items.forEach(item => {
      h += `<div class="card">
        <h3>${esc(item.content_id)}</h3>
        <p class="desc">收藏于 ${fmtDate(item.created_at)}</p>
        <button class="btn danger sm" onclick="removeFavorite(${item.id})">取消收藏</button>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function removeFavorite(id) {
  if (!confirm('确定取消收藏？')) return;
  try {
    await api('/api/favorites/' + id, { method: 'DELETE' });
    toast('已取消收藏');
    pageTradeFavoritesData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// --- 优惠卡券 ---
function pageTradeCoupons() {
  return `<h2>🎫 优惠卡券</h2>
  <div id="coupons-container"><div class="loading">加载中...</div></div>
  <div class="card" style="margin-top:16px">
    <h3>+ 创建卡券</h3>
    <div class="row" style="margin-top:8px;flex-wrap:wrap">
      <input type="text" id="cpCode" placeholder="券码" style="width:150px">
      <select id="cpType"><option value="discount">折扣券</option><option value="free_shipping">免邮券</option></select>
      <input type="number" id="cpValue" placeholder="面值" min="0" style="width:80px">
      <input type="number" id="cpMinOrder" placeholder="最低消费" min="0" value="0" style="width:90px">
      <input type="number" id="cpMaxDiscount" placeholder="最高优惠" min="0" style="width:90px">
      <input type="text" id="cpExpires" placeholder="过期日 (YYYY-MM-DD)" style="width:140px">
      <button class="btn pri sm" onclick="createCoupon()">创建</button>
    </div>
  </div>`;
}

async function pageTradeCouponsData() {
  const c = document.getElementById('coupons-container');
  try {
    const items = await api('/api/coupons');
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无卡券</p></div>'; return; }
    let h = '';
    items.forEach(cp => {
      const expired = cp.expires_at && new Date(cp.expires_at) < new Date();
      const statusBadge = cp.used ? '<span class="badge red">已使用</span>' : expired ? '<span class="badge warn">已过期</span>' : '<span class="badge ok">可用</span>';
      h += `<div class="card">
        <h3>🎫 ${esc(cp.code)} ${statusBadge}</h3>
        <p class="desc">
          类型: ${cp.coupon_type==='discount'?'折扣券':'免邮券'} ·
          面值: ${cp.value} ·
          最低消费: ${cp.min_order||0} ·
          最高优惠: ${cp.max_discount||'无'} ·
          过期: ${cp.expires_at?cp.expires_at.slice(0,10):'永不过期'}
        </p>
        ${cp.used ? '<p style="font-size:11px;color:#8b949e">使用者: ' + esc(cp.used_by||'') + ' · ' + fmtDate(cp.used_at) + '</p>' : ''}
        <button class="btn danger sm" onclick="deleteCoupon(${cp.id})">删除</button>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function createCoupon() {
  const code = document.getElementById('cpCode').value.trim();
  const type = document.getElementById('cpType').value;
  const value = parseFloat(document.getElementById('cpValue').value);
  const minOrder = parseFloat(document.getElementById('cpMinOrder').value) || 0;
  const maxDiscount = parseFloat(document.getElementById('cpMaxDiscount').value) || null;
  const expires = document.getElementById('cpExpires').value || null;
  if (!code) return toast('券码不能为空', 'err');
  if (isNaN(value)) return toast('面值无效', 'err');
  try {
    const body = { code, coupon_type: type, value, min_order: minOrder };
    if (maxDiscount) body.max_discount = maxDiscount;
    if (expires) body.expires_at = expires + 'T23:59:59Z';
    await api('/api/coupons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('✅ 卡券已创建');
    document.getElementById('cpCode').value = '';
    document.getElementById('cpValue').value = '';
    pageTradeCouponsData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function deleteCoupon(id) {
  if (!confirm('确定删除此卡券？')) return;
  try {
    await api('/api/coupons/' + id, { method: 'DELETE' });
    toast('已删除');
    pageTradeCouponsData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// --- 支付设置 ---
function pageTradePayment() {
  return `<h2>💳 支付方式</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">管理所有支付方式（银行/加密货币/支付宝/微信/PayPal）</p>
  <div id="payment-container"><div class="loading">加载中...</div></div>
  <div class="card" style="margin-top:16px">
    <h3>+ 添加支付方式</h3>
    <div class="row" style="margin-top:8px;flex-wrap:wrap">
      <select id="pmType"><option value="bank">银行</option><option value="crypto">加密货币</option><option value="alipay">支付宝</option><option value="wechat">微信</option><option value="paypal">PayPal</option></select>
      <input type="text" id="pmLabel" placeholder="标签 (如: 工商银行)" style="width:150px">
      <input type="text" id="pmAccount" placeholder="账号" style="width:200px">
      <button class="btn pri sm" onclick="addPaymentMethod()">添加</button>
    </div>
  </div>`;
}

async function pageTradePaymentData() {
  const c = document.getElementById('payment-container');
  try {
    const items = await api('/api/payment-methods');
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无支付方式</p></div>'; return; }
    const typeLabel = { bank: '🏦 银行', crypto: '₿ 加密货币', alipay: '💙 支付宝', wechat: '💚 微信', paypal: '🅿️ PayPal' };
    let h = '';
    items.forEach(pm => {
      h += `<div class="card">
        <h3>${typeLabel[pm.method_type]||pm.method_type} · ${esc(pm.label)} ${pm.is_default?'<span class="badge ok">默认</span>':''}</h3>
        <p style="font-family:monospace;font-size:12px;color:#58a6ff">${esc(pm.account)}</p>
        <div class="row" style="gap:6px;margin-top:6px">
          ${pm.is_default ? '' : '<button class="btn pri sm" onclick="setDefaultPayment(' + pm.id + ')">设为默认</button>'}
          <button class="btn danger sm" onclick="deletePayment(' + pm.id + ')">删除</button>
        </div>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function addPaymentMethod() {
  const type = document.getElementById('pmType').value;
  const label = document.getElementById('pmLabel').value.trim();
  const account = document.getElementById('pmAccount').value.trim();
  if (!label) return toast('标签不能为空', 'err');
  if (!account) return toast('账号不能为空', 'err');
  try {
    await api('/api/payment-methods', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method_type: type, label, account }) });
    toast('✅ 已添加');
    document.getElementById('pmLabel').value = '';
    document.getElementById('pmAccount').value = '';
    pageTradePaymentData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function setDefaultPayment(id) {
  try {
    await api('/api/payment-methods/' + id + '/default', { method: 'PUT' });
    toast('✅ 已设为默认');
    pageTradePaymentData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function deletePayment(id) {
  if (!confirm('确定删除此支付方式？')) return;
  try {
    await api('/api/payment-methods/' + id, { method: 'DELETE' });
    toast('已删除');
    pageTradePaymentData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// --- 收款设置 ---
function pageTradeReceive() {
  return `<h2>💰 收款设置</h2>
  <p style="color:#8b949e;font-size:12px;margin-bottom:12px">管理收款账户（仅显示银行/加密货币类型，用于接收付款）</p>
  <div id="receive-container"><div class="loading">加载中...</div></div>
  <div class="card" style="margin-top:16px">
    <h3>+ 添加收款账户</h3>
    <div class="row" style="margin-top:8px;flex-wrap:wrap">
      <select id="rcType"><option value="bank">🏦 银行</option><option value="crypto">₿ 加密货币</option></select>
      <input type="text" id="rcLabel" placeholder="标签 (如: 招商银行)" style="width:150px">
      <input type="text" id="rcAccount" placeholder="账号/地址" style="width:280px">
      <button class="btn pri sm" onclick="addReceiveMethod()">添加</button>
    </div>
  </div>`;
}

async function pageTradeReceiveData() {
  const c = document.getElementById('receive-container');
  try {
    const all = await api('/api/payment-methods');
    const items = all.filter(pm => pm.method_type === 'bank' || pm.method_type === 'crypto');
    if (!items.length) { c.innerHTML = '<div class="card"><p style="color:#8b949e">暂无收款账户，请添加银行或加密货币账户</p></div>'; return; }
    const typeLabel = { bank: '🏦 银行', crypto: '₿ 加密货币' };
    let h = '';
    items.forEach(pm => {
      h += `<div class="card">
        <h3>${typeLabel[pm.method_type]||pm.method_type} · ${esc(pm.label)} ${pm.is_default?'<span class="badge ok">默认</span>':''}</h3>
        <p style="font-family:monospace;font-size:12px;color:#58a6ff;word-break:break-all">${esc(pm.account)}</p>
        <div class="row" style="gap:6px;margin-top:6px">
          ${pm.is_default ? '' : '<button class="btn pri sm" onclick="setDefaultPayment(' + pm.id + ')">设为默认</button>'}
          <button class="btn danger sm" onclick="deletePayment(' + pm.id + ')">删除</button>
        </div>
      </div>`;
    });
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="card"><p style="color:#f85149">加载失败: ' + e.message + '</p></div>'; }
}

async function addReceiveMethod() {
  const type = document.getElementById('rcType').value;
  const label = document.getElementById('rcLabel').value.trim();
  const account = document.getElementById('rcAccount').value.trim();
  if (!label) return toast('标签不能为空', 'err');
  if (!account) return toast('账号/地址不能为空', 'err');
  try {
    await api('/api/payment-methods', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method_type: type, label, account }) });
    toast('✅ 已添加');
    document.getElementById('rcLabel').value = '';
    document.getElementById('rcAccount').value = '';
    pageTradeReceiveData();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

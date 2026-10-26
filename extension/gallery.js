/**
 * gallery.js —— 图库页逻辑
 *
 * 数据流：
 *   chrome.storage.session('capture')  →  items 模型  →  DOM 卡片
 *   勾选状态 = 模型上的 selected 字段（单一数据源，UI 只做同步）
 *   下载 = 收集选中的 url（保持顺序）→ background 转 PNG 并落盘 → 进度消息回到本页渲染
 *
 * 尺寸判定为什么在这里做：
 *   content script 只能拿到「声明尺寸」或「布局尺寸」，懒加载图/背景图经常拿不到真实尺寸。
 *   图库页必须真正加载一次图片，才能用 naturalWidth 过滤掉 1x1、图标和加载失败的失效链接。
 */

const CONFIG = {
  captureKey: 'capture',
  minSide: 100,
};

// ---------------------------------------------------------------- 状态

const state = {
  items: [],          // { id, url, hint, actual, status, selected }
  downloading: false,
};

// ---------------------------------------------------------------- DOM 引用

const el = {
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  sourceInfo: document.getElementById('source-info'),
  counter: document.getElementById('counter'),
  btnAll: document.getElementById('btn-select-all'),
  btnInvert: document.getElementById('btn-invert'),
  btnDownload: document.getElementById('btn-download'),
  progress: document.getElementById('progress'),
  progressFill: document.getElementById('progress-fill'),
  progressText: document.getElementById('progress-text'),
  result: document.getElementById('result'),
};

// ---------------------------------------------------------------- 纯函数

const isSelectable = (item) => item.status === 'ok' || item.status === 'pending';
const selectedItems = (items) => items.filter((item) => item.selected && isSelectable(item));

const extLabel = (url) => {
  const match = /\.(jpe?g|png|webp|gif|bmp|avif)(?:\?|$)/i.exec(url);
  return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'img';
};

const dimsLabel = (item) => {
  if (item.actual.width && item.actual.height) return `${item.actual.width} × ${item.actual.height}`;
  if (item.hint.width && item.hint.height) return `≈ ${item.hint.width} × ${item.hint.height}`;
  return '尺寸未知';
};

// ---------------------------------------------------------------- 卡片渲染

function createCard(item) {
  const card = document.createElement('label');
  card.className = 'card';
  card.dataset.id = item.id;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'card__check';
  check.checked = item.selected;
  check.addEventListener('change', () => toggle(item.id, check.checked));

  const thumb = document.createElement('div');
  thumb.className = 'card__thumb';

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '商品图';
  img.referrerPolicy = 'no-referrer'; // 少部分 CDN 对带 referer 的请求返回 403
  img.src = item.url;
  img.addEventListener('load', () => onMeasured(item.id, img.naturalWidth, img.naturalHeight));
  img.addEventListener('error', () => updateItem(item.id, { status: 'broken', selected: false }));
  thumb.appendChild(img);

  const note = document.createElement('span');
  note.className = 'card__note';
  note.hidden = true;
  thumb.appendChild(note);

  const meta = document.createElement('div');
  meta.className = 'card__meta';
  const dims = document.createElement('span');
  dims.className = 'dims';
  const type = document.createElement('span');
  type.className = 'card__type';
  type.textContent = extLabel(item.url);
  meta.append(dims, type);

  card.append(check, thumb, meta);
  return card;
}

function renderGrid() {
  el.grid.replaceChildren(...state.items.map(createCard));
  el.empty.hidden = state.items.length > 0;
  syncUI();
}

/** 同步每张卡片的视觉状态与顶部计数（不重建 DOM，避免图片重新加载） */
function syncUI() {
  for (const item of state.items) {
    const card = el.grid.querySelector(`.card[data-id="${item.id}"]`);
    if (!card) continue;

    card.classList.toggle('is-selected', item.selected && isSelectable(item));
    card.classList.toggle('is-disabled', !isSelectable(item));

    const check = card.querySelector('.card__check');
    check.checked = item.selected;
    check.disabled = !isSelectable(item);

    card.querySelector('.dims').textContent = dimsLabel(item);

    const note = card.querySelector('.card__note');
    const noteText = { broken: '加载失败', small: '尺寸过小' }[item.status] || '';
    note.hidden = !noteText;
    note.textContent = noteText;
  }

  const count = selectedItems(state.items).length;
  el.counter.textContent = `已选 ${count} 张`;
  el.btnDownload.disabled = state.downloading || count === 0;
  el.btnDownload.textContent = state.downloading ? '下载中…' : '下载选中';
}

// ---------------------------------------------------------------- 状态更新

function updateItem(id, patch) {
  state.items = state.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
  syncUI();
}

function toggle(id, checked) {
  updateItem(id, { selected: checked });
}

function onMeasured(id, width, height) {
  const tooSmall = Math.min(width, height) < CONFIG.minSide;
  updateItem(id, {
    actual: { width, height },
    status: tooSmall ? 'small' : 'ok',
    // 过小的图自动取消勾选，避免用户批量下到一堆图标
    selected: tooSmall ? false : true,
  });
}

function selectAll(selected) {
  state.items = state.items.map((item) => (isSelectable(item) ? { ...item, selected } : item));
  syncUI();
}

function invertSelection() {
  state.items = state.items.map((item) => (isSelectable(item) ? { ...item, selected: !item.selected } : item));
  syncUI();
}

// ---------------------------------------------------------------- 载入提取结果

function applyCapture(capture) {
  if (!capture) {
    el.sourceInfo.textContent = '暂无提取记录';
    el.empty.hidden = false;
    return;
  }

  el.sourceInfo.textContent = `${capture.pageTitle || capture.pageUrl || '未知页面'} · 共 ${capture.images.length} 张候选`;

  state.items = capture.images.map((image, index) => ({
    id: `img-${index}`,
    url: image.url,
    hint: { width: image.width || 0, height: image.height || 0 },
    actual: { width: 0, height: 0 },
    status: 'pending',
    selected: true, // 先默认全选，尺寸/加载结果出来后自动纠偏
  }));

  renderGrid();
}

async function loadCapture() {
  const stored = await chrome.storage.session.get(CONFIG.captureKey);
  applyCapture(stored[CONFIG.captureKey] || null);
}

// 提取结果变化（用户在商品页又点了一次「获取图片」）时热更新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[CONFIG.captureKey]) return;
  if (state.downloading) return; // 下载过程中不要打断
  applyCapture(changes[CONFIG.captureKey].newValue || null);
});

// ---------------------------------------------------------------- 下载

function setProgress({ finished, total, label }) {
  el.progress.hidden = false;
  const percent = total ? Math.round((finished / total) * 100) : 0;
  el.progressFill.style.width = `${percent}%`;
  el.progressText.textContent = label || `正在转换并下载 ${finished}/${total}（${percent}%）`;
}

function showResult(summary) {
  el.result.hidden = false;
  el.result.classList.toggle('is-partial', summary.failed.length > 0);

  const head = document.createElement('div');
  head.className = 'result__head';
  head.textContent = summary.failed.length
    ? `已完成：成功 ${summary.success} 张，失败 ${summary.failed.length} 张`
    : `全部完成：共下载 ${summary.success} 张 PNG`;

  el.result.replaceChildren(head);

  if (summary.failed.length) {
    const list = document.createElement('ul');
    list.className = 'result__failures';
    for (const failure of summary.failed.slice(0, 20)) {
      const li = document.createElement('li');
      li.textContent = `${failure.url} —— ${failure.reason}`;
      list.appendChild(li);
    }
    el.result.appendChild(list);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'DOWNLOAD_PROGRESS') return;
  const payload = message.payload || {};

  if (payload.phase === 'start') {
    el.result.hidden = true;
    setProgress({ finished: 0, total: payload.total, label: `准备下载 ${payload.total} 张…` });
    return;
  }

  if (payload.phase === 'item') {
    const { finished, total, result } = payload;
    setProgress({
      finished,
      total,
      label: `正在转换并下载 ${finished}/${total}${result?.ok ? '' : `（${result?.filename} 失败）`}`,
    });
    return;
  }

  if (payload.phase === 'done') {
    state.downloading = false;
    syncUI();
    setProgress({ finished: payload.total, total: payload.total, label: `下载任务结束（${payload.total} 张）` });
    showResult({ success: payload.success, failed: payload.failed || [] });
  }
});

async function startDownload() {
  const urls = selectedItems(state.items).map((item) => item.url);
  if (!urls.length || state.downloading) return;

  state.downloading = true;
  el.result.hidden = true;
  syncUI();
  setProgress({ finished: 0, total: urls.length, label: '准备中…' });

  try {
    const response = await chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: { urls } });
    if (!response?.ok) throw new Error(response?.error || '下载失败');
    // 进度消息已处理完；这里兜底一次，防止进度消息丢失导致 UI 卡住
    if (state.downloading) {
      state.downloading = false;
      syncUI();
      showResult({ success: response.success, failed: response.failed || [] });
    }
  } catch (error) {
    state.downloading = false;
    syncUI();
    el.progressText.textContent = `下载失败：${error.message}`;
  }
}

// ---------------------------------------------------------------- 绑定

el.btnAll.addEventListener('click', () => selectAll(true));
el.btnInvert.addEventListener('click', invertSelection);
el.btnDownload.addEventListener('click', startDownload);

loadCapture();
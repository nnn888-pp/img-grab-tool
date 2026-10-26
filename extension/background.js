/**
 * background.js —— MV3 Service Worker
 *
 * 职责边界：
 *   1. 消息路由：content → 暂存图库数据 → 打开/聚焦 gallery.html
 *   2. 下载流水线：fetch 跨域图片 → createImageBitmap → OffscreenCanvas 转 PNG → chrome.downloads
 *   3. 进度广播：把每条下载结果推给图库页，由图库页负责展示
 *
 * 为什么 PNG 转换放在 SW 而不是图库页：
 *   - 图库页用 canvas 处理跨域图会污染画布（除非每张图都带 crossOrigin 且 CDN 给 CORS 头，电商 CDN 基本不给）；
 *   - 扩展页/SW 带 host_permissions 的 fetch 不受 CORS 限制，拿到 Blob 后解码最稳；
 *   - Service Worker 里 OffscreenCanvas + createImageBitmap 可用。
 */

const GALLERY_PAGE = 'gallery.html';
const CAPTURE_KEY = 'capture';        // chrome.storage.session：本次提取结果
const GALLERY_TAB_KEY = 'galleryTabId';
const DOWNLOAD_CONCURRENCY = 3;

// ---------------------------------------------------------------- 工具

const broadcast = (message) => {
  // 图库页未打开时会 reject，属于正常情况
  chrome.runtime.sendMessage(message).catch(() => {});
};

/** Blob → data URL（SW 里没有 FileReader，只能手写 base64） */
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/** 拉图 + 解码 + 重编码为 PNG，返回 data URL */
async function toPngDataUrl(url) {
  const response = await fetch(url, {
    credentials: 'omit',
    cache: 'force-cache',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const sourceBlob = await response.blob();
  if (!sourceBlob.size) throw new Error('空响应');

  const bitmap = await createImageBitmap(sourceBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 不可用');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(pngBlob);
}

const pad3 = (n) => String(n).padStart(3, '0');

/** 单个任务：转 PNG → 落盘 */
async function downloadOne(url, filename) {
  const dataUrl = await toPngDataUrl(url);
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  if (typeof downloadId !== 'number') throw new Error('浏览器拒绝下载');
  return downloadId;
}

/**
 * 限制并发的批量执行器（保持提交顺序 = 用户勾选顺序，方便文件名编号对得上）
 */
async function runBatch(items, worker, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let finished = 0;

  const runners = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      try {
        const downloadId = await worker(item, index);
        results[index] = { ok: true, url: item.url, filename: item.filename, downloadId };
      } catch (error) {
        results[index] = { ok: false, url: item.url, filename: item.filename, reason: String(error?.message || error) };
      }
      finished += 1;
      onProgress({ finished, total: items.length, result: results[index] });
    }
  });

  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------- 图库页管理

/** 打开或聚焦图库页（无 tabs 权限也能用 tabs.create/update） */
async function openGallery() {
  const stored = await chrome.storage.session.get(GALLERY_TAB_KEY);
  const tabId = stored[GALLERY_TAB_KEY];

  if (typeof tabId === 'number') {
    try {
      await chrome.tabs.update(tabId, { active: true, url: chrome.runtime.getURL(GALLERY_PAGE) });
      return tabId;
    } catch {
      // 标签页已被关闭，走新建分支
    }
  }

  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(GALLERY_PAGE) });
  if (tab.id) await chrome.storage.session.set({ [GALLERY_TAB_KEY]: tab.id });
  return tab.id;
}

// ---------------------------------------------------------------- 消息路由

const handlers = {
  /** content.js：提取完成 */
  async CAPTURE_IMAGES({ images, pageTitle, pageUrl }) {
    const capture = {
      images: Array.isArray(images) ? images : [],
      pageTitle: pageTitle || '',
      pageUrl: pageUrl || '',
      capturedAt: Date.now(),
    };
    await chrome.storage.session.set({ [CAPTURE_KEY]: capture });
    await openGallery();
    return { ok: true, count: capture.images.length };
  },

  /** gallery：读取最近一次提取结果（打开页面时兜底用） */
  async GET_CAPTURE() {
    const stored = await chrome.storage.session.get(CAPTURE_KEY);
    return { ok: true, capture: stored[CAPTURE_KEY] || null };
  },

  /** gallery：批量下载（按数组顺序编号 商品图_001.png） */
  async START_DOWNLOAD({ urls }) {
    const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string');
    if (!list.length) return { ok: false, error: '没有可下载的图片' };

    const items = list.map((url, index) => ({
      url,
      filename: `商品图_${pad3(index + 1)}.png`,
    }));

    broadcast({ type: 'DOWNLOAD_PROGRESS', payload: { phase: 'start', finished: 0, total: items.length } });

    const results = await runBatch(items, (item) => downloadOne(item.url, item.filename), ({ finished, total, result }) => {
      broadcast({ type: 'DOWNLOAD_PROGRESS', payload: { phase: 'item', finished, total, result } });
    });

    const summary = {
      ok: true,
      total: results.length,
      success: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).map((r) => ({ url: r.url, reason: r.reason })),
    };
    broadcast({ type: 'DOWNLOAD_PROGRESS', payload: { phase: 'done', ...summary } });
    return summary;
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(message.payload || {}))
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error('[shop-img-plugin]', message.type, error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });

  return true; // 异步响应
});

// 点击工具栏图标：直接打开图库（没有数据时图库页给空状态提示）
chrome.action.onClicked.addListener(() => {
  openGallery();
});

// 清理已关闭的图库标签记录，避免 tabs.update 反复失败
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const stored = await chrome.storage.session.get(GALLERY_TAB_KEY);
  if (stored[GALLERY_TAB_KEY] === tabId) {
    await chrome.storage.session.remove(GALLERY_TAB_KEY);
  }
});
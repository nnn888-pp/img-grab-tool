/**
 * content.js —— 注入悬浮按钮 + 提取页面图片
 *
 * 职责边界（只做三件事）：
 *   1. 判断当前是否「商品详情页」，决定是否挂载按钮
 *   2. 采集图片候选（DOM 属性 / srcset / 背景图 / 懒加载属性）
 *   3. 把清洗、去重后的列表 sendMessage 给扩展（background）
 *
 * 不做的事：不做 PNG 转换、不碰下载、不渲染图库。
 * 纯函数区（normalize / parseSrcset / isJunk ...）与副作用区（注入按钮、发消息）分开，
 * 方便在 test/harness.html 中单独验证提取逻辑。
 */
(() => {
  'use strict';

  // 防止 SPA 路由切换重复注入脚本时挂两套按钮
  if (window.__SHOP_IMG_PLUGIN__) return;
  window.__SHOP_IMG_PLUGIN__ = true;

  // ---------------------------------------------------------------- 配置

  const CONFIG = {
    minSide: 100,        // 小于该边长的图视为图标/占位图
    scanNodeLimit: 4000, // 背景图扫描的节点上限，防止超长页面卡顿
    // URL 里出现这些片段的直接判为噪音资源
    junkPattern: /(logo|icon|sprite|placeholder|loading|spinner|avatar|qrcode|qr_code|favicon|blank\.(gif|png)|pixel\.(gif|png)|spacer|1x1|transparent\.(gif|png)|watermark_demo)/i,
    imageExt: /\.(jpe?g|png|webp|gif|bmp|avif)$/i,
  };

  // 懒加载属性：各平台历史上用过的名字，全部当候选 src 处理
  const LAZY_SRC_ATTRS = [
    'src',
    'data-src', 'data-lazy-src', 'data-lazyload', 'data-lazy', 'data-lazysrc',
    'data-original', 'data-original-src', 'data-actualsrc', 'data-ks-lazyload',
    'data-echo', 'data-image', 'data-img', 'data-url', 'data-tfs-src',
    'data-goods-img', 'data-large', 'data-large-img', 'data-zoom', 'data-preview',
  ];

  const SRCSET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset'];

  // 商品详情页 URL 特征（命中任一即认为可注入按钮）
  const PRODUCT_PAGE_PATTERNS = [
    /item\.taobao\.com\/item\.htm/i,
    /detail\.tmall\.(com|hk)\/item\.htm/i,
    /chaoshi\.detail\.tmall\.com/i,
    /item\.jd\.(com|hk)\/\d+\.html/i,
    /npcitem\.jd\.hk\//i,
    /item\.m\.jd\.com\/product\/\d+/i,
    /mms\.pinduoduo\.com\/(goods|goods-detail|g\/)/i,
    /mobile\.(yangkeduo|pinduoduo)\.com\/goods\d*\.html/i,
  ];

  // ---------------------------------------------------------------- 纯函数：URL 处理

  /**
   * 补全相对路径、剔除非法协议，并尝试把 CDN 缩略图还原为原图。
   * 淘宝/天猫的图片常见后缀：xxx.jpg_430x430q90.jpg、xxx.jpg_.webp
   */
  function normalizeUrl(raw, base = location.href) {
    if (!raw || typeof raw !== 'string') return null;
    const value = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!value || value.startsWith('data:') || value.startsWith('blob:')) return null;

    let url;
    try {
      url = new URL(value, base);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    url.hash = '';
    const upgraded = url.href
      // img.alicdn.com/xxx.jpg_430x430q90.jpg  →  xxx.jpg
      .replace(/(\.(?:jpe?g|png|webp|gif))_\d+x\d+[a-z0-9]*\.(?:jpe?g|png|webp)$/i, '$1')
      // xxx.jpg_.webp  →  xxx.jpg
      .replace(/\.(jpe?g|png|webp)_\.webp$/i, '.$1')
      // xxx.jpg_sum.jpg → xxx.jpg
      .replace(/\.(jpe?g|png)_sum\.(?:jpe?g|png)$/i, '.$1');

    return upgraded;
  }

  /** 是否为图片资源（有图片扩展名，或来自已知图片 CDN） */
  function looksLikeImage(url) {
    const u = new URL(url);
    if (u.pathname.endsWith('.svg')) return false; // 矢量图标一律排除
    if (CONFIG.imageExt.test(u.pathname)) return true;
    return /(alicdn|360buyimg|pddpic|suning|yimg)\./i.test(u.hostname);
  }

  function isJunk(url) {
    return CONFIG.junkPattern.test(url);
  }

  /** srcset → 取声明尺寸最大的那一张 */
  function parseSrcset(srcset) {
    if (!srcset) return null;
    const candidates = srcset
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [url, ...descriptors] = part.split(/\s+/);
        const score = descriptors.reduce((max, d) => {
          const m = /^(\d+(?:\.\d+)?)([wx])$/.exec(d);
          return m ? Math.max(max, Number(m[1])) : max;
        }, 0);
        return { url, score };
      });
    if (!candidates.length) return null;
    return candidates.sort((a, b) => b.score - a.score)[0].url;
  }

  // ---------------------------------------------------------------- 纯函数：采集

  /** 单个 <img> → 若干原始 URL */
  function urlsFromImg(img) {
    const out = [];
    for (const attr of LAZY_SRC_ATTRS) {
      const v = img.getAttribute(attr);
      if (v) out.push(v);
    }
    for (const attr of SRCSET_ATTRS) {
      const best = parseSrcset(img.getAttribute(attr));
      if (best) out.push(best);
    }
    const currentSrc = img.currentSrc; // 浏览器实际加载的那张（懒加载替换后最有价值）
    if (currentSrc) out.push(currentSrc);
    return out;
  }

  /** <picture><source> 里的 srcset */
  function urlsFromSource(sourceEl) {
    const out = [];
    for (const attr of SRCSET_ATTRS) {
      const best = parseSrcset(sourceEl.getAttribute(attr));
      if (best) out.push(best);
    }
    const src = sourceEl.getAttribute('src');
    if (src) out.push(src);
    return out;
  }

  /** 元素上所有 background-image 的 url() */
  function urlsFromBackground(el) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') return [];
    return [...bg.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((m) => m[2]);
  }

  /**
   * 主提取流程
   * @returns {Array<{url:string, width:number, height:number}>}
   */
  function extractImages() {
    const collected = [];
    const push = (raw, size) => {
      const url = normalizeUrl(raw);
      if (!url) return;
      collected.push({
        url,
        width: size && size.width > 0 ? Math.round(size.width) : 0,
        height: size && size.height > 0 ? Math.round(size.height) : 0,
      });
    };

    // 1) <img>（含懒加载属性）——尺寸优先取自然尺寸，取不到再退回布局尺寸
    for (const img of document.querySelectorAll('img')) {
      const natural = { width: img.naturalWidth, height: img.naturalHeight };
      const rect = img.getBoundingClientRect();
      const size = natural.width > 0
        ? natural
        : { width: rect.width * (window.devicePixelRatio || 1), height: rect.height * (window.devicePixelRatio || 1) };
      for (const raw of urlsFromImg(img)) push(raw, size);
    }

    // 2) <source> / <picture>
    for (const source of document.querySelectorAll('source')) {
      for (const raw of urlsFromSource(source)) push(raw, null);
    }

    // 3) 背景图（商品轮播、店铺装修常用）
    const allNodes = Array.from(document.body ? document.body.querySelectorAll('*') : [])
      .slice(0, CONFIG.scanNodeLimit);
    for (const el of allNodes) {
      const urls = urlsFromBackground(el);
      if (!urls.length) continue;
      const rect = el.getBoundingClientRect();
      for (const raw of urls) push(raw, rect);
    }

    return dedupe(collected).filter((item) => {
      if (isJunk(item.url)) return false;
      if (!looksLikeImage(item.url)) return false;
      // 已知尺寸且过小 → 图标；尺寸未知的交给图库页加载后再判定
      if (item.width > 0 && Math.min(item.width, item.height) < CONFIG.minSide) return false;
      return true;
    });
  }

  /** 按 URL 去重，保留信息更全（尺寸更大）的那条 */
  function dedupe(list) {
    const map = new Map();
    for (const item of list) {
      const prev = map.get(item.url);
      if (!prev) {
        map.set(item.url, item);
      } else if (item.width * item.height > prev.width * prev.height) {
        map.set(item.url, item);
      }
    }
    return [...map.values()];
  }

  // ---------------------------------------------------------------- 页面判定

  function isProductPage() {
    const href = location.href;
    if (PRODUCT_PAGE_PATTERNS.some((re) => re.test(href))) return true;
    // 兜底：URL 带商品语义 + 页面有商品主图 meta，说明大概率是详情页
    const looksLikeDetail = /(item|goods|product|detail)/i.test(location.pathname + location.search);
    const hasOgImage = Boolean(document.querySelector('meta[property="og:image"]'));
    return looksLikeDetail && hasOgImage;
  }

  // ---------------------------------------------------------------- 测试出口（非扩展环境只暴露 API）

  const api = { extractImages, normalizeUrl, parseSrcset, isProductPage, dedupe, CONFIG };
  window.__SHOP_IMG_PLUGIN_API__ = api;

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  // ---------------------------------------------------------------- UI

  const UI_ID = 'shop-img-plugin-btn';

  function createButton() {
    const btn = document.createElement('button');
    btn.id = UI_ID;
    btn.type = 'button';
    btn.innerHTML = '<span class="sip-icon">🖼</span><span class="sip-label">获取图片</span>';
    btn.addEventListener('click', onClick, true);
    return btn;
  }

  function setButtonState(btn, state, text) {
    btn.dataset.state = state;
    btn.querySelector('.sip-label').textContent = text;
  }

  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const btn = document.getElementById(UI_ID);
    if (!btn || btn.dataset.state === 'busy') return;

    setButtonState(btn, 'busy', '提取中…');
    try {
      const images = extractImages();
      if (!images.length) {
        setButtonState(btn, 'error', '没找到图片');
        setTimeout(() => setButtonState(btn, 'idle', '获取图片'), 2000);
        return;
      }

      await chrome.runtime.sendMessage({
        type: 'CAPTURE_IMAGES',
        payload: { images, pageTitle: document.title, pageUrl: location.href },
      });

      setButtonState(btn, 'done', `已提取 ${images.length} 张`);
      setTimeout(() => setButtonState(btn, 'idle', '获取图片'), 2200);
    } catch (err) {
      console.warn('[shop-img-plugin] 提取失败', err);
      setButtonState(btn, 'error', '提取失败');
      setTimeout(() => setButtonState(btn, 'idle', '获取图片'), 2000);
    }
  }

  /** 挂载按钮；被页面脚本移除时（部分平台会清空浮动层）自动补挂 */
  function mountButton() {
    if (!isProductPage()) return;
    if (!document.body) return;
    if (document.getElementById(UI_ID)) return;
    const btn = createButton();
    setButtonState(btn, 'idle', '获取图片');
    document.body.appendChild(btn);
  }

  mountButton();

  // 电商站多是 SPA：URL 变化（不刷新）时重新判定并挂载
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      mountButton();
    } else if (!document.getElementById(UI_ID)) {
      mountButton();
    }
  }, 1500);
})();
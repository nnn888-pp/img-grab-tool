// ========= 导航移动端菜单 =========
const toggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');
if (toggle && navLinks) {
  toggle.addEventListener('click', () => {
    navLinks.style.display = navLinks.style.display === 'flex' ? 'none' : 'flex';
    navLinks.style.flexDirection = 'column';
    navLinks.style.position = 'absolute';
    navLinks.style.top = '100%';
    navLinks.style.left = '0';
    navLinks.style.right = '0';
    navLinks.style.background = '#fff';
    navLinks.style.padding = '16px 24px';
    navLinks.style.borderBottom = '1px solid #eef1ff';
  });
}

// ========= 滚动淡入动画 =========
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.style.opacity = '1';
      e.target.style.transform = 'translateY(0)';
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.feature-card, .timeline li, .cta-box').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.style.transition = 'opacity .6s, transform .6s';
  io.observe(el);
});

// ========= 下载按钮反馈 =========
document.querySelectorAll('a[download]').forEach(a => {
  a.addEventListener('click', (e) => {
    setTimeout(() => {
      a.textContent = '✅ 下载中...';
      setTimeout(() => { a.textContent = a.dataset.original || a.textContent; }, 2000);
    }, 50);
  });
  if (!a.dataset.original) a.dataset.original = a.textContent;
});

// ========= 平滑滚动兼容 =========
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (id.length > 1) {
      const target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });
});

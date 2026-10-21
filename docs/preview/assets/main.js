/* ==========================================================================
   bundle-guardian · 预览页交互
   ── 自研 squarified treemap（不依赖任何图表库）
   ── 入场编排 / 数字滚动 / Tab 切换 / 一键复制
   ========================================================================== */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------
     1. 入场编排：错峰 reveal
     ------------------------------------------------------------------ */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  if ('IntersectionObserver' in window && !reduce) {
    // 给同一父容器下的兄弟元素排一个 70ms 的错峰
    var counters = new Map();
    revealEls.forEach(function (el) {
      var p = el.parentElement;
      var i = counters.get(p) || 0;
      counters.set(p, i + 1);
      el.style.transitionDelay = Math.min(i, 5) * 70 + 'ms';
    });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -8% 0px' });

    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ------------------------------------------------------------------
     2. 压缩漏斗条 + KPI 数字滚动
     ------------------------------------------------------------------ */
  function runOnce(fn) {
    if ('IntersectionObserver' in window) {
      var o = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { fn(e.target); o.unobserve(e.target); } });
      }, { threshold: 0.35 });
      return o;
    }
    return null;
  }

  // 漏斗条
  var wf = document.getElementById('wf');
  if (wf) {
    var wfObs = runOnce(function (el) {
      el.querySelectorAll('.wf-fill').forEach(function (f, i) {
        setTimeout(function () { f.style.width = f.dataset.pct + '%'; }, reduce ? 0 : 120 * i);
      });
    });
    if (wfObs) wfObs.observe(wf); else wf.querySelectorAll('.wf-fill').forEach(function (f) { f.style.width = f.dataset.pct + '%'; });
  }

  // KPI 数字
  var nums = document.querySelectorAll('[data-count]');
  var numObs = runOnce(function (el) {
    var target = parseFloat(el.dataset.count);
    var suffix = el.dataset.suffix || '';
    if (reduce) { el.textContent = target + suffix; return; }
    var dur = 1500, t0 = performance.now();
    (function step(now) {
      var p = Math.min((now - t0) / dur, 1);
      var e = 1 - Math.pow(1 - p, 4); // easeOutQuart
      var v = target * e;
      var txt = (target % 1 !== 0) ? v.toFixed(1) : Math.round(v).toString();
      el.textContent = txt + suffix;
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  });
  if (numObs) { nums.forEach(function (n) { numObs.observe(n); }); }
  else { nums.forEach(function (n) { n.textContent = n.dataset.count + (n.dataset.suffix || ''); }); }

  /* ------------------------------------------------------------------
     3. 效果图 Tab 切换
     ------------------------------------------------------------------ */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.pv-tab'));
  var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });

  function activate(idx, focus) {
    tabs.forEach(function (t, i) {
      t.setAttribute('aria-selected', i === idx ? 'true' : 'false');
      t.tabIndex = i === idx ? 0 : -1;
    });
    panels.forEach(function (p, i) {
      if (!p) return;
      if (i === idx) {
        p.hidden = false;
        p.classList.add('is-in');
        if (i === 1) renderTreemap();   // treemap 需要容器有实际尺寸
      } else {
        p.hidden = true;
      }
    });
    if (focus) tabs[idx].focus();
  }

  tabs.forEach(function (t, i) {
    t.tabIndex = i === 0 ? 0 : -1;
    t.addEventListener('click', function () { activate(i, false); });
    t.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      activate((i + d + tabs.length) % tabs.length, true);
    });
  });

  /* ------------------------------------------------------------------
     4. ★ 自研 squarified treemap
     ------------------------------------------------------------------ */
  var TM_DATA = [
    { name: 'echarts',        value: 268.0, color: '#FF4A17' },
    { name: 'element-plus',   value: 187.4, color: '#FF4A17' },
    { name: 'src/** (业务)',   value: 142.8, color: '#131612' },
    { name: 'vue + pinia + router', value: 118.6, color: '#FF4A17' },
    { name: 'moment + locale',value: 104.4, color: '#C4241A' },
    { name: 'xlsx',           value: 96.2,  color: '#C4241A' },
    { name: 'lodash',         value: 71.2,  color: '#C4241A' },
    { name: 'echarts-gl',     value: 56.4,  color: '#FF4A17' },
    { name: 'vxe-table',      value: 48.6,  color: '#FF4A17' },
    { name: 'highlight.js',   value: 42.8,  color: '#C4241A' },
    { name: '@vueuse/core',   value: 22.6,  color: '#2E45B8' },
    { name: 'sortablejs',     value: 18.2,  color: '#2E45B8' },
    { name: 'axios',          value: 14.2,  color: '#2E45B8' },
    { name: '<runtime>',      value: 12.4,  color: '#868C80' },
    { name: 'qs',             value: 8.4,   color: '#C4241A' },
    { name: 'nprogress',      value: 2.1,   color: '#2E45B8' }
  ];

  /** 计算一行中最差的长宽比 */
  function worstRatio(vals, sum, thickness, shortSide) {
    var max = 0;
    for (var i = 0; i < vals.length; i++) {
      var len = shortSide * (vals[i] / sum);
      if (len <= 0) continue;
      var r = Math.max(thickness / len, len / thickness);
      if (r > max) max = r;
    }
    return max;
  }

  /** squarified treemap 布局：返回矩形数组 */
  function squarify(items, rect) {
    var out = [];
    var total = items.reduce(function (s, d) { return s + d.value; }, 0);
    if (total <= 0 || rect.w <= 1 || rect.h <= 1) return out;

    var x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    var idx = 0, sum = total, guard = 0;

    while (idx < items.length && guard++ < 500) {
      var shortSide = Math.min(w, h);
      if (shortSide <= 1) break;

      var row = [], rowSum = 0, best = Infinity, j = idx;
      while (j < items.length) {
        var candSum = rowSum + items[j].value;
        var cand = row.concat(items[j].value);
        var thickness = (candSum * (w * h) / sum) / shortSide;
        var wr = worstRatio(cand, candSum, thickness, shortSide);
        if (row.length > 0 && wr > best) break;
        best = wr; row = cand; rowSum = candSum;
        j++;
      }

      var tk = (rowSum * (w * h) / sum) / shortSide;
      var pos = 0;
      for (var k = idx; k < idx + row.length; k++) {
        var frac = items[k].value / rowSum;
        var len = shortSide * frac;
        if (w >= h) out.push({ d: items[k], x: x, y: y + pos, w: tk, h: len });
        else        out.push({ d: items[k], x: x + pos, y: y, w: len, h: tk });
        pos += len;
      }
      if (w >= h) { x += tk; w -= tk; } else { y += tk; h -= tk; }
      idx += row.length;
      sum -= rowSum;
      if (tk <= 0.01) break;
    }
    return out;
  }

  var tmRendered = false;
  var tmEl = document.getElementById('treemap');

  function renderTreemap() {
    if (!tmEl) return;
    var W = tmEl.clientWidth, H = tmEl.clientHeight;
    if (W < 10 || H < 10) return;

    var items = TM_DATA.slice().sort(function (a, b) { return b.value - a.value; });
    var rects = squarify(items, { x: 0, y: 0, w: W, h: H });

    tmEl.innerHTML = '';
    var frag = document.createDocumentFragment();
    rects.forEach(function (r) {
      var box = document.createElement('div');
      box.className = 'tm-tile';
      if (r.w < 46 || r.h < 26) box.className += ' tm-tile--tiny';
      box.style.left = r.x.toFixed(1) + 'px';
      box.style.top = r.y.toFixed(1) + 'px';
      box.style.width = (r.w - 2).toFixed(1) + 'px';
      box.style.height = (r.h - 2).toFixed(1) + 'px';
      box.style.background = r.d.color;
      box.title = r.d.name + ' · gzip ' + r.d.value.toFixed(1) + ' KB';

      var nm = document.createElement('span');
      nm.className = 'tm-tile__n';
      nm.textContent = r.d.name;
      var vl = document.createElement('span');
      vl.className = 'tm-tile__v';
      vl.textContent = r.d.value.toFixed(1) + ' KB';
      box.appendChild(nm); box.appendChild(vl);
      frag.appendChild(box);
    });
    tmEl.appendChild(frag);
    tmRendered = true;
  }

  if (tmEl) {
    // 初始若已在可视区域（非 hidden）则先渲一次
    if (tmEl.clientWidth > 10) renderTreemap();
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(renderTreemap, 180);
    });
  }

  /* ------------------------------------------------------------------
     5. 顶栏导航平滑滚动补偿（sticky header 遮挡）
     ------------------------------------------------------------------ */
  var links = document.querySelectorAll('a[href^="#"]');
  links.forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href');
      if (id === '#' || id.length < 2) return;
      var t = document.querySelector(id);
      if (!t) return;
      e.preventDefault();
      var top = t.getBoundingClientRect().top + window.pageYOffset - 74;
      window.scrollTo({ top: top, behavior: reduce ? 'auto' : 'smooth' });
      if (id === '#preview' && tmEl) setTimeout(renderTreemap, 500);
    });
  });

  // 深链直达 #preview 时补渲 treemap
  window.addEventListener('hashchange', function () {
    if (location.hash === '#preview' && tmEl && panels[1] && !panels[1].hidden) renderTreemap();
  });

})();

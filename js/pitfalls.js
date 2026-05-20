import { PITFALLS, COST_LABELS, CATEGORIES, TOPICS } from './data.js';
import { getUser, updateStats, refreshStatUI, showToast, recordBrowse } from './app.js';
import { downloadActionCard } from './action-card.js';
import { openMediaModal, initMediaModal } from './media-modal.js';

const grid = document.getElementById('pitfall-grid');
const categoryBar = document.getElementById('category-filters');
const countEl = document.getElementById('pitfall-count');
const searchInput = document.getElementById('pitfall-search');
let costFilter = 'all';
let categoryFilter = 'all';
let searchQuery = '';

if (countEl) countEl.textContent = String(PITFALLS.length);

const readSet = new Set(JSON.parse(localStorage.getItem('qtvq_read') || '[]'));
const quizPass = new Set(JSON.parse(localStorage.getItem('qtvq_quiz_pass') || '[]'));

function initCategoryFilters() {
  if (!categoryBar) return;
  CATEGORIES.forEach((cat) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-btn';
    btn.dataset.category = cat;
    btn.textContent = cat;
    categoryBar.appendChild(btn);
  });
  categoryBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    categoryBar.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    categoryFilter = btn.dataset.category ?? 'all';
    render();
  });
}

function mediaBlock(p) {
  const parts = [];
  if (p.hasAudio) {
    parts.push(
      '<button type="button" class="media-btn btn-audio" title="音频讲述（演示）">🎧 音频讲述</button>'
    );
  }
  if (p.hasVideo) {
    parts.push(
      '<button type="button" class="media-btn btn-video" title="短视频还原（演示）">▶ 短视频还原</button>'
    );
  }
  return parts.length ? `<div class="media-row">${parts.join('')}</div>` : '';
}

function quizBlock(p) {
  if (!p.quiz || quizPass.has(p.id)) {
    return quizPass.has(p.id)
      ? '<p class="quiz-done">✓ 已通过避坑测验 · +10 直线值</p>'
      : '';
  }
  const opts = p.quiz.options
    .map(
      (o, i) =>
        `<button type="button" class="quiz-opt" data-idx="${i}">${i + 1}. ${o}</button>`
    )
    .join('');
  return `<div class="quiz-box" data-id="${p.id}">
    <strong>避坑测验</strong>
    <p>${p.quiz.q}</p>
    <div class="quiz-opts">${opts}</div>
  </div>`;
}

function renderCard(p) {
  const card = document.createElement('article');
  card.className = 'pitfall-card';
  card.dataset.cost = COST_LABELS[p.cost] || 'emotion';
  card.dataset.category = p.category;
  card.dataset.pitfallId = String(p.id);
  card.innerHTML = `
    <span class="category">${p.category}</span>
    <h3>${p.title}</h3>
    <p class="lesson">${p.lesson}</p>
    ${mediaBlock(p)}
    <div class="steps"><strong>直线方案</strong><br>${p.steps.replace(/\n/g, '<br>')}</div>
    ${quizBlock(p)}
    <div class="pitfall-meta">
      <span>已帮 <strong>${p.helped.toLocaleString()}</strong> 人避开</span>
      <span class="cost-tag">${p.cost}代价</span>
    </div>
    <div class="card-actions">
      <button type="button" class="btn btn-secondary btn-save-card">保存行动卡图片</button>
      <button type="button" class="btn btn-secondary btn-send-self">发给自己</button>
    </div>
  `;

  card.querySelector('.btn-save-card')?.addEventListener('click', () => {
    markRead(p.id, p.category);
    downloadActionCard(p);
    showToast('行动卡图片已下载');
  });

  card.querySelector('.btn-send-self')?.addEventListener('click', () => {
    markRead(p.id, p.category);
    const text = `【${p.title}】\n${p.steps}\n—— 我心永恒-Q问 qtvq.cn`;
    navigator.clipboard?.writeText(text).then(() => showToast('已复制，可粘贴发给自己'));
  });

  card.querySelector('.btn-audio')?.addEventListener('click', () => {
    markRead(p.id, p.category);
    openMediaModal(p, 'audio');
  });
  card.querySelector('.btn-video')?.addEventListener('click', () => {
    markRead(p.id, p.category);
    openMediaModal(p, 'video');
  });

  card.querySelectorAll('.quiz-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      if (idx === p.quiz.a) {
        quizPass.add(p.id);
        localStorage.setItem('qtvq_quiz_pass', JSON.stringify([...quizPass]));
        updateStats(0, 5, 10);
        showToast('测验通过！+10 直线值');
        render();
      } else {
        showToast('再想想，查看直线方案后重试');
      }
    });
  });

  return card;
}

function markRead(id, category) {
  if (!readSet.has(id)) {
    readSet.add(id);
    localStorage.setItem('qtvq_read', JSON.stringify([...readSet]));
    updateStats(0, 5, 0);
    showToast('+5 智慧值');
  }
  recordBrowse(category);
}

function render() {
  grid.innerHTML = '';
  let list = PITFALLS;
  if (costFilter !== 'all') {
    list = list.filter((p) => (COST_LABELS[p.cost] || '') === costFilter);
  }
  if (categoryFilter !== 'all') {
    list = list.filter((p) => p.category === categoryFilter);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.category.includes(q) ||
        p.lesson.toLowerCase().includes(q)
    );
  }
  if (list.length === 0) {
    grid.innerHTML = '<p class="empty-hint">未找到相关案例，试试其他关键词</p>';
    return;
  }
  list.forEach((p) => grid.appendChild(renderCard(p)));
}

searchInput?.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  render();
});

document.getElementById('filters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn || !btn.dataset.filter) return;
  document.getElementById('filters').querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  costFilter = btn.dataset.filter;
  render();
});

document.getElementById('btn-submit-lesson')?.addEventListener('click', () => {
  document.getElementById('submit-modal')?.classList.add('open');
});

document.getElementById('submit-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const title = fd.get('title')?.toString().trim();
  if (!title) return;
  const pending = JSON.parse(localStorage.getItem('qtvq_pending_lessons') || '[]');
  pending.push({ title, story: fd.get('story'), at: Date.now() });
  localStorage.setItem('qtvq_pending_lessons', JSON.stringify(pending));
  e.target.reset();
  document.getElementById('submit-modal')?.classList.remove('open');
  updateStats(0, 0, 5);
  showToast('已提交，审核通过后将奖励 Q智慧值/VIP（演示）');
});

document.querySelectorAll('[data-close-modal]').forEach((el) => {
  el.addEventListener('click', () => {
    document.getElementById('submit-modal')?.classList.remove('open');
  });
});

function initTopics() {
  const wrap = document.getElementById('topics-section');
  if (!wrap) return;
  const user = getUser();
  const total = user.qCoins + user.wisdom;
  const unlocked = total >= 50;

  wrap.innerHTML = `
    <h2 class="section-title">高阶避坑专题 ${unlocked ? '' : '（50 分解锁）'}</h2>
    <div class="topic-grid" id="topic-grid"></div>`;

  const topicGrid = document.getElementById('topic-grid');
  TOPICS.forEach((t) => {
    const card = document.createElement('article');
    card.className = `topic-card ${unlocked ? '' : 'locked'}`;
    const count = t.pitIds.length;
    card.innerHTML = `
      <h4>${t.name}</h4>
      <p>${t.desc}</p>
      <span class="topic-meta">${count} 条精选案例</span>
      <button type="button" class="btn btn-secondary btn-topic" ${unlocked ? '' : 'disabled'}>
        ${unlocked ? '进入专题' : '未解锁'}
      </button>`;
    card.querySelector('.btn-topic')?.addEventListener('click', () => {
      showTopicPitfalls(t);
    });
    topicGrid.appendChild(card);
  });
}

function showTopicPitfalls(topic) {
  if (!grid) return;
  const list = PITFALLS.filter((p) => topic.pitIds.includes(p.id));
  grid.innerHTML = '';
  list.forEach((p) => grid.appendChild(renderCard(p)));
  grid.scrollIntoView({ behavior: 'smooth' });
  const first = grid.querySelector(`[data-pitfall-id="${topic.pitIds[0]}"]`);
  if (first) setTimeout(() => first.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
  showToast(`「${topic.name}」共 ${list.length} 条精选案例`);
}

initCategoryFilters();
initTopics();
initMediaModal();
render();
refreshStatUI();

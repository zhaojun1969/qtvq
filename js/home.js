import { HOT_TOPICS, SUCCESS_STORIES } from './data.js';
import {
  askAI,
  updateStats,
  refreshStatUI,
  showToast,
  recordQuestion,
  usePioneerAsk,
  getUser,
  saveUser,
  adoptSuggestion,
  checkNewAskAllowed,
  commitNewQuestionAsk,
  applyServerQuota,
  syncQuotaFromServer,
} from './app.js';
import { canAskNewQuestion } from './quota.js';
import { openSubscribeModal, initSubscribeModal } from './subscribe.js';
import { showLoading, hideLoading } from './loading.js';

let lastQuestion = '';

function initHotTopics() {
  const list = document.getElementById('hot-topics');
  if (!list) return;
  HOT_TOPICS.forEach((item) => {
    const li = document.createElement('li');
    li.innerHTML = `${item.text}<span class="hot-meta">${item.count} 人问过</span>`;
    li.addEventListener('click', () => {
      document.getElementById('question-input').value = item.text;
      document.getElementById('question-input').focus();
    });
    list.appendChild(li);
  });
}

function initStories() {
  const grid = document.getElementById('success-stories');
  if (!grid) return;
  SUCCESS_STORIES.forEach((s) => {
    const card = document.createElement('article');
    card.className = 'story-card';
    card.innerHTML = `<span class="tag">${s.tag}</span><p>${s.text}</p>`;
    grid.appendChild(card);
  });
}

function initVoiceInput() {
  const btn = document.getElementById('btn-voice');
  const input = document.getElementById('question-input');
  if (!btn || !input) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.disabled = true;
    btn.title = '当前浏览器不支持语音输入';
    return;
  }

  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.interimResults = false;

  btn.addEventListener('click', () => {
    try {
      rec.start();
      showToast('请开始说话…');
    } catch {
      showToast('无法启动语音识别');
    }
  });

  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    input.value = (input.value ? input.value + ' ' : '') + text;
  };

  rec.onerror = () => showToast('语音识别失败，请改用文字');
}

function appendMessage(text, type, withAdopt = false) {
  const container = document.getElementById('chat-messages');
  const welcome = container.querySelector('.msg-welcome');
  if (welcome) welcome.remove();

  const msg = document.createElement('div');
  msg.className = `msg msg-${type}`;
  if (type === 'ai' && withAdopt) {
    const pre = document.createElement('pre');
    pre.className = 'msg-pre';
    pre.textContent = text;
    msg.appendChild(pre);
    const row = document.createElement('div');
    row.className = 'msg-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-adopt';
    btn.textContent = '✓ 采纳此建议 (+智慧值)';
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      btn.disabled = true;
      adoptSuggestion();
      showToast('已采纳，+3 智慧值 +5 直线值');
      refreshStatUI();
    });
    row.appendChild(btn);
    msg.appendChild(row);
  } else {
    msg.textContent = text;
  }
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function showTyping() {
  const container = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = 'msg msg-ai typing-wrap';
  el.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

async function handleAsk(followUp = false) {
  const input = document.getElementById('question-input');
  const btnAsk = document.getElementById('btn-ask');
  const btnFollow = document.getElementById('btn-followup');
  const text = input.value.trim();

  if (!text && !followUp) {
    showToast('请先输入您的问题');
    return;
  }
  if (followUp && !lastQuestion) return;

  if (!followUp) {
    const gate = canAskNewQuestion(getUser());
    if (!gate.ok) {
      showToast('24 小时内免费提问已达 5 次，请办理会员');
      openSubscribeModal();
      return;
    }
  }

  const question = followUp ? lastQuestion : text;
  if (!followUp) {
    const allowed = checkNewAskAllowed();
    if (!allowed.allowed) {
      openSubscribeModal();
      return;
    }
    lastQuestion = text;
    recordQuestion(text);
    appendMessage(text, 'user');
    input.value = '';
    usePioneerAsk();
    refreshStatUI();
  }

  btnAsk.disabled = true;
  btnFollow.disabled = true;
  showLoading(followUp ? '生成具体措辞…' : 'Q智慧思考中…');
  const typing = showTyping();

  try {
    const data = await askAI(question, followUp);
    typing.remove();
    hideLoading();
    appendMessage(data.reply, 'ai', true);
    if (!followUp) {
      if (data.quota) applyServerQuota(data.quota);
      else commitNewQuestionAsk();
    }
    updateStats(data.qCoins || 10, data.wisdom || 1, 0);
    refreshStatUI();
    btnFollow.disabled = false;
    if (data.fallback) {
      showToast('本地演示模式（部署 Cloudflare 后启用 AI）');
    }
  } catch (err) {
    typing.remove();
    hideLoading();
    if (err.code === 'QUOTA_EXCEEDED') {
      showToast(err.message || '提问已达上限');
      openSubscribeModal();
      return;
    }
    appendMessage('暂时无法获取回答，请稍后再试。', 'ai');
  } finally {
    hideLoading();
    btnAsk.disabled = false;
  }
}

const params = new URLSearchParams(location.search);
if (params.get('subscribe') === '1') {
  setTimeout(() => openSubscribeModal(), 300);
}
const prefill = params.get('q');
if (prefill) {
  document.getElementById('question-input').value = decodeURIComponent(prefill);
}

if (params.get('ref') === 'pioneer') {
  const user = getUser();
  if (!user.invited) {
    user.pioneerAsksLeft = (user.pioneerAsksLeft || 0) + 5;
    user.invited = true;
    saveUser(user);
    showToast('欢迎 Q问先锋！已增加 5 次高级问答');
    refreshStatUI();
  }
}

document.getElementById('btn-ask')?.addEventListener('click', () => handleAsk(false));
document.getElementById('btn-followup')?.addEventListener('click', () => handleAsk(true));

document.getElementById('question-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleAsk(false);
  }
});

initHotTopics();
initStories();
initVoiceInput();
initSubscribeModal();
syncQuotaFromServer();
refreshStatUI();

document.getElementById('btn-open-subscribe')?.addEventListener('click', openSubscribeModal);

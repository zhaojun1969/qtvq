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
import { createVoiceRecorder, transcribeBlob, probeSpeechApi } from './voice-asr.js';

let lastQuestion = '';

function initHotTopics() {
  const list = document.getElementById('hot-topics');
  if (!list) return;
  HOT_TOPICS.forEach((item) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="hot-text">${item.text}</span><span class="hot-meta">${item.count} 人问过</span>`;
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
  const input = document.getElementById('question-input');

  SUCCESS_STORIES.forEach((s) => {
    const card = document.createElement('article');
    card.className = 'story-card story-card-clickable';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute(
      'aria-label',
      s.prompt ? `查看案例并提问：${s.prompt}` : `查看案例：${s.tag}`
    );
    card.innerHTML = `<span class="tag">${s.tag}</span><p>${s.text}</p><span class="story-card-hint">点击填入相关问题 →</span>`;

    const activate = () => {
      if (s.prompt && input) {
        input.value = s.prompt;
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showToast('已填入相关问题，点「获取直线方案」即可');
      } else {
        showToast('请在上方输入框描述您的问题');
      }
    };

    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });

    grid.appendChild(card);
  });
}

function initFeatureCards() {
  document.querySelectorAll('.feature-card-link[href="#question-input"]').forEach((card) => {
    card.addEventListener('click', (e) => {
      e.preventDefault();
      const input = document.getElementById('question-input');
      if (!input) return;
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showToast('请描述您的情感困境，点「获取直线方案」');
    });
  });
}

function initVoiceInput() {
  const btn = document.getElementById('btn-voice');
  const input = document.getElementById('question-input');
  if (!btn || !input) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceRec = createVoiceRecorder();
  let useServerAsr = false;
  let webRec = null;
  let webListening = false;

  probeSpeechApi().then((ok) => {
    useServerAsr = ok;
    if (ok) btn.title = '语音输入（阿里云识别，点击开始/停止）';
    else if (!SR) {
      btn.disabled = true;
      btn.title = '当前浏览器不支持语音输入';
    } else btn.title = '语音输入（浏览器识别，国内可能不可用）';
  });

  const ERROR_MSG = {
    'no-speech': '未检测到语音，请重试或改用手打',
    'audio-capture': '无法访问麦克风，请检查权限',
    'not-allowed': '麦克风未授权，请在地址栏允许后重试',
    network: '浏览器语音网络不可用，请改用手打或配置阿里云 ASR',
    SPEECH_NOT_CONFIGURED: '服务端语音识别未配置',
    no_speech: '未识别到有效语音，请说清楚一些',
  };

  function setActive(active) {
    btn.classList.toggle('voice-active', active);
    btn.textContent = active ? '⏹ 停止' : '🎤 语音';
  }

  async function runServerAsr() {
    setActive(true);
    showToast('正在录音，说完再点停止…');
    try {
      await voiceRec.start();
    } catch (err) {
      setActive(false);
      showToast('无法访问麦克风，请检查权限');
      console.warn('[voice]', err);
      return;
    }

    btn.onclick = async () => {
      if (!voiceRec.isRecording()) return;
      setActive(false);
      showLoading('语音识别中…');
      try {
        const blob = await voiceRec.stop();
        const text = await transcribeBlob(blob);
        if (text) {
          input.value = input.value ? `${input.value} ${text}` : text;
          showToast('已填入语音识别结果');
        }
      } catch (err) {
        const msg = ERROR_MSG[err.code] || err.message || '语音识别失败，请改用手打';
        showToast(msg);
        console.warn('[voice asr]', err);
      } finally {
        hideLoading();
        bindMainClick();
      }
    };
  }

  function bindWebSpeech() {
    if (!SR) return;
    webRec = new SR();
    webRec.lang = 'zh-CN';
    webRec.interimResults = false;
    webRec.continuous = false;

    webRec.onstart = () => {
      webListening = true;
      setActive(true);
      showToast('请开始说话…');
    };
    webRec.onresult = (e) => {
      const text = e.results?.[0]?.[0]?.transcript?.trim();
      if (text) {
        input.value = input.value ? `${input.value} ${text}` : text;
        showToast('已填入语音识别结果');
      }
    };
    webRec.onerror = (e) => {
      const code = e.error || 'unknown';
      console.warn('[voice web]', code);
      const msg = ERROR_MSG[code];
      if (msg) showToast(msg);
      else if (code !== 'aborted') showToast(`语音识别失败（${code}），请改用手打`);
    };
    webRec.onend = () => {
      webListening = false;
      setActive(false);
      bindMainClick();
    };
  }

  function bindMainClick() {
    btn.onclick = async () => {
      if (useServerAsr) {
        await runServerAsr();
        return;
      }
      if (!SR) {
        showToast('当前浏览器不支持语音输入');
        return;
      }
      if (webListening && webRec) {
        webRec.stop();
        return;
      }
      bindWebSpeech();
      try {
        webRec.start();
      } catch (err) {
        setActive(false);
        showToast('无法启动语音识别，请改用手打');
        console.warn('[voice web start]', err);
      }
    };
  }

  bindMainClick();
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
initFeatureCards();
initVoiceInput();
initSubscribeModal();
syncQuotaFromServer();
refreshStatUI();

document.getElementById('btn-open-subscribe')?.addEventListener('click', openSubscribeModal);

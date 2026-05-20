/** 音视频演示弹层（音频用浏览器朗读，视频为情景还原文案） */
let speaking = null;

export function openMediaModal(pitfall, type) {
  const modal = document.getElementById('media-modal');
  if (!modal) return;

  const title = document.getElementById('media-modal-title');
  const body = document.getElementById('media-modal-body');
  const player = document.getElementById('media-modal-player');

  stopSpeech();

  if (type === 'audio') {
    title.textContent = `🎧 音频讲述 · ${pitfall.title}`;
    body.textContent = pitfall.lesson;
    player.innerHTML =
      '<p class="media-hint">演示：使用浏览器语音朗读真实教训（正式版接入录制音频）</p>' +
      '<button type="button" class="btn btn-primary" id="media-play-audio">播放讲述</button>' +
      '<button type="button" class="btn btn-secondary" id="media-stop-audio">停止</button>';
    modal.classList.add('open');
    document.getElementById('media-play-audio')?.addEventListener('click', () => playLesson(pitfall));
    document.getElementById('media-stop-audio')?.addEventListener('click', stopSpeech);
  } else {
    title.textContent = `▶ 短视频还原 · ${pitfall.title}`;
    body.textContent = '';
    player.innerHTML = `
      <div class="video-placeholder">
        <div class="video-frame">情景还原（演示）</div>
        <p>${pitfall.lesson}</p>
        <p class="media-hint">正式版将接入短视频播放 · 阿里云/腾讯云 CDN</p>
      </div>`;
    modal.classList.add('open');
  }
}

function playLesson(pitfall) {
  stopSpeech();
  if (!window.speechSynthesis) {
    return;
  }
  const u = new SpeechSynthesisUtterance(
    `${pitfall.title}。${pitfall.lesson}。直线方案：${pitfall.steps.replace(/\n/g, '，')}`
  );
  u.lang = 'zh-CN';
  u.rate = 0.95;
  speaking = u;
  speechSynthesis.speak(u);
}

export function stopSpeech() {
  if (window.speechSynthesis) {
    speechSynthesis.cancel();
  }
  speaking = null;
}

export function closeMediaModal() {
  stopSpeech();
  document.getElementById('media-modal')?.classList.remove('open');
}

export function initMediaModal() {
  document.querySelectorAll('[data-close-media]').forEach((el) => {
    el.addEventListener('click', closeMediaModal);
  });
}

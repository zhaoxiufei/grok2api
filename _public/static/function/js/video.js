(() => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const clearBtn = document.getElementById('clearBtn');
  const promptInput = document.getElementById('promptInput');
  const imageUrlInput = document.getElementById('imageUrlInput');
  const imageFileInput = document.getElementById('imageFileInput');
  const imageFileName = document.getElementById('imageFileName');
  const clearImageFileBtn = document.getElementById('clearImageFileBtn');
  const selectImageFileBtn = document.getElementById('selectImageFileBtn');
  const ratioSelect = document.getElementById('ratioSelect');
  const lengthSelect = document.getElementById('lengthSelect');
  const resolutionSelect = document.getElementById('resolutionSelect');
  const presetSelect = document.getElementById('presetSelect');
  const statusText = document.getElementById('statusText');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const durationValue = document.getElementById('durationValue');
  const aspectValue = document.getElementById('aspectValue');
  const lengthValue = document.getElementById('lengthValue');
  const resolutionValue = document.getElementById('resolutionValue');
  const presetValue = document.getElementById('presetValue');
  const videoEmpty = document.getElementById('videoEmpty');
  const videoWaterfall = document.getElementById('videoWaterfall');
  const batchDownloadBtn = document.getElementById('batchDownloadBtn');
  const selectionToolbar = document.getElementById('selectionToolbar');
  const toggleSelectAllBtn = document.getElementById('toggleSelectAllBtn');
  const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
  const selectedCountBadge = document.getElementById('selectedCountBadge');
  const videoLightbox = document.getElementById('videoLightbox');
  const videoLightboxPlayer = document.getElementById('videoLightboxPlayer');
  const closeVideoLightbox = document.getElementById('closeVideoLightbox');
  const videoLightboxPrev = document.getElementById('videoLightboxPrev');
  const videoLightboxNext = document.getElementById('videoLightboxNext');
  const floatingActions = document.getElementById('floatingActions');

  let currentSource = null;
  let currentTaskId = '';
  let isRunning = false;
  let progressBuffer = '';
  let contentBuffer = '';
  let collectingContent = false;
  let startAt = 0;
  let fileDataUrl = '';
  let elapsedTimer = null;
  let lastProgress = 0;
  let currentWaterfallItem = null;
  let videoSequence = 0;
  let isSelectionMode = false;
  let selectedVideos = new Set();
  let currentLightboxIndex = -1;
  const DEFAULT_REASONING_EFFORT = 'low';

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
    }
  }

  function setStatus(state, text) {
    if (!statusText) return;
    statusText.textContent = text;
    statusText.classList.remove('connected', 'connecting', 'error');
    if (state) {
      statusText.classList.add(state);
    }
  }

  function setButtons(running) {
    if (!startBtn || !stopBtn) return;
    if (running) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      startBtn.disabled = false;
    }
  }

  function updateProgress(value) {
    const safe = Math.max(0, Math.min(100, Number(value) || 0));
    lastProgress = safe;
    if (progressFill) {
      progressFill.style.width = `${safe}%`;
    }
    if (progressText) {
      progressText.textContent = `${safe}%`;
    }
  }

  function updateMeta() {
    if (aspectValue && ratioSelect) {
      aspectValue.textContent = ratioSelect.value;
    }
    if (lengthValue && lengthSelect) {
      lengthValue.textContent = `${lengthSelect.value}s`;
    }
    if (resolutionValue && resolutionSelect) {
      resolutionValue.textContent = resolutionSelect.value;
    }
    if (presetValue && presetSelect) {
      presetValue.textContent = presetSelect.value;
    }
  }

  function updateItemProgress(item, value) {
    if (!item) return;
    const fill = item.querySelector('.video-progress-fill');
    if (fill) {
      fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    }
  }

  function resetOutput(keepPreview) {
    progressBuffer = '';
    contentBuffer = '';
    collectingContent = false;
    lastProgress = 0;
    currentWaterfallItem = null;
    updateProgress(0);
    setIndeterminate(false);
    if (!keepPreview) {
      if (videoWaterfall) {
        videoWaterfall.innerHTML = '';
      }
      if (videoEmpty) {
        videoEmpty.style.display = '';
      }
      videoSequence = 0;
      exitSelectionMode();
    }
    if (durationValue) {
      durationValue.textContent = t('video.elapsedTimeNone');
    }
  }

  function initWaterfallSlot() {
    if (!videoWaterfall) return;
    videoSequence += 1;

    const item = document.createElement('div');
    item.className = 'video-waterfall-item';
    item.dataset.index = String(videoSequence);
    item.dataset.url = '';

    // 选择框
    const checkbox = document.createElement('div');
    checkbox.className = 'video-checkbox';
    item.appendChild(checkbox);

    // 进度条覆盖层
    const progressOverlay = document.createElement('div');
    progressOverlay.className = 'video-progress-overlay';
    const progressFillEl = document.createElement('div');
    progressFillEl.className = 'video-progress-fill';
    progressOverlay.appendChild(progressFillEl);
    item.appendChild(progressOverlay);

    // 占位区
    const placeholder = document.createElement('div');
    placeholder.className = 'video-placeholder';
    placeholder.textContent = t('video.generatingPlaceholder');
    item.appendChild(placeholder);

    // 底部元数据
    const meta = document.createElement('div');
    meta.className = 'waterfall-meta';

    const indexSpan = document.createElement('div');
    indexSpan.textContent = `#${videoSequence}`;

    const metaRight = document.createElement('div');
    metaRight.className = 'meta-right';

    const statusBadge = document.createElement('span');
    statusBadge.className = 'image-status running';
    statusBadge.textContent = t('common.generating');

    const timeSpan = document.createElement('span');
    timeSpan.className = 'waterfall-time';
    timeSpan.textContent = '';

    metaRight.appendChild(statusBadge);
    metaRight.appendChild(timeSpan);
    meta.appendChild(indexSpan);
    meta.appendChild(metaRight);
    item.appendChild(meta);

    // 记录开始时间
    item.dataset.startTime = String(Date.now());

    videoWaterfall.prepend(item);
    currentWaterfallItem = item;

    if (videoEmpty) {
      videoEmpty.style.display = 'none';
    }

    // 选择模式同步
    if (isSelectionMode) {
      item.classList.add('selection-mode');
    }
  }

  function ensureWaterfallSlot() {
    if (!currentWaterfallItem) {
      initWaterfallSlot();
    }
    return currentWaterfallItem;
  }

  function updateWaterfallItemDone(item, url) {
    if (!item) return;
    item.dataset.url = url || '';

    // 状态徽章
    const badge = item.querySelector('.image-status');
    if (badge) {
      badge.classList.remove('running');
      badge.classList.add('done');
      badge.textContent = t('common.done');
    }

    // 移除进度条覆盖层
    const overlay = item.querySelector('.video-progress-overlay');
    if (overlay) {
      overlay.remove();
    }

    // 更新耗时
    const startTime = parseInt(item.dataset.startTime, 10);
    if (startTime) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const timeSpan = item.querySelector('.waterfall-time');
      if (timeSpan) {
        timeSpan.textContent = `${elapsed}s`;
      }
    }
  }

  function setIndeterminate(active) {
    if (!progressBar) return;
    if (active) {
      progressBar.classList.add('indeterminate');
    } else {
      progressBar.classList.remove('indeterminate');
    }
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    if (!durationValue) return;
    elapsedTimer = setInterval(() => {
      if (!startAt) return;
      const seconds = Math.max(0, Math.round((Date.now() - startAt) / 1000));
      durationValue.textContent = t('video.elapsedTime', { sec: seconds });
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function clearFileSelection() {
    fileDataUrl = '';
    if (imageFileInput) {
      imageFileInput.value = '';
    }
    if (imageFileName) {
      imageFileName.textContent = t('common.noFileSelected');
    }
  }

  function normalizeAuthHeader(authHeader) {
    if (!authHeader) return '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    return authHeader;
  }

  function buildSseUrl(taskId, rawPublicKey) {
    const httpProtocol = window.location.protocol === 'https:' ? 'https' : 'http';
    const base = `${httpProtocol}://${window.location.host}/v1/function/video/sse`;
    const params = new URLSearchParams();
    params.set('task_id', taskId);
    params.set('t', String(Date.now()));
    if (rawPublicKey) {
      params.set('function_key', rawPublicKey);
    }
    return `${base}?${params.toString()}`;
  }

  async function createVideoTask(authHeader) {
    const prompt = promptInput ? promptInput.value.trim() : '';
    const rawUrl = imageUrlInput ? imageUrlInput.value.trim() : '';
    if (fileDataUrl && rawUrl) {
      toast(t('video.referenceConflict'), 'error');
      throw new Error('invalid_reference');
    }
    const imageUrl = fileDataUrl || rawUrl;
    const res = await fetch('/v1/function/video/start', {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(authHeader),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        image_url: imageUrl || null,
        reasoning_effort: DEFAULT_REASONING_EFFORT,
        aspect_ratio: ratioSelect ? ratioSelect.value : '3:2',
        video_length: lengthSelect ? parseInt(lengthSelect.value, 10) : 6,
        resolution_name: resolutionSelect ? resolutionSelect.value : '480p',
        preset: presetSelect ? presetSelect.value : 'normal'
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to create task');
    }
    const data = await res.json();
    return data && data.task_id ? String(data.task_id) : '';
  }

  async function stopVideoTask(taskId, authHeader) {
    if (!taskId) return;
    try {
      await fetch('/v1/function/video/stop', {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(authHeader),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ task_ids: [taskId] })
      });
    } catch (e) {
      // ignore
    }
  }

  function extractVideoInfo(buffer) {
    if (!buffer) return null;
    if (buffer.includes('<video')) {
      const matches = buffer.match(/<video[\s\S]*?<\/video>/gi);
      if (matches && matches.length) {
        return { html: matches[matches.length - 1] };
      }
    }
    const mdMatches = buffer.match(/\[video\]\(([^)]+)\)/g);
    if (mdMatches && mdMatches.length) {
      const last = mdMatches[mdMatches.length - 1];
      const urlMatch = last.match(/\[video\]\(([^)]+)\)/);
      if (urlMatch) {
        return { url: urlMatch[1] };
      }
    }
    const urlMatches = buffer.match(/https?:\/\/[^\s<)]+/g);
    if (urlMatches && urlMatches.length) {
      return { url: urlMatches[urlMatches.length - 1] };
    }
    return null;
  }

  function renderVideoFromHtml(html) {
    const container = ensureWaterfallSlot();
    if (!container) return;
    const placeholder = container.querySelector('.video-placeholder');
    if (placeholder) {
      // 解析 HTML 提取视频地址
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const srcVideo = tmp.querySelector('video');
      let videoUrl = '';
      if (srcVideo) {
        const source = srcVideo.querySelector('source');
        if (source && source.getAttribute('src')) {
          videoUrl = source.getAttribute('src');
        } else if (srcVideo.getAttribute('src')) {
          videoUrl = srcVideo.getAttribute('src');
        }
      }

      const videoEl = document.createElement('video');
      videoEl.controls = true;
      videoEl.preload = 'metadata';
      if (videoUrl) {
        videoEl.src = videoUrl;
      }
      placeholder.replaceWith(videoEl);
      updateWaterfallItemDone(container, videoUrl);
    }
  }

  function renderVideoFromUrl(url) {
    const container = ensureWaterfallSlot();
    if (!container) return;
    const safeUrl = url || '';
    const placeholder = container.querySelector('.video-placeholder');
    if (placeholder) {
      const videoEl = document.createElement('video');
      videoEl.controls = true;
      videoEl.preload = 'metadata';
      videoEl.src = safeUrl;
      placeholder.replaceWith(videoEl);
      updateWaterfallItemDone(container, safeUrl);
    }
  }

  function handleDelta(text) {
    if (!text) return;
    if (text.includes('<think>') || text.includes('</think>')) {
      return;
    }
    if (text.includes('超分辨率') || text.includes('super resolution')) {
      setStatus('connecting', t('video.superResolutionInProgress'));
      setIndeterminate(true);
      if (progressText) {
        progressText.textContent = t('video.superResolutionInProgress');
      }
      return;
    }

    if (!collectingContent) {
      const maybeVideo = text.includes('<video') || text.includes('[video](') || text.includes('http://') || text.includes('https://');
      if (maybeVideo) {
        collectingContent = true;
      }
    }

    if (collectingContent) {
      contentBuffer += text;
      const info = extractVideoInfo(contentBuffer);
      if (info) {
        if (info.html) {
          renderVideoFromHtml(info.html);
        } else if (info.url) {
          renderVideoFromUrl(info.url);
        }
      }
      return;
    }

    progressBuffer += text;
    const roundMatches = [...progressBuffer.matchAll(/\[round=(\d+)\/(\d+)\]\s*progress=([0-9]+(?:\.[0-9]+)?)%/g)];
    if (roundMatches.length) {
      const last = roundMatches[roundMatches.length - 1];
      const round = parseInt(last[1], 10);
      const total = parseInt(last[2], 10);
      const value = parseFloat(last[3]);
      setIndeterminate(false);
      updateProgress(value);
      updateItemProgress(currentWaterfallItem, value);
      if (progressText && Number.isFinite(round) && Number.isFinite(total) && total > 0) {
        progressText.textContent = `${Math.round(value)}% · ${round}/${total}`;
      }
      progressBuffer = progressBuffer.slice(Math.max(0, progressBuffer.length - 300));
      return;
    }

    const genericProgressMatches = [...progressBuffer.matchAll(/progress=([0-9]+(?:\.[0-9]+)?)%/g)];
    if (genericProgressMatches.length) {
      const last = genericProgressMatches[genericProgressMatches.length - 1];
      const value = parseFloat(last[1]);
      setIndeterminate(false);
      updateProgress(value);
      updateItemProgress(currentWaterfallItem, value);
      progressBuffer = progressBuffer.slice(Math.max(0, progressBuffer.length - 240));
      return;
    }

    const matches = [...progressBuffer.matchAll(/进度\s*(\d+)%/g)];
    if (matches.length) {
      const last = matches[matches.length - 1];
      const value = parseInt(last[1], 10);
      setIndeterminate(false);
      updateProgress(value);
      updateItemProgress(currentWaterfallItem, value);
      progressBuffer = progressBuffer.slice(Math.max(0, progressBuffer.length - 200));
    }
  }

  function closeSource() {
    if (currentSource) {
      try {
        currentSource.close();
      } catch (e) {
        // ignore
      }
      currentSource = null;
    }
  }

  async function startConnection() {
    const prompt = promptInput ? promptInput.value.trim() : '';
    if (!prompt) {
      toast(t('common.enterPrompt'), 'error');
      return;
    }

    if (isRunning) {
      toast(t('video.alreadyGenerating'), 'warning');
      return;
    }

    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(t('common.configurePublicKey'), 'error');
      window.location.href = '/login';
      return;
    }

    isRunning = true;
    startBtn.disabled = true;
    updateMeta();
    resetOutput(true);
    initWaterfallSlot();
    setStatus('connecting', t('common.connecting'));

    let taskId = '';
    try {
      taskId = await createVideoTask(authHeader);
    } catch (e) {
      setStatus('error', t('common.createTaskFailed'));
      startBtn.disabled = false;
      isRunning = false;
      return;
    }

    currentTaskId = taskId;
    startAt = Date.now();
    setStatus('connected', t('common.generating'));
    setButtons(true);
    setIndeterminate(true);
    startElapsedTimer();

    const rawPublicKey = normalizeAuthHeader(authHeader);
    const url = buildSseUrl(taskId, rawPublicKey);
    closeSource();
    const es = new EventSource(url);
    currentSource = es;

    es.onopen = () => {
      setStatus('connected', t('common.generating'));
    };

    es.onmessage = (event) => {
      if (!event || !event.data) return;
      if (event.data === '[DONE]') {
        finishRun();
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (payload && payload.error) {
        toast(payload.error, 'error');
        setStatus('error', t('common.generationFailed'));
        finishRun(true);
        return;
      }
      const choice = payload.choices && payload.choices[0];
      const delta = choice && choice.delta ? choice.delta : null;
      if (delta && delta.content) {
        handleDelta(delta.content);
      }
      if (choice && choice.finish_reason === 'stop') {
        finishRun();
      }
    };

    es.onerror = () => {
      if (!isRunning) return;
      setStatus('error', t('common.connectionError'));
      finishRun(true);
    };
  }

  async function stopConnection() {
    const authHeader = await ensureFunctionKey();
    if (authHeader !== null) {
      await stopVideoTask(currentTaskId, authHeader);
    }
    closeSource();
    isRunning = false;
    currentTaskId = '';
    stopElapsedTimer();
    setButtons(false);
    setStatus('', t('common.notConnected'));
  }

  function finishRun(hasError) {
    if (!isRunning) return;
    closeSource();
    isRunning = false;
    setButtons(false);
    stopElapsedTimer();
    if (!hasError) {
      setStatus('connected', t('common.done'));
      setIndeterminate(false);
      updateProgress(100);
      updateItemProgress(currentWaterfallItem, 100);
    } else {
      // 错误时标记当前卡片
      if (currentWaterfallItem) {
        const badge = currentWaterfallItem.querySelector('.image-status');
        if (badge) {
          badge.classList.remove('running');
          badge.classList.add('error');
          badge.textContent = t('common.failed');
        }
        const overlay = currentWaterfallItem.querySelector('.video-progress-overlay');
        if (overlay) {
          overlay.remove();
        }
      }
    }
    if (durationValue && startAt) {
      const seconds = Math.max(0, Math.round((Date.now() - startAt) / 1000));
      durationValue.textContent = t('video.elapsedTime', { sec: seconds });
    }
  }

  // ============ 灯箱功能 ============

  function getAllVideoItems() {
    if (!videoWaterfall) return [];
    return Array.from(videoWaterfall.querySelectorAll('.video-waterfall-item'));
  }

  function getCompletedVideoItems() {
    return getAllVideoItems().filter(item => item.dataset.url);
  }

  function openVideoLightbox(index) {
    const items = getCompletedVideoItems();
    if (index < 0 || index >= items.length) return;
    currentLightboxIndex = index;
    const url = items[index].dataset.url;
    if (!url) return;
    if (videoLightboxPlayer) {
      videoLightboxPlayer.src = url;
    }
    if (videoLightbox) {
      videoLightbox.classList.add('active');
    }
    updateLightboxNav();
  }

  function closeVideoLightboxFn() {
    if (videoLightboxPlayer) {
      videoLightboxPlayer.pause();
      videoLightboxPlayer.removeAttribute('src');
      videoLightboxPlayer.load();
    }
    if (videoLightbox) {
      videoLightbox.classList.remove('active');
    }
    currentLightboxIndex = -1;
  }

  function showPrevVideo() {
    if (currentLightboxIndex > 0) {
      openVideoLightbox(currentLightboxIndex - 1);
    }
  }

  function showNextVideo() {
    const items = getCompletedVideoItems();
    if (currentLightboxIndex < items.length - 1) {
      openVideoLightbox(currentLightboxIndex + 1);
    }
  }

  function updateLightboxNav() {
    const items = getCompletedVideoItems();
    if (videoLightboxPrev) {
      videoLightboxPrev.disabled = currentLightboxIndex <= 0;
    }
    if (videoLightboxNext) {
      videoLightboxNext.disabled = currentLightboxIndex >= items.length - 1;
    }
  }

  if (closeVideoLightbox) {
    closeVideoLightbox.addEventListener('click', closeVideoLightboxFn);
  }
  if (videoLightboxPrev) {
    videoLightboxPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      showPrevVideo();
    });
  }
  if (videoLightboxNext) {
    videoLightboxNext.addEventListener('click', (e) => {
      e.stopPropagation();
      showNextVideo();
    });
  }
  if (videoLightbox) {
    videoLightbox.addEventListener('click', (e) => {
      if (e.target === videoLightbox) {
        closeVideoLightboxFn();
      }
    });
  }
  if (videoLightboxPlayer) {
    videoLightboxPlayer.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // 键盘支持
  document.addEventListener('keydown', (e) => {
    if (!videoLightbox || !videoLightbox.classList.contains('active')) return;
    if (e.key === 'Escape') {
      closeVideoLightboxFn();
    } else if (e.key === 'ArrowLeft') {
      showPrevVideo();
    } else if (e.key === 'ArrowRight') {
      showNextVideo();
    }
  });

  // ============ 批量选择功能 ============

  function enterSelectionMode() {
    isSelectionMode = true;
    selectedVideos.clear();
    getAllVideoItems().forEach(item => {
      item.classList.add('selection-mode');
      item.classList.remove('selected');
    });
    if (selectionToolbar) {
      selectionToolbar.classList.remove('hidden');
    }
    updateSelectedVideoCount();
  }

  function exitSelectionMode() {
    isSelectionMode = false;
    selectedVideos.clear();
    getAllVideoItems().forEach(item => {
      item.classList.remove('selection-mode', 'selected');
    });
    if (selectionToolbar) {
      selectionToolbar.classList.add('hidden');
    }
    updateSelectedVideoCount();
  }

  function toggleSelectionMode() {
    if (isSelectionMode) {
      exitSelectionMode();
    } else {
      enterSelectionMode();
    }
  }

  function toggleVideoSelection(item) {
    if (!item || !item.dataset.url) return;
    const index = item.dataset.index;
    if (selectedVideos.has(index)) {
      selectedVideos.delete(index);
      item.classList.remove('selected');
    } else {
      selectedVideos.add(index);
      item.classList.add('selected');
    }
    updateSelectedVideoCount();
  }

  function updateSelectedVideoCount() {
    if (selectedCountBadge) {
      selectedCountBadge.textContent = String(selectedVideos.size);
    }
    // 更新全选按钮文本
    const completed = getCompletedVideoItems();
    if (toggleSelectAllBtn) {
      if (completed.length > 0 && selectedVideos.size >= completed.length) {
        toggleSelectAllBtn.textContent = t('video.deselectAll');
      } else {
        toggleSelectAllBtn.textContent = t('video.selectAll');
      }
    }
  }

  function toggleSelectAll() {
    const completed = getCompletedVideoItems();
    if (completed.length > 0 && selectedVideos.size >= completed.length) {
      // 取消全选
      selectedVideos.clear();
      completed.forEach(item => item.classList.remove('selected'));
    } else {
      // 全选
      completed.forEach(item => {
        const index = item.dataset.index;
        if (index) {
          selectedVideos.add(index);
          item.classList.add('selected');
        }
      });
    }
    updateSelectedVideoCount();
  }

  // ============ 批量下载 ============

  async function downloadSelectedVideos() {
    if (selectedVideos.size === 0) {
      toast(t('video.noVideosSelected'), 'error');
      return;
    }
    if (typeof JSZip === 'undefined') {
      toast(t('video.jszipFailed'), 'error');
      return;
    }

    const items = getCompletedVideoItems().filter(item => selectedVideos.has(item.dataset.index));
    if (items.length === 0) {
      toast(t('video.noVideosSelected'), 'error');
      return;
    }

    toast(t('video.packing', { count: items.length }), 'info');

    const zip = new JSZip();
    const folder = zip.folder('videos');
    let done = 0;
    const total = items.length;
    let successCount = 0;

    for (const item of items) {
      const url = item.dataset.url;
      const index = item.dataset.index || '0';
      try {
        const response = await fetch(url, { mode: 'cors' });
        if (response.ok) {
          const blob = await response.blob();
          folder.file(`grok_video_${index}.mp4`, blob);
          successCount++;
        }
      } catch (e) {
        // 跳过失败
      }
      done++;
      if (done < total) {
        toast(t('video.packingProgress', { done, total }), 'info');
      }
    }

    if (successCount === 0) {
      toast(t('video.noVideosDownloaded'), 'error');
      return;
    }

    toast(t('video.generatingZip'), 'info');

    try {
      const content = await zip.generateAsync({ type: 'blob' });
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const blobUrl = URL.createObjectURL(content);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `video_${dateStr}_${Date.now()}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(blobUrl);
      toast(t('video.packSuccess', { count: successCount }), 'success');
    } catch (e) {
      toast(t('video.packFailed'), 'error');
    }
  }

  // ============ 事件绑定 ============

  if (startBtn) {
    startBtn.addEventListener('click', () => startConnection());
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => stopConnection());
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => resetOutput());
  }

  if (batchDownloadBtn) {
    batchDownloadBtn.addEventListener('click', toggleSelectionMode);
  }

  if (toggleSelectAllBtn) {
    toggleSelectAllBtn.addEventListener('click', toggleSelectAll);
  }

  if (downloadSelectedBtn) {
    downloadSelectedBtn.addEventListener('click', downloadSelectedVideos);
  }

  // 瀑布流点击事件委托
  if (videoWaterfall) {
    videoWaterfall.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const item = target.closest('.video-waterfall-item');
      if (!item) return;

      // 点击 video 控件不触发
      if (target.tagName === 'VIDEO') return;

      if (isSelectionMode) {
        toggleVideoSelection(item);
        return;
      }

      // 正常模式：点击已完成卡片打开灯箱
      if (item.dataset.url) {
        const completed = getCompletedVideoItems();
        const idx = completed.indexOf(item);
        if (idx >= 0) {
          openVideoLightbox(idx);
        }
      }
    });
  }

  // ============ 浮动工具栏拖拽 ============

  if (floatingActions) {
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let barStartX = 0;
    let barStartY = 0;
    let hasMoved = false;

    floatingActions.addEventListener('pointerdown', (e) => {
      // 不拦截按钮上的点击
      if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
      isDragging = true;
      hasMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = floatingActions.getBoundingClientRect();
      barStartX = rect.left + rect.width / 2;
      barStartY = rect.top;
      floatingActions.setPointerCapture(e.pointerId);
      floatingActions.classList.add('shadow-xl');
    });

    floatingActions.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasMoved = true;
      }
      const newX = barStartX + dx;
      const newY = barStartY + dy;
      floatingActions.style.left = `${newX}px`;
      floatingActions.style.top = `${newY}px`;
      floatingActions.style.bottom = 'auto';
      floatingActions.style.transform = 'translateX(-50%)';
    });

    floatingActions.addEventListener('pointerup', (e) => {
      if (!isDragging) return;
      isDragging = false;
      floatingActions.releasePointerCapture(e.pointerId);
      floatingActions.classList.remove('shadow-xl');
    });
  }

  // ============ 文件与快捷键 ============

  if (imageFileInput) {
    imageFileInput.addEventListener('change', () => {
      const file = imageFileInput.files && imageFileInput.files[0];
      if (!file) {
        clearFileSelection();
        return;
      }
      if (imageUrlInput && imageUrlInput.value.trim()) {
        imageUrlInput.value = '';
      }
      if (imageFileName) {
        imageFileName.textContent = file.name;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          fileDataUrl = reader.result;
        } else {
          fileDataUrl = '';
          toast(t('common.fileReadFailed'), 'error');
        }
      };
      reader.onerror = () => {
        fileDataUrl = '';
        toast(t('common.fileReadFailed'), 'error');
      };
      reader.readAsDataURL(file);
    });
  }

  if (selectImageFileBtn && imageFileInput) {
    selectImageFileBtn.addEventListener('click', () => {
      imageFileInput.click();
    });
  }

  if (clearImageFileBtn) {
    clearImageFileBtn.addEventListener('click', () => {
      clearFileSelection();
    });
  }

  if (imageUrlInput) {
    imageUrlInput.addEventListener('input', () => {
      if (imageUrlInput.value.trim() && fileDataUrl) {
        clearFileSelection();
      }
    });
  }

  if (promptInput) {
    promptInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        startConnection();
      }
    });
  }

  updateMeta();
})();

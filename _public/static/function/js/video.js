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
  const genCountSelect = document.getElementById('genCountSelect');
  const concurrentSelect = document.getElementById('concurrentSelect');
  const statusText = document.getElementById('statusText');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const durationValue = document.getElementById('durationValue');
  const aspectValue = document.getElementById('aspectValue');
  const lengthValue = document.getElementById('lengthValue');
  const resolutionValue = document.getElementById('resolutionValue');
  const presetValue = document.getElementById('presetValue');
  const countValue = document.getElementById('countValue');
  const activeValue = document.getElementById('activeValue');
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

  let isRunning = false;
  let fileDataUrl = '';
  let elapsedTimer = null;
  let videoSequence = 0;
  let isSelectionMode = false;
  let selectedVideos = new Set();
  let currentLightboxIndex = -1;
  const DEFAULT_REASONING_EFFORT = 'low';

  // ============ 批量生成状态 ============
  let targetCount = 1;
  let concurrentMax = 1;
  let launchedCount = 0;
  let completedCount = 0;
  let shouldStop = false;
  let batchStartAt = 0;
  let consecutiveErrors = 0;
  let activeWorkers = new Map();
  let workerIdCounter = 0;

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
    if (progressFill) {
      progressFill.style.width = `${safe}%`;
    }
    if (progressText) {
      if (targetCount > 1) {
        progressText.textContent = `${completedCount}/${targetCount}`;
      } else {
        progressText.textContent = `${safe}%`;
      }
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
    updateCountDisplay();
    updateActiveDisplay();
  }

  function updateCountDisplay() {
    if (countValue) {
      if (targetCount > 1 || completedCount > 0) {
        countValue.textContent = `${completedCount} / ${targetCount}`;
      } else {
        countValue.textContent = '-';
      }
    }
  }

  function updateActiveDisplay() {
    if (activeValue) {
      activeValue.textContent = activeWorkers.size > 0 ? String(activeWorkers.size) : '-';
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
    updateCountDisplay();
    updateActiveDisplay();
  }

  function initWaterfallSlot() {
    if (!videoWaterfall) return null;
    videoSequence += 1;

    const item = document.createElement('div');
    item.className = 'video-waterfall-item';
    item.dataset.index = String(videoSequence);
    item.dataset.url = '';

    const checkbox = document.createElement('div');
    checkbox.className = 'video-checkbox';
    item.appendChild(checkbox);

    const progressOverlay = document.createElement('div');
    progressOverlay.className = 'video-progress-overlay';
    const progressFillEl = document.createElement('div');
    progressFillEl.className = 'video-progress-fill';
    progressOverlay.appendChild(progressFillEl);
    item.appendChild(progressOverlay);

    const placeholder = document.createElement('div');
    placeholder.className = 'video-placeholder';
    placeholder.textContent = t('video.generatingPlaceholder');
    item.appendChild(placeholder);

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

    item.dataset.startTime = String(Date.now());

    videoWaterfall.prepend(item);

    if (videoEmpty) {
      videoEmpty.style.display = 'none';
    }

    if (isSelectionMode) {
      item.classList.add('selection-mode');
    }

    return item;
  }

  function updateWaterfallItemDone(item, url) {
    if (!item) return;
    item.dataset.url = url || '';

    const badge = item.querySelector('.image-status');
    if (badge) {
      badge.classList.remove('running');
      badge.classList.add('done');
      badge.textContent = t('common.done');
    }

    const overlay = item.querySelector('.video-progress-overlay');
    if (overlay) {
      overlay.remove();
    }

    const startTime = parseInt(item.dataset.startTime, 10);
    if (startTime) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const timeSpan = item.querySelector('.waterfall-time');
      if (timeSpan) {
        timeSpan.textContent = `${elapsed}s`;
      }
    }
  }

  function markItemError(item) {
    if (!item) return;
    const badge = item.querySelector('.image-status');
    if (badge) {
      badge.classList.remove('running');
      badge.classList.add('error');
      badge.textContent = t('common.failed');
    }
    const overlay = item.querySelector('.video-progress-overlay');
    if (overlay) {
      overlay.remove();
    }
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
      if (!batchStartAt) return;
      const seconds = Math.max(0, Math.round((Date.now() - batchStartAt) / 1000));
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

  // ============ 视频提取与渲染 ============

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

  function renderVideoInItem(item, info) {
    if (!item || !info) return;
    const placeholder = item.querySelector('.video-placeholder');
    if (!placeholder) return;

    let videoUrl = '';
    if (info.html) {
      const tmp = document.createElement('div');
      tmp.innerHTML = info.html;
      const srcVideo = tmp.querySelector('video');
      if (srcVideo) {
        const source = srcVideo.querySelector('source');
        if (source && source.getAttribute('src')) {
          videoUrl = source.getAttribute('src');
        } else if (srcVideo.getAttribute('src')) {
          videoUrl = srcVideo.getAttribute('src');
        }
      }
    } else if (info.url) {
      videoUrl = info.url;
    }

    const videoEl = document.createElement('video');
    videoEl.controls = true;
    videoEl.preload = 'metadata';
    if (videoUrl) {
      videoEl.src = videoUrl;
    }
    placeholder.replaceWith(videoEl);
    updateWaterfallItemDone(item, videoUrl);
  }

  // ============ Worker Delta 处理 ============

  function handleWorkerDelta(worker, text) {
    if (!text || !worker) return;
    if (text.includes('<think>') || text.includes('</think>')) {
      return;
    }
    if (text.includes('超分辨率') || text.includes('super resolution')) {
      const badge = worker.waterfallItem && worker.waterfallItem.querySelector('.image-status');
      if (badge) {
        badge.textContent = t('video.superResolutionInProgress');
      }
      return;
    }

    if (!worker.collectingContent) {
      const maybeVideo = text.includes('<video') || text.includes('[video](') || text.includes('http://') || text.includes('https://');
      if (maybeVideo) {
        worker.collectingContent = true;
      }
    }

    if (worker.collectingContent) {
      worker.contentBuffer += text;
      const info = extractVideoInfo(worker.contentBuffer);
      if (info) {
        renderVideoInItem(worker.waterfallItem, info);
      }
      return;
    }

    worker.progressBuffer += text;
    const roundMatches = [...worker.progressBuffer.matchAll(/\[round=(\d+)\/(\d+)\]\s*progress=([0-9]+(?:\.[0-9]+)?)%/g)];
    if (roundMatches.length) {
      const last = roundMatches[roundMatches.length - 1];
      const round = parseInt(last[1], 10);
      const total = parseInt(last[2], 10);
      const value = parseFloat(last[3]);
      worker.lastProgress = value;
      updateItemProgress(worker.waterfallItem, value);
      // 单并发时更新全局进度条
      if (concurrentMax === 1) {
        setIndeterminate(false);
        if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, value))}%`;
        if (progressText) {
          if (targetCount > 1) {
            progressText.textContent = `${Math.round(value)}% · ${completedCount + 1}/${targetCount}`;
          } else {
            progressText.textContent = `${Math.round(value)}% · ${round}/${total}`;
          }
        }
      }
      worker.progressBuffer = worker.progressBuffer.slice(Math.max(0, worker.progressBuffer.length - 300));
      return;
    }

    const genericProgressMatches = [...worker.progressBuffer.matchAll(/progress=([0-9]+(?:\.[0-9]+)?)%/g)];
    if (genericProgressMatches.length) {
      const last = genericProgressMatches[genericProgressMatches.length - 1];
      const value = parseFloat(last[1]);
      worker.lastProgress = value;
      updateItemProgress(worker.waterfallItem, value);
      if (concurrentMax === 1) {
        setIndeterminate(false);
        if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, value))}%`;
      }
      worker.progressBuffer = worker.progressBuffer.slice(Math.max(0, worker.progressBuffer.length - 240));
      return;
    }

    const matches = [...worker.progressBuffer.matchAll(/进度\s*(\d+)%/g)];
    if (matches.length) {
      const last = matches[matches.length - 1];
      const value = parseInt(last[1], 10);
      worker.lastProgress = value;
      updateItemProgress(worker.waterfallItem, value);
      if (concurrentMax === 1) {
        setIndeterminate(false);
        if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, value))}%`;
      }
      worker.progressBuffer = worker.progressBuffer.slice(Math.max(0, worker.progressBuffer.length - 200));
    }
  }

  // ============ Worker 池核心逻辑 ============

  function closeWorkerSource(worker) {
    if (worker && worker.source) {
      try { worker.source.close(); } catch (e) { /* ignore */ }
      worker.source = null;
    }
  }

  async function spawnWorker(videoIndex, authHeader) {
    const workerId = ++workerIdCounter;
    const worker = {
      id: workerId,
      source: null,
      taskId: '',
      waterfallItem: null,
      finished: false,
      progressBuffer: '',
      contentBuffer: '',
      collectingContent: false,
      lastProgress: 0,
      startAt: Date.now()
    };
    activeWorkers.set(workerId, worker);
    updateActiveDisplay();

    // 创建瀑布流卡片
    const item = initWaterfallSlot();
    worker.waterfallItem = item;

    // 创建任务
    let taskId = '';
    try {
      taskId = await createVideoTask(authHeader);
    } catch (e) {
      markItemError(worker.waterfallItem);
      finishWorker(workerId, true, authHeader);
      return;
    }

    // 检查是否在等待期间被停止
    if (shouldStop || !activeWorkers.has(workerId)) {
      markItemError(worker.waterfallItem);
      activeWorkers.delete(workerId);
      updateActiveDisplay();
      checkBatchDone();
      return;
    }

    worker.taskId = taskId;
    setStatus('connected', t('video.generatingN', { done: completedCount, total: targetCount }));

    // 打开 SSE 连接
    const rawPublicKey = normalizeAuthHeader(authHeader);
    const url = buildSseUrl(taskId, rawPublicKey);
    const es = new EventSource(url);
    worker.source = es;

    es.onmessage = (event) => {
      if (!event || !event.data) return;
      if (event.data === '[DONE]') {
        finishWorker(workerId, false, authHeader);
        return;
      }
      let payload = null;
      try { payload = JSON.parse(event.data); } catch (e) { return; }
      if (payload && payload.error) {
        toast(payload.error, 'error');
        finishWorker(workerId, true, authHeader);
        return;
      }
      const choice = payload.choices && payload.choices[0];
      const delta = choice && choice.delta ? choice.delta : null;
      if (delta && delta.content) {
        handleWorkerDelta(worker, delta.content);
      }
      if (choice && choice.finish_reason === 'stop') {
        finishWorker(workerId, false, authHeader);
      }
    };

    es.onerror = () => {
      if (!isRunning) return;
      finishWorker(workerId, true, authHeader);
    };
  }

  function finishWorker(workerId, hasError, authHeader) {
    const worker = activeWorkers.get(workerId);
    if (!worker || worker.finished) return;
    worker.finished = true;

    closeWorkerSource(worker);
    activeWorkers.delete(workerId);
    updateActiveDisplay();

    if (hasError) {
      markItemError(worker.waterfallItem);
      consecutiveErrors++;
    } else {
      updateItemProgress(worker.waterfallItem, 100);
      // 如果视频还没渲染（contentBuffer 中有内容但未触发渲染），尝试最终渲染
      if (worker.contentBuffer) {
        const info = extractVideoInfo(worker.contentBuffer);
        if (info && worker.waterfallItem && worker.waterfallItem.querySelector('.video-placeholder')) {
          renderVideoInItem(worker.waterfallItem, info);
        }
      }
      if (worker.waterfallItem && !worker.waterfallItem.dataset.url) {
        updateWaterfallItemDone(worker.waterfallItem, '');
      }
      consecutiveErrors = 0;
    }

    completedCount++;
    updateCountDisplay();

    // 单并发时更新全局进度
    if (concurrentMax === 1) {
      if (!hasError) {
        setIndeterminate(false);
        updateProgress(100);
      }
    } else {
      if (progressText) {
        progressText.textContent = `${completedCount}/${targetCount}`;
      }
    }

    setStatus('connected', t('video.generatingN', { done: completedCount, total: targetCount }));

    // 检查是否应该停止
    if (shouldStop) {
      checkBatchDone();
      return;
    }
    if (consecutiveErrors >= 3) {
      toast(t('video.tooManyErrors'), 'error');
      shouldStop = true;
      checkBatchDone();
      return;
    }

    // 启动下一个 worker
    if (launchedCount < targetCount) {
      const delay = hasError ? 3000 : 1000;
      setTimeout(() => {
        if (shouldStop || !isRunning) {
          checkBatchDone();
          return;
        }
        launchedCount++;
        spawnWorker(launchedCount, authHeader);
      }, delay);
    } else {
      checkBatchDone();
    }
  }

  function checkBatchDone() {
    if (activeWorkers.size === 0) {
      finishBatch();
    }
  }

  function launchWorkers(authHeader) {
    const toSpawn = Math.min(concurrentMax, targetCount - launchedCount);
    for (let i = 0; i < toSpawn; i++) {
      launchedCount++;
      spawnWorker(launchedCount, authHeader);
    }
  }

  function finishBatch() {
    // 关闭所有残留连接
    for (const [, worker] of activeWorkers) {
      closeWorkerSource(worker);
    }
    activeWorkers.clear();
    isRunning = false;
    setButtons(false);
    stopElapsedTimer();
    updateActiveDisplay();

    if (completedCount >= targetCount) {
      setStatus('connected', t('video.batchComplete', { done: completedCount, total: targetCount }));
      if (targetCount > 1) {
        toast(t('video.genCountReached', { count: completedCount }), 'success');
      }
    } else {
      setStatus('', t('video.batchStopped', { done: completedCount, total: targetCount }));
    }

    setIndeterminate(false);
    if (completedCount > 0 && concurrentMax === 1) {
      updateProgress(100);
    }

    if (durationValue && batchStartAt) {
      const seconds = Math.max(0, Math.round((Date.now() - batchStartAt) / 1000));
      durationValue.textContent = t('video.elapsedTime', { sec: seconds });
    }
  }

  // ============ 连接控制 ============

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

    // 读取批量参数
    targetCount = genCountSelect ? parseInt(genCountSelect.value, 10) || 1 : 1;
    concurrentMax = concurrentSelect ? parseInt(concurrentSelect.value, 10) || 1 : 1;
    launchedCount = 0;
    completedCount = 0;
    shouldStop = false;
    consecutiveErrors = 0;
    workerIdCounter = 0;
    activeWorkers.clear();

    isRunning = true;
    startBtn.disabled = true;
    batchStartAt = Date.now();
    updateMeta();
    resetOutput(true);
    setStatus('connecting', t('common.connecting'));
    setButtons(true);
    setIndeterminate(true);
    startElapsedTimer();

    if (concurrentMax > 1) {
      // 多并发：全局进度条保持 indeterminate
      if (progressText) {
        progressText.textContent = `0/${targetCount}`;
      }
    } else {
      updateProgress(0);
    }

    // 启动 worker 池
    launchWorkers(authHeader);
  }

  async function stopConnection() {
    shouldStop = true;
    const authHeader = await ensureFunctionKey();

    // 停止所有活跃 worker
    const taskIds = [];
    for (const [, worker] of activeWorkers) {
      closeWorkerSource(worker);
      if (worker.taskId) {
        taskIds.push(worker.taskId);
      }
      if (!worker.finished) {
        markItemError(worker.waterfallItem);
      }
    }

    // 批量停止后端任务
    if (authHeader !== null && taskIds.length > 0) {
      try {
        await fetch('/v1/function/video/stop', {
          method: 'POST',
          headers: {
            ...buildAuthHeaders(authHeader),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ task_ids: taskIds })
        });
      } catch (e) {
        // ignore
      }
    }

    activeWorkers.clear();
    finishBatch();
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
      selectedVideos.clear();
      completed.forEach(item => item.classList.remove('selected'));
    } else {
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
    clearBtn.addEventListener('click', () => {
      if (isRunning) {
        stopConnection();
      }
      resetOutput();
    });
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

      if (target.tagName === 'VIDEO') return;

      if (isSelectionMode) {
        toggleVideoSelection(item);
        return;
      }

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


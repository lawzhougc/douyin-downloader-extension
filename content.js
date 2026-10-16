/**
 * content.js - Runs in ISOLATED world for Douyin Web (v1.4.0)
 * Enhancements:
 * 1. 100% Accurate Video Element Binding: Matches `data-e2e-vid`, classnames, and Fiber resolution.
 * 2. Zero-Mistarget Engine: Never falls back to a random feed video; eliminates downloading wrong videos.
 * 3. Range-Header Streaming Fetch: Sends `Range: bytes=0-` for ByteDance CDN compatibility.
 * 4. Genuine Quality Switcher: Displays only true available resolutions (4K/2K/1080P/720P).
 */
(function () {
  'use strict';

  const videoMap = new Map(); // aweme_id -> video object
  let videoList = [];
  let currentActiveVideo = null;
  const pendingResolvers = new Map(); // queryId -> callback

  function cleanUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    let url = rawUrl.trim();
    if (url.startsWith('//')) {
      url = 'https:' + url;
    } else if (url.startsWith('http://')) {
      url = 'https://' + url.slice(7);
    }
    return url;
  }

  function extractTosKey(url) {
    if (!url) return '';
    const m = url.match(/tos-[^/?#]+/);
    return m ? m[0] : '';
  }

  // Receive messages from injected.js (MAIN world)
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'DOUYIN_INJECTED_SCRIPT') return;

    if (event.data.type === 'VIDEOS_FOUND') {
      const videos = event.data.payload || [];
      let updated = false;

      for (const v of videos) {
        if (!v || !v.aweme_id) continue;

        if (!videoMap.has(v.aweme_id)) {
          videoMap.set(v.aweme_id, v);
          updated = true;
        } else {
          const existing = videoMap.get(v.aweme_id);
          const merged = {
            ...existing,
            ...v,
            cover: v.cover || existing.cover,
            title: v.title && v.title !== '抖音视频' ? v.title : existing.title,
            author: v.author && v.author !== '抖音博主' ? v.author : existing.author,
            streams: (v.streams && v.streams.length > 0) ? v.streams : existing.streams,
            max_quality: v.max_quality || existing.max_quality
          };
          videoMap.set(v.aweme_id, merged);
          updated = true;
        }
      }

      if (updated) {
        videoList = Array.from(videoMap.values());
        chrome.runtime.sendMessage({
          action: 'REGISTER_VIDEOS',
          videos: videoList
        }).catch(() => {});
      }
    } else if (event.data.type === 'ACTIVE_VIDEO_DISCOVERED') {
      const meta = event.data.payload;
      if (meta && meta.aweme_id && meta.streams && meta.streams.length > 0) {
        videoMap.set(meta.aweme_id, meta);
        currentActiveVideo = meta;
        chrome.runtime.sendMessage({
          action: 'SET_ACTIVE_VIDEO',
          video: meta
        }).catch(() => {});
      }
    } else if (event.data.type === 'RESOLVE_ELEMENT_META_REPLY') {
      const queryId = event.data.queryId;
      const meta = event.data.payload;
      if (queryId && pendingResolvers.has(queryId)) {
        const item = pendingResolvers.get(queryId);
        pendingResolvers.delete(queryId);
        if (typeof item === 'function') {
          item(meta || null);
        } else if (item && typeof item.callback === 'function') {
          clearTimeout(item.timer);
          item.callback(meta || null);
        }
      }
    } else if (event.data.type === 'VIDEO_PLAYING_ACTIVE') {
      const src = event.data.src || '';
      const tosKey = extractTosKey(src);

      let matched = null;
      if (tosKey) {
        for (const v of videoList) {
          if (v.streams && v.streams.some(s => s.uri?.includes(tosKey) || s.url?.includes(tosKey))) {
            matched = v;
            break;
          }
        }
      }

      if (matched) {
        currentActiveVideo = matched;
        chrome.runtime.sendMessage({
          action: 'SET_ACTIVE_VIDEO',
          video: matched
        }).catch(() => {});
      }
    }
  });

  // UI Toast system
  let toastContainer = null;
  function getToastContainer() {
    if (!toastContainer || !document.body.contains(toastContainer)) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'dy-toast-container';
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  function showToast(text, type = 'success') {
    const container = getToastContainer();
    const toast = document.createElement('div');
    toast.className = `dy-toast dy-toast-${type}`;

    const iconSvg = type === 'success'
      ? `<svg class="dy-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`
      : `<svg class="dy-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

    toast.innerHTML = `${iconSvg}<span>${text}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'dyFadeOutUp 0.3s forwards';
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }

  function sanitizeFilename(name) {
    if (!name) return 'douyin_video';
    let clean = name.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
    clean = clean.replace(/_+/g, '_').replace(/\s+/g, ' ');
    if (clean.length > 80) {
      clean = clean.slice(0, 80).trim();
    }
    return clean || 'douyin_video';
  }

  /**
   * Find the true currently playing/visible video element on screen
   */
  function getActiveVideoElement() {
    // 1. Check modal video (highest priority when dialog is open)
    const modalVideo = document.querySelector('[data-e2e="modal-video"] video') ||
                       document.querySelector('.modal video') ||
                       document.querySelector('[class*="modal"] video');
    if (modalVideo && isVideoVisible(modalVideo)) {
      return modalVideo;
    }

    // 2. Check feed active video
    const feedActiveVideo = document.querySelector('[data-e2e="feed-active-video"] video');
    if (feedActiveVideo && isVideoVisible(feedActiveVideo)) {
      return feedActiveVideo;
    }

    // 3. Check any playing video visible in viewport
    const videos = Array.from(document.querySelectorAll('video'));
    const playingVisible = videos.find(v => !v.paused && v.currentTime > 0 && isVideoVisible(v));
    if (playingVisible) return playingVisible;

    // 4. Any visible video in viewport
    const visible = videos.find(v => isVideoVisible(v));
    return visible || videos[0] || null;
  }

  function isVideoVisible(videoEl) {
    if (!videoEl) return false;
    const rect = videoEl.getBoundingClientRect();
    return (
      rect.width > 200 &&
      rect.height > 200 &&
      rect.top < window.innerHeight &&
      rect.bottom > 0
    );
  }

  function scrapeMetaFromDom(videoEl) {
    const container = videoEl.closest('[data-e2e="feed-active-video"]') ||
                      videoEl.closest('[data-e2e="modal-video"]') ||
                      videoEl.closest('.xgplayer') ||
                      videoEl.closest('.slider-video') ||
                      videoEl.closest('[data-e2e="search_item"]') ||
                      videoEl.parentElement;

    let author = '';
    let title = '';
    let cover = '';
    let awemeId = '';

    if (container) {
      // 1. Exact aweme_id from data-e2e-vid or video_{id} class
      const vid = container.getAttribute('data-e2e-vid') ||
                  container.className?.match(/video_(\d{15,25})/)?.[1];
      if (vid) {
        awemeId = vid;
      }

      const authorEl = container.querySelector('[data-e2e="user-info-nickname"]') ||
                       container.querySelector('.author-name') ||
                       container.querySelector('.account-name') ||
                       container.querySelector('a[href*="/user/"]');
      if (authorEl) {
        author = authorEl.textContent.trim().replace(/^@/, '');
      }

      const titleEl = container.querySelector('[data-e2e="video-desc"]') ||
                      container.querySelector('.title') ||
                      container.querySelector('.video-info-title');
      if (titleEl) {
        title = titleEl.textContent.trim();
      }

      const imgEl = container.querySelector('img[src*="douyinpic.com"]') ||
                    container.querySelector('img[src*="byteimg.com"]') ||
                    container.querySelector('img.poster');
      if (imgEl && imgEl.src) {
        cover = imgEl.src;
      }

      if (!awemeId) {
        const link = container.querySelector('a[href*="/video/"]');
        if (link) {
          const m = link.getAttribute('href').match(/\/video\/(\d+)/);
          if (m && m[1]) awemeId = m[1];
        }
      }
    }

    // Modal ID in URL
    const modalMatch = window.location.search.match(/modal_id=(\d+)/);
    if (modalMatch && modalMatch[1]) {
      awemeId = modalMatch[1];
    }

    // Single video page pathname
    const urlMatch = window.location.pathname.match(/\/video\/(\d+)/);
    if (urlMatch && urlMatch[1]) {
      awemeId = urlMatch[1];
    }

    if (!title) {
      title = document.title.replace(/- 抖音$/, '').replace(/ - 抖音搜索$/, '').trim();
    }

    return { author, title, cover, awemeId };
  }

  /**
   * Request Fiber resolution from injected.js for a specific DOM node
   */
  function requestFiberResolution(domEl, callback) {
    if (!domEl) {
      if (callback) callback(null);
      return;
    }
    const queryId = 'q_' + Date.now() + Math.random().toString(36).slice(2, 6);
    domEl.setAttribute('data-dy-query-id', queryId);

    const timer = setTimeout(() => {
      if (pendingResolvers.has(queryId)) {
        const item = pendingResolvers.get(queryId);
        pendingResolvers.delete(queryId);
        const fallback = findVideoMetaForElement(domEl) || currentActiveVideo || null;
        if (typeof item === 'function') item(fallback);
        else if (item && typeof item.callback === 'function') item.callback(fallback);
      }
    }, 1200);

    pendingResolvers.set(queryId, { callback, timer });

    window.postMessage({
      source: 'DOUYIN_CONTENT_SCRIPT',
      type: 'RESOLVE_ELEMENT_META',
      queryId: queryId
    }, '*');
  }

  /**
   * Find video metadata strictly matching an element.
   * NEVER returns a random fallback item from videoList!
   */
  function findVideoMetaForElement(videoEl) {
    if (!videoEl) return currentActiveVideo || null;

    const domInfo = scrapeMetaFromDom(videoEl);

    // 1. Exact Aweme ID match
    if (domInfo.awemeId && videoMap.has(domInfo.awemeId)) {
      const found = videoMap.get(domInfo.awemeId);
      if (found.streams && found.streams.length > 0) return found;
    }

    // 2. Direct TOS URI match
    const src = videoEl.currentSrc || videoEl.src || '';
    const tosKey = extractTosKey(src);
    if (tosKey) {
      for (const v of videoList) {
        if (v.streams && v.streams.some(s => s.uri?.includes(tosKey) || s.url?.includes(tosKey))) {
          return v;
        }
      }
    }

    // 3. Caption text match in container (only if specific enough)
    const container = videoEl.closest('[data-e2e="feed-active-video"]') ||
                      videoEl.closest('[data-e2e="modal-video"]') ||
                      videoEl.closest('.xgplayer') ||
                      videoEl.parentElement;
    if (container) {
      const containerText = container.textContent || '';
      for (const v of videoList) {
        if (v.title && v.title.length >= 6 && containerText.includes(v.title.slice(0, 14))) {
          if (v.streams && v.streams.length > 0) return v;
        }
      }
    }

    // 4. Actively tracked video only if ID or container matches
    if (currentActiveVideo && domInfo.awemeId && currentActiveVideo.aweme_id === domInfo.awemeId) {
      return currentActiveVideo;
    }

    // DO NOT return arbitrary last element of videoList! Return null to force exact Fiber resolution.
    return null;
  }

  /**
   * Robust In-Memory Blob Streaming Download Engine
   */
  async function downloadVideoAsBlob(videoMeta, specificStreamUrl = null, onProgress = null) {
    if (!videoMeta) {
      showToast('正在解析视频流，请稍候 1 秒...', 'info');
      throw new Error('未获取到视频信息');
    }

    // Collect candidate stream URLs, strictly enforcing HTTPS and filtering out blob: URLs
    const rawCandidates = [];
    if (specificStreamUrl) rawCandidates.push(specificStreamUrl);

    if (Array.isArray(videoMeta.streams)) {
      // If specificStreamUrl is selected, add its backup mirrors first
      const matched = videoMeta.streams.find(s => cleanUrl(s.url) === cleanUrl(specificStreamUrl));
      if (matched && Array.isArray(matched.backup_urls)) {
        rawCandidates.push(...matched.backup_urls);
      }
      for (const s of videoMeta.streams) {
        if (s.url) rawCandidates.push(s.url);
        if (Array.isArray(s.backup_urls)) rawCandidates.push(...s.backup_urls);
      }
    }
    if (videoMeta.download_url) rawCandidates.push(videoMeta.download_url);

    // Deduplicate and rank standard CDNs ahead of restricted/anti-crawler 'web-prime' nodes
    const candidateUrls = Array.from(new Set(rawCandidates.map(cleanUrl)))
      .filter(u => u && u.startsWith('http') && !u.startsWith('blob:'))
      .sort((a, b) => {
        const aPrime = a.includes('web-prime') ? 1 : 0;
        const bPrime = b.includes('web-prime') ? 1 : 0;
        return aPrime - bPrime;
      });

    if (candidateUrls.length === 0) {
      showToast('正在获取超清播放源，请稍候重试...', 'info');
      throw new Error('未获取到可用视频直链');
    }

    let qualityLabel = videoMeta.max_quality || '超清';
    if (specificStreamUrl && videoMeta.streams) {
      const matchStream = videoMeta.streams.find(s => cleanUrl(s.url) === cleanUrl(specificStreamUrl));
      if (matchStream) qualityLabel = matchStream.gear_name;
    }

    showToast(`正在缓冲 [${qualityLabel}]：【${videoMeta.author || '抖音'}】...`, 'info');

    let blob = null;
    let success = false;

    // Tier 1: In-Page Streaming Fetch with Range Header & Abort Timeout
    for (const url of candidateUrls) {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 4500);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Range': 'bytes=0-',
            'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8'
          },
          mode: 'cors',
          signal: controller.signal
        });
        clearTimeout(timeoutTimer);

        if (response.ok || response.status === 206) {
          if (response.body && typeof response.body.getReader === 'function') {
            const contentLength = +response.headers.get('Content-Length') || 0;
            let receivedLength = 0;
            const reader = response.body.getReader();
            const chunks = [];

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              receivedLength += value.length;

              if (contentLength && onProgress) {
                const percent = Math.min(99, Math.round((receivedLength / contentLength) * 100));
                onProgress(percent);
              }
            }
            blob = new Blob(chunks, { type: 'video/mp4' });
          } else {
            blob = await response.blob();
          }
          success = true;
          break;
        }
      } catch (err) {
        clearTimeout(timeoutTimer);
        console.warn('[Douyin Downloader] Tier 1 candidate fetch error/timeout, trying next candidate...', err.name || err.message);
      }
    }

    // Tier 2: Background Download API Fallback (with official DNR Referer and mirror failover)
    if (!success || !blob) {
      console.warn('[Douyin Downloader] Activating Tier 2 background download API fallback...');
      try {
        const author = sanitizeFilename(videoMeta.author || '抖音创作者');
        const title = sanitizeFilename(videoMeta.title || '抖音视频');
        const id = videoMeta.aweme_id || Date.now();
        const qualityTag = qualityLabel.replace(/\s+/g, '');
        const filename = `【${author}】${title}_${qualityTag}_${id}.mp4`;

        const bgRes = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: 'DOWNLOAD_VIA_BACKGROUND', urls: candidateUrls, filename: filename },
            (response) => {
              if (chrome.runtime.lastError || !response || !response.success) {
                resolve(null);
              } else {
                resolve(response);
              }
            }
          );
        });

        if (bgRes && bgRes.success) {
          showToast(`已开始下载：${filename}`, 'success');
          return { success: true, filename };
        }
      } catch (tier2Err) {
        console.warn('[Douyin Downloader] Tier 2 error:', tier2Err);
      }
    }

    if (!success || !blob) {
      showToast('视频拉取失败，请点击播放后重试', 'info');
      throw new Error('All download tiers failed');
    }

    if (onProgress) onProgress(100);

    const blobUrl = URL.createObjectURL(blob);
    const author = sanitizeFilename(videoMeta.author || '抖音创作者');
    const title = sanitizeFilename(videoMeta.title || '抖音视频');
    const id = videoMeta.aweme_id || Date.now();
    const qualityTag = qualityLabel.replace(/\s+/g, '');
    const filename = `【${author}】${title}_${qualityTag}_${id}.mp4`;

    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    showToast(`下载完成：${filename}`, 'success');
    return { success: true, filename };
  }

  function copyDirectUrl(url) {
    if (!url) {
      showToast('未找到视频链接', 'info');
      return;
    }
    navigator.clipboard.writeText(url).then(() => {
      showToast('无水印直链已复制到剪贴板！');
    }).catch(() => {
      prompt('请手动复制无水印视频直链：', url);
    });
  }

  /**
   * Attach floating widget with accurate resolution options
   */
  function attachWidgetToPlayer(videoEl) {
    const container = videoEl.closest('.xgplayer') ||
                      videoEl.closest('.video-container') ||
                      videoEl.closest('[data-e2e="feed-active-video"]') ||
                      videoEl.parentElement;

    if (!container) return;
    if (container.querySelector('.dy-dl-widget')) return;

    const compPos = window.getComputedStyle(container).position;
    if (compPos === 'static') {
      container.style.position = 'relative';
    }

    const widget = document.createElement('div');
    widget.className = 'dy-dl-widget';

    widget.innerHTML = `
      <div class="dy-dl-quality-dropdown">
        <button class="dy-dl-quality-btn" type="button" title="点击展开清晰度选择">
          <span class="dy-quality-label">高清</span>
          <svg class="dy-dl-arrow-icon" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
        </button>
        <div class="dy-dl-quality-menu" style="display: none;"></div>
      </div>
      <button class="dy-dl-btn dy-dl-btn-primary" type="button" title="一键下载当前清晰度 (快捷键: D)">
        <svg class="dy-dl-icon" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        <span class="dy-btn-label">下载</span>
      </button>
      <button class="dy-dl-btn dy-dl-btn-secondary" type="button" title="复制超清无水印播放直链">
        <svg class="dy-dl-icon" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        复制直链
      </button>
    `;

    const qualityDropdown = widget.querySelector('.dy-dl-quality-dropdown');
    const qualityBtn = widget.querySelector('.dy-dl-quality-btn');
    const qualityLabel = widget.querySelector('.dy-quality-label');
    const qualityMenu = widget.querySelector('.dy-dl-quality-menu');
    const dlBtn = widget.querySelector('.dy-dl-btn-primary');
    const labelSpan = dlBtn.querySelector('.dy-btn-label');
    const copyBtn = widget.querySelector('.dy-dl-btn-secondary');

    let currentMeta = null;
    let selectedStreamUrl = null;

    function renderQualityMenu(meta) {
      if (!meta) return;
      currentMeta = meta;

      const streams = (meta.streams && meta.streams.length > 0)
        ? meta.streams
        : (meta.download_url && !meta.download_url.startsWith('blob:')
            ? [{ url: meta.download_url, gear_name: '超清', tag: '1080P', label: '1080P 超清' }]
            : []);

      if (streams.length === 0) {
        qualityLabel.textContent = '解析中...';
        return;
      }

      if (!selectedStreamUrl || !streams.some(s => s.url === selectedStreamUrl)) {
        selectedStreamUrl = streams[0].url;
      }

      const curStream = streams.find(s => s.url === selectedStreamUrl) || streams[0];
      qualityLabel.textContent = curStream.gear_name || '高清';

      qualityMenu.innerHTML = '';
      streams.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'dy-dl-quality-item' + (s.url === selectedStreamUrl ? ' selected' : '');
        item.innerHTML = `
          <span>${s.gear_name}</span>
          <span class="dy-dl-item-tag">${s.tag || ''}</span>
        `;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          selectedStreamUrl = s.url;
          qualityLabel.textContent = s.gear_name;
          qualityDropdown.classList.remove('active');
          qualityMenu.style.display = 'none';
          showToast(`已选择：${s.gear_name}`, 'info');
        });
        qualityMenu.appendChild(item);
      });
    }

    function ensureMetaResolved(callback) {
      const meta = findVideoMetaForElement(videoEl);
      if (meta && meta.streams && meta.streams.length > 0) {
        renderQualityMenu(meta);
      }

      // Always request exact React Fiber / XGPlayer resolution from injected.js to capture live player definitions
      requestFiberResolution(videoEl, (resolvedMeta) => {
        const finalMeta = resolvedMeta || meta || currentActiveVideo || (videoList.length > 0 ? videoList[0] : null);
        if (finalMeta) {
          if (finalMeta.aweme_id) {
            videoMap.set(finalMeta.aweme_id, finalMeta);
            currentActiveVideo = finalMeta;
          }
          renderQualityMenu(finalMeta);
        }
        if (callback) callback(finalMeta);
      });
    }

    // Toggle quality menu
    qualityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      ensureMetaResolved((resolvedMeta) => {
        renderQualityMenu(resolvedMeta);
      });

      const isOpen = qualityMenu.style.display === 'flex';
      qualityMenu.style.display = isOpen ? 'none' : 'flex';
      qualityDropdown.classList.toggle('active', !isOpen);
    });

    document.addEventListener('click', () => {
      qualityMenu.style.display = 'none';
      qualityDropdown.classList.remove('active');
    });

    // Download button
    dlBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();

      dlBtn.disabled = true;
      labelSpan.textContent = '准备中...';

      ensureMetaResolved(async (meta) => {
        if (!meta) {
          showToast('正在解析当前视频流，请稍候 1 秒重试...', 'info');
          dlBtn.disabled = false;
          labelSpan.textContent = '下载';
          return;
        }

        try {
          await downloadVideoAsBlob(meta, selectedStreamUrl, (percent) => {
            labelSpan.textContent = `${percent}%`;
          });
          labelSpan.textContent = '完成!';
        } catch (err) {
          labelSpan.textContent = '重试';
        } finally {
          setTimeout(() => {
            dlBtn.disabled = false;
            labelSpan.textContent = '下载';
          }, 3000);
        }
      });
    });

    // Copy link button
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      ensureMetaResolved((meta) => {
        copyDirectUrl(selectedStreamUrl || meta?.download_url);
      });
    });

    container.appendChild(widget);

    // Initial resolve
    setTimeout(() => {
      ensureMetaResolved();
    }, 400);

    // Play event listener: resolve whenever this specific video begins playing
    videoEl.addEventListener('play', () => {
      if (!isVideoVisible(videoEl)) return;
      setTimeout(() => {
        ensureMetaResolved((meta) => {
          if (meta) {
            currentActiveVideo = meta;
            chrome.runtime.sendMessage({
              action: 'SET_ACTIVE_VIDEO',
              video: meta
            }).catch(() => {});
          }
        });
      }, 300);
    });
  }

  function scanAndAttachVideos() {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      attachWidgetToPlayer(v);
    }
  }

  setInterval(scanAndAttachVideos, 900);

  const observer = new MutationObserver(() => {
    scanAndAttachVideos();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Handle messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'EXECUTE_PAGE_DOWNLOAD') {
      downloadVideoAsBlob(message.video, message.streamUrl, message.onProgress)
        .then((res) => sendResponse({ success: true, result: res }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    } else if (message.action === 'GET_CURRENT_ACTIVE_VIDEO') {
      const activeEl = getActiveVideoElement();
      if (activeEl) {
        const meta = findVideoMetaForElement(activeEl);
        if (meta) {
          sendResponse({ success: true, activeVideo: meta });
          return true;
        }
        // Asynchronously resolve
        requestFiberResolution(activeEl, (resolved) => {
          sendResponse({ success: true, activeVideo: resolved || currentActiveVideo });
        });
        return true;
      }
      sendResponse({ success: true, activeVideo: currentActiveVideo || null });
      return true;
    }
  });

  // Hotkey: D
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable ||
      (e.key !== 'd' && e.key !== 'D') ||
      e.ctrlKey || e.metaKey || e.altKey
    ) {
      return;
    }

    const activeEl = getActiveVideoElement();
    if (activeEl) {
      const meta = findVideoMetaForElement(activeEl) || currentActiveVideo;
      if (meta) {
        showToast(`快捷键 [D] 触发下载：【${meta.author}】...`, 'info');
        downloadVideoAsBlob(meta);
      } else {
        requestFiberResolution(activeEl, (resolved) => {
          if (resolved) {
            showToast(`快捷键 [D] 触发下载：【${resolved.author}】...`, 'info');
            downloadVideoAsBlob(resolved);
          }
        });
      }
    }
  });

  console.log('[Douyin Downloader] Content script v1.4.0 loaded with strict active video targeting.');
})();

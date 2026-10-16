/**
 * popup.js - Interactive controller for Extension Popup UI (v1.4.0)
 * Enhancements:
 * 1. Pinned "Currently Watching" card: 100% matches active screen video.
 * 2. True 4K / 2K / 1080P resolution selector (no fake options).
 * 3. Range-aware streaming fetch & background download fallback.
 */
(function () {
  'use strict';

  let currentTabId = null;
  let cachedVideos = [];
  let currentActiveVideo = null;

  const videoListContainer = document.getElementById('videoListContainer');
  const activeVideoSection = document.getElementById('activeVideoSection');
  const activeVideoCardContainer = document.getElementById('activeVideoCardContainer');
  const emptyState = document.getElementById('emptyState');
  const toolbar = document.getElementById('toolbar');
  const videoCountBadge = document.getElementById('videoCountBadge');
  const btnDownloadAll = document.getElementById('btnDownloadAll');
  const btnClearAll = document.getElementById('btnClearAll');

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

  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
   * PURE IN-MEMORY BLOB DOWNLOAD DISPATCHER
   * Supports selecting specific resolution (4K / 2K / 1080P).
   */
  async function dispatchDownload(video, specificUrl, onStatus) {
    const rawStreamUrl = specificUrl || video.download_url;
    const streamUrl = cleanUrl(rawStreamUrl);

    // Detect quality tag from selected URL
    let qualityTag = '高清';
    if (video.streams) {
      const matchStream = video.streams.find(s => cleanUrl(s.url) === streamUrl);
      if (matchStream) qualityTag = matchStream.gear_name.replace(/\s+/g, '');
    }

    const author = sanitizeFilename(video.author || '抖音创作者');
    const title = sanitizeFilename(video.title || '抖音视频');
    const id = video.aweme_id || Date.now();
    const filename = `【${author}】${title}_${qualityTag}_${id}.mp4`;

    // 1. Try delegating to active tab's content.js
    if (currentTabId) {
      try {
        const pageResult = await new Promise((resolve) => {
          chrome.tabs.sendMessage(
            currentTabId,
            { action: 'EXECUTE_PAGE_DOWNLOAD', video: video, streamUrl: streamUrl },
            (response) => {
              if (chrome.runtime.lastError || !response || !response.success) {
                resolve(null);
              } else {
                resolve(response);
              }
            }
          );
        });

        if (pageResult && pageResult.success) {
          if (onStatus) onStatus('下载完成');
          return;
        }
      } catch (e) {}
    }

    // 2. Direct Blob download inside extension popup with Range headers
    try {
      if (onStatus) onStatus('拉取流中...');

      const rawCandidates = [streamUrl];
      if (video.download_url) rawCandidates.push(video.download_url);
      if (Array.isArray(video.streams)) {
        const matched = video.streams.find(s => cleanUrl(s.url) === cleanUrl(streamUrl));
        if (matched && Array.isArray(matched.backup_urls)) {
          rawCandidates.push(...matched.backup_urls);
        }
        for (const s of video.streams) {
          if (s.url) rawCandidates.push(s.url);
          if (Array.isArray(s.backup_urls)) rawCandidates.push(...s.backup_urls);
        }
      }

      const candidateUrls = Array.from(new Set(rawCandidates.map(cleanUrl)))
        .filter(u => u && u.startsWith('http') && !u.startsWith('blob:'))
        .sort((a, b) => {
          const aPrime = a.includes('web-prime') ? 1 : 0;
          const bPrime = b.includes('web-prime') ? 1 : 0;
          return aPrime - bPrime;
        });

      let resp = null;
      for (const url of candidateUrls) {
        const controller = new AbortController();
        const timeoutTimer = setTimeout(() => controller.abort(), 4500);
        try {
          const r = await fetch(url, {
            headers: { 'Range': 'bytes=0-' },
            signal: controller.signal
          });
          clearTimeout(timeoutTimer);
          if (r.ok || r.status === 206) {
            resp = r;
            break;
          }
        } catch (err) {
          clearTimeout(timeoutTimer);
        }
      }

      if (!resp) {
        // Fallback to background download API with multi-mirror failover
        chrome.runtime.sendMessage(
          { action: 'DOWNLOAD_VIA_BACKGROUND', urls: candidateUrls, filename: filename },
          (res) => {
            if (res && res.success) {
              if (onStatus) onStatus('后台下载中');
            } else {
              if (onStatus) onStatus('下载失败');
            }
          }
        );
        return;
      }

      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      if (onStatus) onStatus('下载完成');
    } catch (err) {
      console.warn('[Popup] In-popup blob download failed:', err);
      if (onStatus) onStatus('下载失败');
    }
  }

  /**
   * Create a Video Card DOM Element
   */
  function createVideoCard(v, isPinnedActive = false) {
    const card = document.createElement('div');
    card.className = 'video-card' + (isPinnedActive ? ' card-active-glow' : '');

    const durationStr = formatDuration(v.duration);
    const titleEscaped = escapeHtml(v.title || '无标题视频');
    const authorEscaped = escapeHtml(v.author || '抖音用户');

    // Build streams options
    const streams = (v.streams && v.streams.length > 0)
      ? v.streams
      : [{ url: v.download_url, gear_name: '高清', tag: '1080P', label: '1080P 高清' }];

    const selectOptionsHtml = streams.map((s, idx) => {
      const label = s.label || s.gear_name || (idx === 0 ? '最高画质' : '标准流');
      return `<option value="${escapeHtml(s.url)}">${escapeHtml(label)}</option>`;
    }).join('');

    card.innerHTML = `
      <div class="video-thumb-box">
        ${
          v.cover
            ? `<img src="${v.cover}" class="video-thumb" alt="Cover" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" /><div class="video-thumb-fallback" style="display:none;"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M10 8l6 4-6 4V8z"/></svg></div>`
            : `<div class="video-thumb-fallback"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M10 8l6 4-6 4V8z"/></svg></div>`
        }
        ${durationStr ? `<span class="duration-tag">${durationStr}</span>` : ''}
      </div>
      <div class="video-info">
        <div>
          <h3 class="video-title" title="${titleEscaped}">${titleEscaped}</h3>
          <div class="video-meta-row">
            <span class="video-author">@${authorEscaped}</span>
            <select class="quality-select" title="选择需要下载的清晰度">
              ${selectOptionsHtml}
            </select>
          </div>
        </div>
        <div class="video-actions">
          <button class="action-btn action-btn-dl">
            <svg class="icon" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            下载
          </button>
          <button class="action-btn action-btn-copy">
            复制直链
          </button>
          <button class="action-btn action-btn-link" title="在新标签页中打开预览">
            <svg class="icon" viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
          </button>
        </div>
      </div>
    `;

    const qualitySelect = card.querySelector('.quality-select');
    const dlBtn = card.querySelector('.action-btn-dl');
    const copyBtn = card.querySelector('.action-btn-copy');
    const openBtn = card.querySelector('.action-btn-link');

    dlBtn.addEventListener('click', async () => {
      dlBtn.disabled = true;
      dlBtn.textContent = '流式拉取中...';
      const chosenUrl = qualitySelect.value || v.download_url;

      await dispatchDownload(v, chosenUrl, (status) => {
        dlBtn.textContent = status;
        setTimeout(() => {
          dlBtn.disabled = false;
          dlBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> 下载`;
        }, 2500);
      });
    });

    copyBtn.addEventListener('click', () => {
      const chosenUrl = qualitySelect.value || v.download_url;
      navigator.clipboard.writeText(chosenUrl).then(() => {
        copyBtn.textContent = '已复制!';
        setTimeout(() => {
          copyBtn.textContent = '复制直链';
        }, 1800);
      });
    });

    openBtn.addEventListener('click', () => {
      const chosenUrl = qualitySelect.value || v.download_url;
      chrome.tabs.create({ url: chosenUrl });
    });

    return card;
  }

  function renderView() {
    const totalCount = cachedVideos.length;
    videoCountBadge.textContent = `${totalCount} 个视频`;

    if (totalCount === 0 && !currentActiveVideo) {
      emptyState.style.display = 'flex';
      toolbar.style.display = 'none';
      activeVideoSection.style.display = 'none';
      videoListContainer.innerHTML = '';
      return;
    }

    emptyState.style.display = 'none';
    toolbar.style.display = 'flex';

    // 1. Render Pinned Active Video
    if (currentActiveVideo) {
      activeVideoSection.style.display = 'block';
      activeVideoCardContainer.innerHTML = '';
      activeVideoCardContainer.appendChild(createVideoCard(currentActiveVideo, true));
    } else {
      activeVideoSection.style.display = 'none';
    }

    // 2. Render List of All Videos (Filtered)
    videoListContainer.innerHTML = '';
    const reversed = [...cachedVideos].reverse();

    reversed.forEach((v) => {
      // Avoid duplicate display if it's already pinned
      if (currentActiveVideo && (v.aweme_id === currentActiveVideo.aweme_id || v.download_url === currentActiveVideo.download_url)) {
        return;
      }
      videoListContainer.appendChild(createVideoCard(v, false));
    });
  }

  function loadTabVideos() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;
      currentTabId = tabs[0].id;

      // 1. Fetch current active video from page
      chrome.tabs.sendMessage(currentTabId, { action: 'GET_CURRENT_ACTIVE_VIDEO' }, (res) => {
        if (res && res.success && res.activeVideo) {
          currentActiveVideo = res.activeVideo;
        }

        // 2. Fetch full list of captured videos
        chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: currentTabId }, (resp) => {
          if (resp && resp.success) {
            cachedVideos = resp.videos || [];
          } else {
            cachedVideos = [];
          }
          renderView();
        });
      });
    });
  }

  // Batch download (highest quality for all)
  btnDownloadAll.addEventListener('click', () => {
    if (!cachedVideos.length && !currentActiveVideo) return;
    btnDownloadAll.disabled = true;
    btnDownloadAll.textContent = '正在批量流式下载...';

    const queue = currentActiveVideo ? [currentActiveVideo, ...cachedVideos] : [...cachedVideos];
    // Deduplicate
    const uniqueQueue = [];
    for (const item of queue) {
      if (!uniqueQueue.some(u => u.aweme_id === item.aweme_id || u.download_url === item.download_url)) {
        uniqueQueue.push(item);
      }
    }

    uniqueQueue.forEach((v, i) => {
      setTimeout(() => {
        dispatchDownload(v, v.download_url);
      }, i * 800);
    });

    setTimeout(() => {
      btnDownloadAll.disabled = false;
      btnDownloadAll.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> 全部完成`;
      setTimeout(() => {
        btnDownloadAll.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> 一键下载全部 (最高画质)`;
      }, 3000);
    }, uniqueQueue.length * 800 + 500);
  });

  // Clear
  btnClearAll.addEventListener('click', () => {
    if (confirm('确定清空当前捕获的视频列表吗？')) {
      chrome.runtime.sendMessage({ action: 'CLEAR_TAB_VIDEOS', tabId: currentTabId }, () => {
        cachedVideos = [];
        currentActiveVideo = null;
        renderView();
      });
    }
  });

  loadTabVideos();
})();

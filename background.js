/**
 * background.js - Service Worker for Douyin Video Downloader (v1.4.0)
 * Manages DeclarativeNetRequest rules, active video tracking, and background download fallback.
 */

const tabVideosMap = new Map(); // tabId -> Map(aweme_id -> videoData)
const activeVideosMap = new Map(); // tabId -> currently active video object

/**
 * Configure DeclarativeNetRequest rules to inject official Referer on all ByteDance CDN domains
 */
async function setupRefererRules() {
  try {
    const domains = [
      { id: 1001, filter: 'douyinvod.com' },
      { id: 1002, filter: 'snssdk.com' },
      { id: 1003, filter: 'amemv.com' },
      { id: 1004, filter: 'douyinpic.com' },
      { id: 1005, filter: 'byteimg.com' },
      { id: 1006, filter: 'ibytedtos.com' },
      { id: 1007, filter: 'pstatp.com' },
      { id: 1008, filter: 'zijieapi.com' },
      { id: 1009, filter: 'bytedance.com' }
    ];

    const rules = domains.map(d => ({
      id: d.id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.douyin.com/' },
          { header: 'Origin', operation: 'set', value: 'https://www.douyin.com' }
        ]
      },
      condition: {
        urlFilter: d.filter,
        resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'image', 'other']
      }
    }));

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009],
      addRules: rules
    });
    console.log('[Douyin Downloader] DNR Referer injection rules active for all ByteDance CDN domains.');
  } catch (err) {
    console.warn('[Douyin Downloader] Failed to update DNR rules:', err);
  }
}

chrome.runtime.onInstalled.addListener(setupRefererRules);
chrome.runtime.onStartup.addListener(setupRefererRules);
setupRefererRules();

function updateBadge(tabId) {
  const videos = tabVideosMap.get(tabId);
  const count = videos ? videos.size : 0;
  const badgeText = count > 0 ? String(count) : '';

  chrome.action.setBadgeText({ tabId, text: badgeText });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#fe2c55' });
}

function cleanBaseUrl(url) {
  if (!url) return '';
  return url.split('?')[0];
}

function registerVideos(tabId, newVideos) {
  if (!tabId || !Array.isArray(newVideos)) return;

  if (!tabVideosMap.has(tabId)) {
    tabVideosMap.set(tabId, new Map());
  }

  const currentMap = tabVideosMap.get(tabId);

  for (const v of newVideos) {
    if (!v || !v.download_url) continue;

    const baseDownloadUrl = cleanBaseUrl(v.download_url);

    let existingKey = null;
    for (const [key, item] of currentMap.entries()) {
      if (
        key === v.aweme_id ||
        (item.download_url && cleanBaseUrl(item.download_url) === baseDownloadUrl)
      ) {
        existingKey = key;
        break;
      }
    }

    if (existingKey) {
      const existing = currentMap.get(existingKey);
      const isNewReal = v.aweme_id && !v.aweme_id.startsWith('sniffed_') && !v.aweme_id.startsWith('live_');
      const isOldSniffed = existingKey.startsWith('sniffed_') || existingKey.startsWith('live_');

      const merged = {
        ...existing,
        ...v,
        cover: v.cover || existing.cover || '',
        title: (v.title && v.title !== '嗅探到的抖音视频' && v.title !== '抖音视频') ? v.title : existing.title,
        author: (v.author && v.author !== '抖音博主') ? v.author : existing.author,
        streams: (v.streams && v.streams.length > 0) ? v.streams : existing.streams,
        max_quality: v.max_quality || existing.max_quality
      };

      if (isOldSniffed && isNewReal) {
        currentMap.delete(existingKey);
        currentMap.set(v.aweme_id, merged);
      } else {
        currentMap.set(existingKey, merged);
      }
    } else {
      const key = v.aweme_id || v.download_url;
      currentMap.set(key, v);
    }
  }

  updateBadge(tabId);
}

// Fallback WebRequest Sniffer
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId < 0) return;

    const url = details.url;
    const isDouyinVod = url.includes('.douyinvod.com') || url.includes('.snssdk.com') || url.includes('/video/tos/');
    if (!isDouyinVod) return;

    let isVideo = false;
    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        if (h.name.toLowerCase() === 'content-type') {
          if (h.value && (h.value.includes('video/') || h.value.includes('application/octet-stream'))) {
            isVideo = true;
          }
          break;
        }
      }
    }

    if (isVideo || url.includes('.mp4')) {
      const base = cleanBaseUrl(url);
      const existingMap = tabVideosMap.get(tabId);
      let alreadyExists = false;
      if (existingMap) {
        for (const item of existingMap.values()) {
          if (cleanBaseUrl(item.download_url) === base) {
            alreadyExists = true;
            break;
          }
        }
      }

      if (!alreadyExists) {
        const fallbackVideo = {
          aweme_id: 'sniffed_' + Math.abs(url.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)),
          title: '嗅探视频_' + new Date().toLocaleTimeString(),
          author: '抖音创作者',
          download_url: url,
          cover: '',
          duration: 0,
          max_quality: '超清',
          streams: [{ url, gear_name: '超清', tag: '1080P', label: '1080P 超清' }],
          timestamp: Date.now()
        };
        registerVideos(tabId, [fallbackVideo]);
      }
    }
  },
  {
    urls: [
      '*://*.douyinvod.com/*',
      '*://*.snssdk.com/*',
      '*://*.amemv.com/*',
      '*://*.ibytedtos.com/*'
    ]
  },
  ['responseHeaders']
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = (sender.tab && sender.tab.id) || message.tabId;

  switch (message.action) {
    case 'REGISTER_VIDEOS': {
      if (tabId) {
        registerVideos(tabId, message.videos);
        sendResponse({ success: true, count: tabVideosMap.get(tabId)?.size || 0 });
      } else {
        sendResponse({ success: false });
      }
      break;
    }

    case 'SET_ACTIVE_VIDEO': {
      if (tabId && message.video) {
        activeVideosMap.set(tabId, message.video);
      }
      sendResponse({ success: true });
      break;
    }

    case 'GET_ACTIVE_VIDEO': {
      const targetTabId = message.tabId || tabId;
      const active = targetTabId ? activeVideosMap.get(targetTabId) : null;
      sendResponse({ success: true, activeVideo: active || null });
      break;
    }

    case 'GET_TAB_VIDEOS': {
      const targetTabId = message.tabId || tabId;
      const videos = targetTabId && tabVideosMap.has(targetTabId)
        ? Array.from(tabVideosMap.get(targetTabId).values())
        : [];
      sendResponse({ success: true, videos: videos });
      break;
    }

    case 'DOWNLOAD_VIA_BACKGROUND': {
      const urls = Array.isArray(message.urls)
        ? message.urls.filter(Boolean)
        : (message.url ? [message.url] : []);
      const filename = message.filename || 'douyin_video.mp4';

      if (urls.length === 0) {
        sendResponse({ success: false, error: 'Empty URLs' });
        return true;
      }

      let attemptIdx = 0;
      function tryDownloadNext() {
        if (attemptIdx >= urls.length) {
          console.warn('[Douyin Downloader] All candidate mirror URLs failed for:', filename);
          sendResponse({ success: false, error: 'All CDN mirrors failed' });
          return;
        }

        const targetUrl = urls[attemptIdx++];
        chrome.downloads.download(
          {
            url: targetUrl,
            filename: filename,
            conflictAction: 'uniquify',
            saveAs: false
          },
          (downloadId) => {
            if (chrome.runtime.lastError || !downloadId) {
              console.warn('[Douyin Downloader] Mirror failed (' + targetUrl + '):', chrome.runtime.lastError?.message);
              tryDownloadNext();
            } else {
              console.log('[Douyin Downloader] Background download succeeded with downloadId:', downloadId);
              sendResponse({ success: true, downloadId: downloadId });
            }
          }
        );
      }

      tryDownloadNext();
      return true;
    }

    case 'CLEAR_TAB_VIDEOS': {
      if (tabId && tabVideosMap.has(tabId)) {
        tabVideosMap.delete(tabId);
        activeVideosMap.delete(tabId);
        updateBadge(tabId);
      }
      sendResponse({ success: true });
      break;
    }

    default:
      sendResponse({ success: false });
      break;
  }
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideosMap.delete(tabId);
  activeVideosMap.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    if (tabVideosMap.has(tabId)) {
      tabVideosMap.delete(tabId);
      activeVideosMap.delete(tabId);
      updateBadge(tabId);
    }
  }
});

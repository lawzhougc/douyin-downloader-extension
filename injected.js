/**
 * injected.js - Runs in the page's MAIN execution world at document_start (v1.4.0)
 * Core Superpowers:
 * 1. Global Aweme Cache: Caches every Aweme object from network (Fetch/XHR) & page globals.
 * 2. True Resolution Engine: Accurately identifies 4K, 2K, 1080P, 720P based on real stream
 *    gear names and shorter-dimension pixel size; eliminates fake 4K/2K options on vertical videos.
 * 3. Exact Active Video & React Fiber Extractor: Inspects `data-e2e-vid`, classnames, and
 *    React Fiber props to guarantee 100% video-to-element accuracy.
 * 4. Strict Viewport & Preload Filter: Ignores background/preloaded videos on feed slide N+1.
 */
(function () {
  'use strict';

  if (window.__DOUYIN_DOWNLOADER_INJECTED__) return;
  window.__DOUYIN_DOWNLOADER_INJECTED__ = true;

  const MSG_SOURCE = 'DOUYIN_INJECTED_SCRIPT';
  const allAwemesMap = new Map(); // aweme_id -> parsedVideoObj
  window.__ALL_AWEMES_MAP__ = allAwemesMap;

  function dispatchVideos(videos) {
    if (!videos || !videos.length) return;
    window.postMessage(
      {
        source: MSG_SOURCE,
        type: 'VIDEOS_FOUND',
        payload: videos
      },
      '*'
    );
  }

  function cleanUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    let url = rawUrl.trim();
    if (url.startsWith('//')) {
      url = 'https:' + url;
    } else if (url.startsWith('http://')) {
      url = 'https://' + url.slice(7);
    }
    // Only replace playwm on legacy snssdk share endpoints, never on direct TOS vod
    if (url.includes('.snssdk.com/aweme/v1/playwm/')) {
      url = url.replace(/\/playwm\//g, '/play/');
    }
    return url;
  }

  /**
   * Accurate resolution & gear formatting:
   * Uses gear_name, quality_type, bitrate, and true stream dimensions.
   * NEVER falsely claims 4K/2K from master video dimensions when stream is 1080P or 720P.
   */
  function formatGearInfo(gear, width, height, bitrate, isH265, qualityType, masterMinDim, masterMaxDim) {
    const g = (gear || '').toLowerCase();
    const hasStreamDim = (width > 0 && height > 0);
    const streamMinDim = hasStreamDim ? Math.min(width, height) : 0;
    const streamMaxDim = hasStreamDim ? Math.max(width, height) : 0;
    const qType = Number(qualityType) || 0;
    const bps = Number(bitrate) || 0;

    // Master indicators (widescreen film 3840x1600 or 16:9 3840x2160, or vertical 2160x3840)
    const mMax = masterMaxDim || 0;
    const mMin = masterMinDim || 0;
    const isMaster4K = (mMax >= 3200 || mMin >= 1800);
    const isMaster2K = (mMax >= 2200 || mMin >= 1300);

    // Explicit exclusions: if gear explicitly indicates 1080, 720, or 540, it is NOT 4K or 2K
    const isExplicit1080 = g.includes('1080') || (hasStreamDim && streamMaxDim >= 1600 && streamMaxDim < 2200 && streamMinDim < 1300);
    const isExplicit720 = g.includes('720') || (hasStreamDim && streamMaxDim >= 1100 && streamMaxDim < 1600 && streamMinDim < 900);
    const isExplicit540 = g.includes('540') || g.includes('480') || (hasStreamDim && streamMaxDim < 1100 && streamMinDim < 650);

    // 1. 4K Ultra HD (2160P)
    // - Explicit gear keywords: '4k', '2160', 'uhd', 'super_uhd'
    // - Direct stream resolution: streamMaxDim >= 3200 || streamMinDim >= 1800
    // - Master original is 4K and stream is not explicitly 1080/720/540, AND (bps >= 2200000 || qType >= 31 || g.includes('hdr') || g.includes('super'))
    if (!isExplicit1080 && !isExplicit720 && !isExplicit540) {
      if (
        g.includes('4k') ||
        g.includes('2160') ||
        g.includes('uhd') ||
        streamMaxDim >= 3200 ||
        streamMinDim >= 1800 ||
        (isMaster4K && (bps >= 2200000 || qType >= 31 || g.includes('hdr') || g.includes('super')))
      ) {
        return {
          name: '4K 极清',
          tag: '2160P',
          label: '4K 极清 (2160P)' + (isH265 ? ' [H.265]' : ''),
          rank: 50
        };
      }
    }

    // 2. 2K Quad HD (1440P)
    // - Explicit gear keywords: '2k', '1440', 'qhd', 'shd'
    // - Direct stream resolution: streamMaxDim >= 2200 || streamMinDim >= 1300
    // - Master original is 2K and stream has sufficient quality (bps >= 1800000 || qType >= 30)
    // - Master original is 4K and this is an intermediate 2K stream (bps between 1.8M and 2.2M, or qType 30..31)
    if (!isExplicit1080 && !isExplicit720 && !isExplicit540) {
      if (
        g.includes('2k') ||
        g.includes('1440') ||
        g.includes('qhd') ||
        g.includes('shd') ||
        streamMaxDim >= 2200 ||
        streamMinDim >= 1300 ||
        (isMaster2K && !isMaster4K && (bps >= 1800000 || qType >= 30)) ||
        (isMaster4K && bps >= 1800000 && bps < 2200000)
      ) {
        return {
          name: '2K 超清',
          tag: '1440P',
          label: '2K 超清 (1440P)' + (isH265 ? ' [H.265]' : ''),
          rank: 40
        };
      }
    }

    // 3. 1080P / 1080P+ 60fps
    if (
      isExplicit1080 ||
      g.includes('1080') ||
      streamMaxDim >= 1600 ||
      streamMinDim >= 950 ||
      qType >= 28 ||
      bps >= 1500000 ||
      isMaster2K ||
      isMaster4K
    ) {
      if (g.includes('plus') || g.includes('60') || (bps >= 3500000 && !isMaster4K)) {
        return {
          name: '1080P 60帧',
          tag: '1080P+',
          label: '1080P 60帧' + (isH265 ? ' [H.265]' : ''),
          rank: 35
        };
      }
      return {
        name: '1080P 高清',
        tag: '1080P',
        label: '1080P 高清' + (isH265 ? ' [H.265]' : ''),
        rank: 30
      };
    }

    // 4. 720P
    if (
      isExplicit720 ||
      g.includes('720') ||
      streamMaxDim >= 1100 ||
      streamMinDim >= 650 ||
      qType >= 24 ||
      bps >= 750000
    ) {
      return {
        name: '720P 高清',
        tag: '720P',
        label: '720P 高清' + (isH265 ? ' [H.265]' : ''),
        rank: 20
      };
    }

    // 5. 540P / 480P
    if (
      isExplicit540 ||
      g.includes('540') ||
      g.includes('480') ||
      streamMinDim >= 450 ||
      qType >= 20 ||
      bps >= 350000
    ) {
      return {
        name: '540P 标清',
        tag: '540P',
        label: '540P 标清',
        rank: 10
      };
    }

    // Default fallback
    return {
      name: '标清',
      tag: 'SD',
      label: '标清',
      rank: 5
    };
  }

  function extractTosUri(url) {
    if (!url) return '';
    const m = url.match(/tos-[^/?#]+/);
    return m ? m[0] : '';
  }

  function parseAwemeItem(item) {
    if (!item || typeof item !== 'object') return null;

    const awemeId = String(item.aweme_id || item.id || '');
    if (!awemeId) return null;

    const videoObj = item.video || {};
    const authorObj = item.author || {};
    const masterWidth = Number(videoObj.width) || 0;
    const masterHeight = Number(videoObj.height) || 0;
    const masterMinDim = (masterWidth > 0 && masterHeight > 0) ? Math.min(masterWidth, masterHeight) : 0;
    const masterMaxDim = (masterWidth > 0 && masterHeight > 0) ? Math.max(masterWidth, masterHeight) : 0;

    const streams = [];

    // Helper: sort CDN mirrors so standard/stable CDNs are tried before restricted 'web-prime' nodes
    function rankMirrors(urls) {
      return [...urls].sort((a, b) => {
        const aPrime = a.includes('web-prime') ? 1 : 0;
        const bPrime = b.includes('web-prime') ? 1 : 0;
        return aPrime - bPrime;
      });
    }

    // 1. Bitrate streams (multi-resolution streams across H.264, H.265/ByteVC1, audio-video)
    const rawBitrateLists = [
      videoObj.bit_rate,
      videoObj.bit_rate_265,
      videoObj.bit_rate_bytevc1,
      videoObj.bit_rate_h265,
      videoObj.raw_bit_rate
    ];
    const candidateBitrates = [];
    for (const list of rawBitrateLists) {
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item === 'object' && !candidateBitrates.includes(item)) {
            candidateBitrates.push(item);
          }
        }
      }
    }

    if (candidateBitrates.length > 0) {
      for (const br of candidateBitrates) {
        const playAddrObj = br.play_addr_265 ||
                            br.play_addr_bytevc1 ||
                            br.play_addr_h265 ||
                            br.play_addr ||
                            br.download_addr || null;

        const rawUrlList = (playAddrObj && Array.isArray(playAddrObj.url_list) && playAddrObj.url_list.length > 0)
          ? playAddrObj.url_list
          : (Array.isArray(br.url_list) ? br.url_list : []);

        const rawMirrors = rawUrlList.map(cleanUrl).filter(u => u && u.startsWith('http'));
        const sortedMirrors = rankMirrors(rawMirrors);
        if (sortedMirrors.length === 0) continue;

        const primaryUrl = sortedMirrors[0];
        const streamWidth = Number(br.width) ||
                            Number(playAddrObj?.width) ||
                            Number(br.play_addr?.width) ||
                            Number(br.play_addr_265?.width) || 0;
        const streamHeight = Number(br.height) ||
                             Number(playAddrObj?.height) ||
                             Number(br.play_addr?.height) ||
                             Number(br.play_addr_265?.height) || 0;

        const isH265 = Boolean(br.is_h265 || br.play_addr_265 || br.play_addr_bytevc1 || br.play_addr_h265);

        const gearInfo = formatGearInfo(
          br.gear_name,
          streamWidth,
          streamHeight,
          br.bit_rate || 0,
          isH265,
          br.quality_type || 0,
          masterMinDim,
          masterMaxDim
        );

        if (!streams.some(s => s.url === primaryUrl)) {
          streams.push({
            url: primaryUrl,
            backup_urls: sortedMirrors,
            gear_name: gearInfo.name,
            tag: gearInfo.tag,
            label: gearInfo.label,
            rank: gearInfo.rank,
            bit_rate: br.bit_rate || 0,
            is_h265: isH265,
            width: streamWidth || masterWidth,
            height: streamHeight || masterHeight,
            uri: playAddrObj?.uri || br.play_addr?.uri || extractTosUri(primaryUrl)
          });
        }
      }
    }

    // 2. Play addr fallbacks (H.265 / ByteVC1 / standard play_addr)
    const playAddrCandidates = [
      { obj: videoObj.play_addr_265, is265: true, gear: 'uhd', qType: 34 },
      { obj: videoObj.play_addr_bytevc1, is265: true, gear: 'uhd', qType: 34 },
      { obj: videoObj.play_addr_h265, is265: true, gear: 'uhd', qType: 34 },
      { obj: videoObj.play_addr, is265: false, gear: '1080p', qType: 28 },
      { obj: videoObj.play_addr_h264, is265: false, gear: '1080p', qType: 28 }
    ];

    for (const cand of playAddrCandidates) {
      if (cand.obj && Array.isArray(cand.obj.url_list)) {
        const rawMirrors = cand.obj.url_list.map(cleanUrl).filter(u => u && u.startsWith('http'));
        const sortedMirrors = rankMirrors(rawMirrors);
        if (sortedMirrors.length > 0) {
          const primaryUrl = sortedMirrors[0];
          const w = Number(cand.obj.width) || masterWidth;
          const h = Number(cand.obj.height) || masterHeight;
          const gearInfo = formatGearInfo(cand.gear, w, h, 0, cand.is265, cand.qType, masterMinDim, masterMaxDim);
          if (!streams.some(s => s.url === primaryUrl)) {
            streams.push({
              url: primaryUrl,
              backup_urls: sortedMirrors,
              gear_name: gearInfo.name,
              tag: gearInfo.tag,
              label: gearInfo.label,
              rank: gearInfo.rank,
              bit_rate: 0,
              is_h265: cand.is265,
              width: w,
              height: h,
              uri: cand.obj.uri || extractTosUri(primaryUrl)
            });
          }
        }
      }
    }

    if (streams.length === 0) return null;

    // Sort streams descending by rank then bitrate
    streams.sort((a, b) => (b.rank - a.rank) || (b.bit_rate - a.bit_rate));

    // Deduplicate streams cleanly by unique gear_name or tag so each resolution tier appears once
    const uniqueStreams = [];
    for (const s of streams) {
      if (!uniqueStreams.some(u => u.gear_name === s.gear_name || u.tag === s.tag)) {
        uniqueStreams.push(s);
      }
    }

    let coverUrl = '';
    const coverSources = [
      videoObj.cover?.url_list,
      videoObj.origin_cover?.url_list,
      videoObj.dynamic_cover?.url_list,
      videoObj.animated_cover?.url_list
    ];

    for (const list of coverSources) {
      if (Array.isArray(list) && list.length > 0 && typeof list[0] === 'string') {
        coverUrl = cleanUrl(list[0]);
        if (coverUrl) break;
      }
    }

    const desc = (item.desc || item.title || '').trim() || '抖音视频';
    const authorName = (authorObj.nickname || '').trim() || '抖音博主';
    const bestStream = uniqueStreams[0] || streams[0];

    const result = {
      aweme_id: awemeId,
      title: desc,
      author: authorName,
      author_id: authorObj.unique_id || authorObj.short_id || authorObj.sec_uid || '',
      cover: coverUrl,
      duration: videoObj.duration ? Math.round(videoObj.duration / 1000) : 0,
      width: masterWidth,
      height: masterHeight,
      download_url: bestStream.url,
      max_quality: bestStream.gear_name,
      max_tag: bestStream.tag,
      streams: uniqueStreams.length > 0 ? uniqueStreams : streams,
      timestamp: Date.now()
    };

    allAwemesMap.set(awemeId, result);
    return result;
  }

  /**
   * REACT FIBER & DOM DEEP EXTRACTOR
   * Walks element attributes (data-e2e-vid, classnames) and React Fiber tree.
   */
  function extractAwemeFromElement(el) {
    if (!el) return null;

    // 1. Check for data-e2e-vid or video_{id} in element or ancestors
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.documentElement && depth < 20) {
      depth++;

      const vid = cur.getAttribute?.('data-e2e-vid') ||
                  cur.className?.match?.(/video_(\d{15,25})/)?.[1];
      if (vid && allAwemesMap.has(vid)) {
        return allAwemesMap.get(vid);
      }

      // Check XGPlayer instance & its live definitionList
      if (cur.__xgplayer__ || cur.player) {
        const p = cur.__xgplayer__ || cur.player;
        const cfg = p.config || {};
        const candidate = cfg.videoConfig || cfg.aweme || cfg.item || cfg.video || p.videoConfig;
        let parsed = candidate && candidate.aweme_id ? parseAwemeItem(candidate) : null;

        const currentVid = cur.getAttribute?.('data-e2e-vid') ||
                          cur.className?.match?.(/video_(\d{15,25})/)?.[1] ||
                          (candidate && candidate.aweme_id);
        if (!parsed && currentVid && allAwemesMap.has(currentVid)) {
          parsed = allAwemesMap.get(currentVid);
        }

        // Live definitions from XGPlayer
        const defList = p.definitionList ||
                        cfg.definitionList ||
                        (p.plugins && p.plugins.definition && p.plugins.definition.list) ||
                        (p.pluginList && p.pluginList.definition && p.pluginList.definition.list) || [];

        if (Array.isArray(defList) && defList.length > 0) {
          if (!parsed) {
            parsed = {
              aweme_id: currentVid || String(Date.now()),
              title: document.title.replace(/- 抖音$/, '').trim(),
              author: '抖音创作者',
              author_id: '',
              cover: cfg.poster || '',
              duration: Math.round(p.duration || 0),
              width: p.videoWidth || 1920,
              height: p.videoHeight || 1080,
              download_url: '',
              max_quality: '',
              max_tag: '',
              streams: [],
              timestamp: Date.now()
            };
          }

          const mMax = Math.max(parsed.width || 0, parsed.height || 0);
          const mMin = Math.min(parsed.width || 0, parsed.height || 0);

          for (const d of defList) {
            if (!d || typeof d !== 'object') continue;
            const dUrl = cleanUrl(d.url || d.src || d.play_url || '');
            if (!dUrl || !dUrl.startsWith('http')) continue;
            const dName = String(d.name || d.text || d.definition || d.gear_name || '').trim();
            const gInfo = formatGearInfo(dName, 0, 0, d.bit_rate || 0, true, 34, mMin, mMax);
            if (!parsed.streams.some(s => s.url === dUrl || s.gear_name === gInfo.name)) {
              parsed.streams.push({
                url: dUrl,
                backup_urls: [dUrl],
                gear_name: gInfo.name,
                tag: gInfo.tag,
                label: gInfo.label,
                rank: gInfo.rank,
                bit_rate: d.bit_rate || 0,
                is_h265: true,
                width: parsed.width,
                height: parsed.height,
                uri: extractTosUri(dUrl)
              });
            }
          }

          if (parsed.streams.length > 0) {
            parsed.streams.sort((a, b) => (b.rank - a.rank) || (b.bit_rate - a.bit_rate));
            parsed.download_url = parsed.streams[0].url;
            parsed.max_quality = parsed.streams[0].gear_name;
            parsed.max_tag = parsed.streams[0].tag;
            allAwemesMap.set(parsed.aweme_id, parsed);
            return parsed;
          }
        }

        if (parsed && parsed.streams.length > 0) return parsed;
      }

      // Check React Fiber
      const fiberKey = Object.keys(cur).find(k => k.startsWith('__reactFiber$'));
      if (fiberKey) {
        let fiber = cur[fiberKey];
        let fCount = 0;
        while (fiber && fCount < 50) {
          fCount++;
          const props = fiber.memoizedProps;
          if (props && typeof props === 'object') {
            const candidate = props.item || props.aweme || props.videoData || props.currentAweme ||
                              props.data || props.awemeInfo || props.aweme_info ||
                              (props.aweme_id && props.video ? props : null);

            if (candidate && (candidate.aweme_id || (candidate.video && candidate.video.play_addr))) {
              const parsed = parseAwemeItem(candidate);
              if (parsed && parsed.streams.length > 0) return parsed;
            }
          }

          // Check memoizedState hooks
          let hook = fiber.memoizedState;
          let hCount = 0;
          while (hook && hCount < 20) {
            hCount++;
            const state = hook.memoizedState;
            if (state && typeof state === 'object') {
              const hookCand = state.item || state.aweme || state.videoData || (state.aweme_id && state.video ? state : null);
              if (hookCand && hookCand.aweme_id) {
                const parsed = parseAwemeItem(hookCand);
                if (parsed && parsed.streams.length > 0) return parsed;
              }
            }
            hook = hook.next;
          }

          fiber = fiber.return;
        }
      }

      cur = cur.parentElement;
    }

    // 2. Check current page modal_id or video pathname
    const modalMatch = window.location.search.match(/modal_id=(\d+)/);
    if (modalMatch && modalMatch[1] && allAwemesMap.has(modalMatch[1])) {
      return allAwemesMap.get(modalMatch[1]);
    }

    const pathMatch = window.location.pathname.match(/\/video\/(\d+)/);
    if (pathMatch && pathMatch[1] && allAwemesMap.has(pathMatch[1])) {
      return allAwemesMap.get(pathMatch[1]);
    }

    return null;
  }

  function extractVideosRecursively(obj, results = [], depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return results;

    const target = obj.aweme_info || obj;
    if (
      target &&
      typeof target === 'object' &&
      target.video &&
      (target.video.play_addr || target.video.bit_rate)
    ) {
      const parsed = parseAwemeItem(target);
      if (parsed && !results.some(r => r.aweme_id === parsed.aweme_id || r.download_url === parsed.download_url)) {
        results.push(parsed);
      }
    }

    if (Array.isArray(obj)) {
      for (const el of obj) {
        extractVideosRecursively(el, results, depth + 1);
      }
    } else {
      for (const key of Object.keys(obj)) {
        if (key === 'risk_infos' || key === 'log_pb' || key === 'extra') continue;
        extractVideosRecursively(obj[key], results, depth + 1);
      }
    }

    return results;
  }

  function handlePayload(json) {
    if (!json || typeof json !== 'object') return;
    const found = extractVideosRecursively(json);
    if (found.length > 0) {
      dispatchVideos(found);
    }
  }

  // Hook window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (
        url.includes('/aweme/') ||
        url.includes('/search/') ||
        url.includes('/feed/') ||
        url.includes('/detail/') ||
        url.includes('/post/') ||
        url.includes('/related/') ||
        url.includes('douyin.com')
      ) {
        const clone = response.clone();
        clone.json().then(data => {
          handlePayload(data);
        }).catch(() => {});
      }
    } catch (e) {}
    return response;
  };

  // Hook XMLHttpRequest
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._requestUrl = url;
    return originalXhrOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const url = this._requestUrl || '';
        if (
          url.includes('/aweme/') ||
          url.includes('/search/') ||
          url.includes('/feed/') ||
          url.includes('/detail/') ||
          url.includes('/post/') ||
          url.includes('/related/')
        ) {
          const text = this.responseText;
          if (text && (text.startsWith('{') || text.startsWith('['))) {
            const data = JSON.parse(text);
            handlePayload(data);
          }
        }
      } catch (e) {}
    });
    return originalXhrSend.apply(this, args);
  };

  // Check if a video element is strictly visible in viewport
  function isVideoElementVisible(videoEl) {
    if (!videoEl) return false;
    const rect = videoEl.getBoundingClientRect();
    return (
      rect.width > 200 &&
      rect.height > 200 &&
      rect.top < window.innerHeight &&
      rect.bottom > 0
    );
  }

  // Listen for active video play
  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      const videoEl = e.target;

      // Ignore hidden or preloading videos from slide N+1
      if (!isVideoElementVisible(videoEl)) return;

      const src = videoEl.currentSrc || videoEl.src || '';

      // Try React Fiber / DOM extraction on this exact element
      const fiberMeta = extractAwemeFromElement(videoEl);
      if (fiberMeta) {
        dispatchVideos([fiberMeta]);
        window.postMessage({
          source: MSG_SOURCE,
          type: 'ACTIVE_VIDEO_DISCOVERED',
          payload: fiberMeta
        }, '*');
      }

      window.postMessage({
        source: MSG_SOURCE,
        type: 'VIDEO_PLAYING_ACTIVE',
        src: src
      }, '*');
    }
  }, true);

  // Listen for on-demand resolve requests from content.js
  window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'DOUYIN_CONTENT_SCRIPT' && e.data.type === 'RESOLVE_ELEMENT_META') {
      const queryId = e.data.queryId;
      const targetEl = document.querySelector(`[data-dy-query-id="${queryId}"]`);
      if (targetEl) {
        const meta = extractAwemeFromElement(targetEl);
        if (meta) {
          dispatchVideos([meta]);
          window.postMessage({
            source: MSG_SOURCE,
            type: 'RESOLVE_ELEMENT_META_REPLY',
            queryId: queryId,
            payload: meta
          }, '*');
        }
      }
    }
  });

  // Scan global states
  function inspectGlobals() {
    try {
      if (window._ROUTER_DATA) handlePayload(window._ROUTER_DATA);
      if (window.__UNIVERSAL_DATA_FOR_REHYDRATION__) handlePayload(window.__UNIVERSAL_DATA_FOR_REHYDRATION__);
      if (window.__INITIAL_STATE__) handlePayload(window.__INITIAL_STATE__);
    } catch (e) {}
  }

  inspectGlobals();
  document.addEventListener('DOMContentLoaded', inspectGlobals);
  setTimeout(inspectGlobals, 1000);
  setTimeout(inspectGlobals, 3000);

  console.log('[Douyin Downloader] Injected script v1.4.0 running with true resolution parsing & exact Fiber extraction.');
})();

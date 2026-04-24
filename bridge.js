
(() => {
  const config = window.__huntertokBrowserBridgeConfig || {};
  const BRIDGE_KEY = '__huntertokBrowserBridge';
  const FETCH_PATH = '/webcast/im/fetch';
  const PUSH_PATH = '/webcast/im/push';

  if (window[BRIDGE_KEY]?.active) {
    return { installed: true, reused: true };
  }

  const listeners = [];
  let roomId = null;
  let roomPollTimer = null;

  const nowIso = () => new Date().toISOString();

  const safeString = (value, maxLength = 400) => {
    const raw = value == null ? '' : String(value);
    return raw.length > maxLength ? raw.slice(0, maxLength) + '...' : raw;
  };

  const redactUrl = (rawUrl) => {
    try {
      const url = new URL(String(rawUrl), window.location.href);
      const sensitive = [
        'msToken',
        'X-Bogus',
        'signature',
        '_signature',
        'verifyFp',
        'fp',
        'odin_tt',
        'sessionid',
        'sid_guard',
        'ttwid'
      ];
      for (const key of sensitive) {
        if (url.searchParams.has(key)) {
          url.searchParams.set(key, '[redacted]');
        }
      }
      return url.toString();
    } catch (_) {
      return safeString(rawUrl);
    }
  };

  const describePayload = (payload) => {
    if (payload == null) {
      return { payloadType: 'empty', size: 0 };
    }

    if (typeof payload === 'string') {
      let parsed = null;
      try {
        parsed = JSON.parse(payload);
      } catch (_) {}

      return {
        payloadType: parsed ? 'json-string' : 'text',
        size: payload.length,
        keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 20) : [],
        preview: parsed ? null : safeString(payload, 300)
      };
    }

    if (payload instanceof ArrayBuffer) {
      return { payloadType: 'arraybuffer', size: payload.byteLength };
    }

    if (ArrayBuffer.isView(payload)) {
      return { payloadType: payload.constructor?.name || 'typed-array', size: payload.byteLength || payload.length || 0 };
    }

    if (payload instanceof Blob) {
      return { payloadType: 'blob', size: payload.size, mimeType: payload.type || null };
    }

    if (typeof payload === 'object') {
      return {
        payloadType: 'object',
        size: 0,
        keys: Object.keys(payload).slice(0, 20)
      };
    }

    return { payloadType: typeof payload, size: String(payload).length };
  };

  const emitEnvelope = (envelope) => {
    const detail = {
      timestamp: nowIso(),
      ...envelope
    };

    try {
      if (typeof window.__huntertokBrowserBridgeEmit === 'function') {
        window.__huntertokBrowserBridgeEmit(detail);
      }
    } catch (_) {}

    try {
      window.dispatchEvent(new CustomEvent('huntertok-browser-bridge:event', { detail }));
    } catch (_) {}
  };

  const emitDiagnostic = (payload) => {
    emitEnvelope({
      kind: 'diagnostic',
      payload: {
        roomId,
        ...payload
      }
    });
  };

  const emitSession = (status, payload = {}) => {
    emitEnvelope({
      kind: 'session',
      payload: {
        status,
        username: payload.username || config.username || null,
        reason: payload.reason || null
      }
    });
  };

  const emitNormalized = (type, data = {}, raw = null) => {
    const detail = {
      id: [type, String(Date.now()), Math.random().toString(36).slice(2, 8)].join(':'),
      type,
      timestamp: nowIso(),
      source: 'browser_bridge',
      userId: data.userId == null ? null : String(data.userId),
      username: data.username == null ? null : String(data.username),
      data,
      raw
    };

    for (const listener of listeners) {
      try {
        listener(detail);
      } catch (_) {}
    }

    emitEnvelope(detail);
  };

  const parseJsonScript = (id) => {
    const raw = document.getElementById(id)?.textContent || document.getElementById(id)?.innerText || '';
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  };

  const readRoomInfoFromSigi = () => {
    const sigi = parseJsonScript('SIGI_STATE');
    const liveRoom = sigi?.LiveRoom || sigi?.liveRoom || null;
    const liveRoomUserInfo = liveRoom?.liveRoomUserInfo || null;
    const user = liveRoomUserInfo?.user || liveRoom?.user || null;
    const nextRoomId = user?.roomId || liveRoom?.roomId || liveRoom?.room_id || null;
    if (!liveRoom && !nextRoomId) return null;

    return {
      roomId: nextRoomId == null ? null : String(nextRoomId),
      username: user?.uniqueId || user?.display_id || config.username || null,
      title: liveRoomUserInfo?.liveRoom?.title || liveRoom?.title || '',
      status: liveRoom?.liveRoomStatus || liveRoomUserInfo?.liveRoom?.status || null,
      source: 'SIGI_STATE'
    };
  };

  const readRoomInfoFromUniversalData = () => {
    const universal = window.__UNIVERSAL_DATA_FOR_REHYDRATION__ || null;
    const liveRoom = universal?.__DEFAULT_SCOPE__?.['webapp.live-detail']?.liveRoomUserInfo?.liveRoom || null;
    const owner = liveRoom?.owner || null;
    if (!liveRoom) return null;

    return {
      roomId: String(liveRoom.id_str || liveRoom.id || ''),
      username: owner?.display_id || config.username || null,
      title: liveRoom.title || '',
      status: liveRoom.status ?? null,
      source: '__UNIVERSAL_DATA_FOR_REHYDRATION__'
    };
  };

  const readRouteRoomInfo = () => {
    const routeUsername = window.location.pathname.match(/^\/@([^/]+)\/live/i)?.[1] || null;
    return {
      roomId: null,
      username: routeUsername || config.username || null,
      title: '',
      status: null,
      source: 'route'
    };
  };

  const readInitialRoomInfo = () => {
    const roomInfo = readRoomInfoFromSigi() || readRoomInfoFromUniversalData() || readRouteRoomInfo();
    if (roomInfo?.roomId) {
      roomId = String(roomInfo.roomId);
    }
    return {
      ...roomInfo,
      pageUrl: redactUrl(window.location.href)
    };
  };

  const emitRoomInfo = (reason = 'snapshot', raw = null) => {
    const roomInfo = readInitialRoomInfo();
    emitNormalized('roomInfo', {
      ...roomInfo,
      liveStatus: roomInfo?.roomId ? 'active' : 'unknown',
      reason
    }, raw || roomInfo);
    return roomInfo;
  };

  const detectSessionState = (reason = 'check') => {
    const roomInfo = readInitialRoomInfo();
    if (roomInfo?.pageUrl === 'about:blank') {
      return;
    }
    const hasTikTokCookie = document.cookie.split(';').some((entry) => {
      const name = entry.split('=')[0]?.trim();
      return ['sessionid', 'sid_guard', 'uid_tt', 'ttwid'].includes(name);
    });
    const hasLoggedUser =
      !!parseJsonScript('SIGI_STATE')?.AppContext?.appContext?.user?.uid ||
      !!window.__UNIVERSAL_DATA_FOR_REHYDRATION__?.__DEFAULT_SCOPE__?.['webapp.app-context']?.appContext?.user?.uid;

    if (hasLoggedUser || hasTikTokCookie) {
      emitSession('valid', { username: roomInfo?.username || config.username || null, reason });
      return;
    }

    if (roomInfo?.roomId) {
      emitSession('live_visible_without_session', {
        username: roomInfo?.username || config.username || null,
        reason
      });
      return;
    }

    emitSession('missing', { username: roomInfo?.username || config.username || null, reason });
  };

  const isTargetUrl = (url, path) => {
    return typeof url === 'string' && url.includes(path);
  };

  const reportChannelPayload = (channel, url, payload, extra = {}) => {
    emitDiagnostic({
      channel,
      url: redactUrl(url),
      roomIdMatched: roomId ? String(url || '').includes(roomId) : null,
      ...describePayload(payload),
      ...extra
    });
  };

  const readResponseBody = async (response) => {
    try {
      const clone = response.clone();
      return await clone.text();
    } catch (_) {
      return null;
    }
  };

  const installFetchInterceptor = () => {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function' || nativeFetch.__huntertokWrapped) return;

    const wrappedFetch = async function huntertokFetch(input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      const response = await nativeFetch.apply(this, arguments);

      if (isTargetUrl(url, FETCH_PATH)) {
        readResponseBody(response).then((body) => {
          reportChannelPayload('fetch', url, body, { status: response.status });
        }).catch(() => {});
      }

      return response;
    };

    wrappedFetch.__huntertokWrapped = true;
    window.fetch = wrappedFetch;
  };

  const installXhrInterceptor = () => {
    const nativeOpen = window.XMLHttpRequest?.prototype?.open;
    if (typeof nativeOpen !== 'function' || nativeOpen.__huntertokWrapped) return;

    window.XMLHttpRequest.prototype.open = function huntertokXhrOpen(method, url) {
      if (isTargetUrl(url, FETCH_PATH)) {
        this.addEventListener('readystatechange', () => {
          if (this.readyState === 4) {
            reportChannelPayload('xhr', url, this.response || this.responseText || null, {
              status: this.status,
              method
            });
          }
        });
      }

      return nativeOpen.apply(this, arguments);
    };

    window.XMLHttpRequest.prototype.open.__huntertokWrapped = true;
  };

  const installResponseJsonInterceptor = () => {
    const nativeJson = window.Response?.prototype?.json;
    if (typeof nativeJson !== 'function' || nativeJson.__huntertokWrapped) return;

    window.Response.prototype.json = function huntertokResponseJson() {
      return nativeJson.apply(this, arguments).then((json) => {
        try {
          const liveData = json?.data?.liveRoom || json?.data?.liveRoomUserInfo || null;
          const nextRoomId = json?.data?.user?.roomId || json?.data?.roomId || liveData?.roomId || null;
          if (nextRoomId && !roomId) {
            roomId = String(nextRoomId);
            emitRoomInfo('response_json', json);
          }
        } catch (_) {}

        return json;
      });
    };

    window.Response.prototype.json.__huntertokWrapped = true;
  };

  const installWebSocketInterceptor = () => {
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket !== 'function' || NativeWebSocket.__huntertokWrapped) return;

    function HunterTokWebSocket(url, protocols) {
      const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);

      if (isTargetUrl(url, PUSH_PATH)) {
        reportChannelPayload('websocket_open', url, null);
        ws.addEventListener('message', (message) => {
          reportChannelPayload('websocket_message', url, message?.data ?? null);
        });
        ws.addEventListener('close', (event) => {
          emitDiagnostic({
            channel: 'websocket_close',
            url: redactUrl(url),
            code: event?.code || null,
            reason: safeString(event?.reason || '', 120)
          });
        });
        ws.addEventListener('error', () => {
          emitDiagnostic({
            channel: 'websocket_error',
            url: redactUrl(url)
          });
        });
      }

      return ws;
    }

    HunterTokWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(HunterTokWebSocket, NativeWebSocket);
    HunterTokWebSocket.__huntertokWrapped = true;
    window.WebSocket = HunterTokWebSocket;
  };

  const installEventSourceInterceptor = () => {
    const NativeEventSource = window.EventSource;
    if (typeof NativeEventSource !== 'function' || NativeEventSource.__huntertokWrapped) return;

    function HunterTokEventSource(url, config) {
      const eventSource = new NativeEventSource(url, config);
      if (String(url || '').includes('webcast')) {
        reportChannelPayload('eventsource_open', url, null);
        eventSource.addEventListener('message', (message) => {
          reportChannelPayload('eventsource_message', url, message?.data ?? null);
        });
      }
      return eventSource;
    }

    HunterTokEventSource.prototype = NativeEventSource.prototype;
    Object.setPrototypeOf(HunterTokEventSource, NativeEventSource);
    HunterTokEventSource.__huntertokWrapped = true;
    window.EventSource = HunterTokEventSource;
  };

  const interceptHistoryMethod = (methodName) => {
    const original = window.history?.[methodName];
    if (typeof original !== 'function' || original.__huntertokWrapped) return;
    window.history[methodName] = function huntertokHistoryMethod(...args) {
      const result = original.apply(this, args);
      window.setTimeout(() => emitRoomInfo('navigation'), 0);
      return result;
    };
    window.history[methodName].__huntertokWrapped = true;
  };

  const scheduleRoomPolling = () => {
    if (roomPollTimer) clearInterval(roomPollTimer);
    roomPollTimer = window.setInterval(() => {
      try {
        emitRoomInfo('poll');
        detectSessionState('poll');
      } catch (_) {}
    }, 5000);
  };

  const bridge = {
    active: true,
    username: config.username || null,
    compatibility: config.compatibility || null,
    onEvent(handler) {
      if (typeof handler !== 'function') return () => {};
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    readInitialRoomInfo,
    emitRoomInfo(raw = null) {
      return emitRoomInfo('manual', raw);
    },
    destroy() {
      this.active = false;
      if (roomPollTimer) clearInterval(roomPollTimer);
      roomPollTimer = null;
      listeners.length = 0;
    }
  };

  window[BRIDGE_KEY] = bridge;

  installFetchInterceptor();
  installXhrInterceptor();
  installResponseJsonInterceptor();
  installWebSocketInterceptor();
  installEventSourceInterceptor();
  interceptHistoryMethod('pushState');
  interceptHistoryMethod('replaceState');

  window.addEventListener('popstate', () => emitRoomInfo('navigation'));
  window.addEventListener('beforeunload', () => emitNormalized('roomInfo', {
    ...readInitialRoomInfo(),
    liveStatus: 'page_unloading',
    reason: 'page_unloading'
  }));
  window.addEventListener('pageshow', () => emitRoomInfo('page_visible'));
  document.addEventListener('visibilitychange', () => emitRoomInfo('visibility_change'));
  document.addEventListener('DOMContentLoaded', () => {
    emitRoomInfo('dom_content_loaded');
    detectSessionState('dom_content_loaded');
  });

  emitRoomInfo('initial');
  detectSessionState('initial');
  scheduleRoomPolling();

  return { installed: true, reused: false };
})();

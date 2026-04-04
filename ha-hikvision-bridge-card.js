/* UI Split Patch 2.6.1 */

class HikvisionPTZCard extends HTMLElement {
  setConfig(config) {
    this.config = {
      title: "ha-hikvision-bridge-card",
      speed: 50,
      lens_step: 60,
      repeat_ms: 350,
      ptz_duration: 300,
      lens_duration: 180,
      lens_stop_safeguard: false,
      refocus_step: 40,
      auto_discover: true,
      video_mode: "rtsp_direct",
      controls_mode: "always",
      accent_color: "var(--primary-color)",
      panel_tint: "8",
      show_camera_info: true,
      show_stream_info: true,
      show_dvr_info: true,
      show_storage_info: true,
      show_camera_chips: true,
      show_status_pills: true,
      show_alarm_dashboard: true,
      show_stream_mode_info: true,
      show_controls: true,
      show_title: true,
      show_position_info: true,
      speed_orientation: "vertical",
      speed_position: "right",
      ptz_steps: { pan: 5, tilt: 5, zoom: 5 },
      return_step_delay: 150,
      cameras: [],
      show_playback_panel: true,
      playback_presets: [1, 5, 10, 30, 60, 300, 600, 3600],
      speaker_default: false,
      volume_default: 100,
      audio_boost: 100,
      talk_mode: "hold",
      mute_during_talk: true,
      show_audio_controls: true,
      debug: {
        enabled: false,
        default_open: false,
        max_entries: 150,
        categories: ["audio", "playback", "video", "backend"],
        levels: ["error", "warn", "info", "debug"],
      },
      ...config,
    };
    this.config.debug = this._normalizeDebugConfig(this.config);
    this.selected = 0;
    this._repeatHandle = null;
    this._videoCard = null;
    this._videoCardConfig = this._videoCardConfig || null;
    this._controlsVisible = this.config.show_controls === false ? false : this.config.controls_mode !== "toggle";
    this._ptzStateMap = this._ptzStateMap || {};
    this._playbackStateMap = this._playbackStateMap || {};
    this._returningHome = false;
    this._speakerEnabled = this._speakerEnabled ?? Boolean(this.config.speaker_default);
    this._volume = Number.isFinite(this._volume) ? this._volume : Math.max(0, Math.min(100, Number(this.config.volume_default ?? 100)));
    this._audioBoost = Number.isFinite(this._audioBoost) ? this._audioBoost : Math.max(100, Math.min(300, Number(this.config.audio_boost ?? 100)));
    this._talkRequested = this._talkRequested ?? false;
    this._talkLatched = this._talkLatched ?? false;
    this._audioMeterLevel = this._audioMeterLevel ?? 0;
    this._audioMeterRaf = this._audioMeterRaf || null;
    this._audioGraph = this._audioGraph || null;
    this._audioGraphElement = this._audioGraphElement || null;
    this._talkPc = this._talkPc || null;
    this._talkWs = this._talkWs || null;
    this._talkStream = this._talkStream || null;
    this._talkActive = this._talkActive || false;
    this._talkHoldActive = this._talkHoldActive || false;
    this._talkReleaseCleanup = this._talkReleaseCleanup || null;
    this._subscribeDebug();
    this._audioDebugLog = Array.isArray(this._audioDebugLog) ? this._audioDebugLog : [];
    this._audioDebugSeq = Number.isFinite(this._audioDebugSeq) ? this._audioDebugSeq : 0;
    this._audioDebugStatus = this._audioDebugStatus || { requested: false, active: false, ws: "idle", pc: "idle", ice: "idle", signaling: "stable", mic: "idle", last_error: "" };
    this._debugEntries = Array.isArray(this._debugEntries) ? this._debugEntries : [];
    this._debugSeq = Number.isFinite(this._debugSeq) ? this._debugSeq : 0;
    this._debugFilters = this._debugFilters || { categories: ["all"], levels: ["all"] };
    this._debugDashboardOpen = this._debugDashboardOpen ?? (this.config?.debug?.default_open === true);
  }

  set hass(hass) {
    this._hass = hass;
    if (this._videoCard) this._videoCard.hass = hass;
    this.render();
    if (!this._debugSubscribed) {
    this._subscribeDebug();
  }
  }


  disconnectedCallback() {
    if (typeof this._debugUnsubscribe === "function") {
      try { this._debugUnsubscribe(); } catch (err) {}
    }
    this._debugUnsubscribe = null;
    this._debugSubscribed = false;
    this.stopMove();
    this._videoSignature = null;
    this._talkRequested = false;
    this._talkLatched = false;
    this._detachTalkReleaseListeners();
    this._stopTalkbackDirect();
    this._teardownAudioGraph();
    this._cleanupVideoCard();
  }

  stopRepeater() {
    this.stopMove();
  }

  _cleanupVideoCard() {
    const card = this._videoCard;
    this._videoCard = null;
    this._videoCardConfig = null;
    this._videoCardConfig = this._videoCardConfig || null;
    if (!card) return;
    try {
      if (typeof card.remove === "function") card.remove();
      else if (card.parentNode) card.parentNode.removeChild(card);
    } catch (err) {}
  }

  _preserveVideoHost() {
    const host = this.querySelector("#hikvision-video-host");
    if (!host) return null;
    host.removeAttribute("id");
    return host;
  }

  _restorePreservedVideoHost(host) {
    if (!host) return;
    const placeholder = this.querySelector("#hikvision-video-host");
    if (!placeholder || placeholder === host) {
      host.id = "hikvision-video-host";
      return;
    }
    placeholder.replaceWith(host);
    host.id = "hikvision-video-host";
  }

  _buildWebRtcCardConfig(url, playbackMode = false) {
    return {
      type: "custom:webrtc-camera",
      url,
      mode: "webrtc",
      media: "video,audio",
      muted: !this._speakerEnabled,
      ui: true,
      background: true,
    };
  }

  _syncWebRtcCardConfig(playbackMode = false) {
    const card = this._videoCard;
    const current = this._videoCardConfig;
    if (!card || !current || current.type !== "custom:webrtc-camera") return;
    const next = this._buildWebRtcCardConfig(current.url, playbackMode);
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    this._videoCardConfig = next;
    try {
      if (typeof card.setConfig === "function") card.setConfig(next);
      card.hass = this._hass;
    } catch (err) {}
  }

  _computeStreamName() {
    const refs = this.getRefs?.() || {};
    const entityId = refs.camera || this.config.entity || this.config.camera_entity || "";
    return String(entityId || "")
      .replace(/^camera\./, "")
      .replace(/[^a-zA-Z0-9_.:-]/g, "_") || "hikvision_cam";
  }

  _normalizeDebugConfig(config = {}) {
    const incoming = config?.debug && typeof config.debug === "object" ? config.debug : {};
    const legacyEnabled = config?.show_audio_debug === true || config?.show_playback_debug === true;
    const categories = Array.isArray(incoming.categories) && incoming.categories.length ? incoming.categories.map((value) => String(value || "").toLowerCase()) : ["audio", "playback", "video", "backend"];
    const levels = Array.isArray(incoming.levels) && incoming.levels.length ? incoming.levels.map((value) => String(value || "").toLowerCase()) : ["error", "warn", "info", "debug"];
    return {
      enabled: incoming.enabled === true || legacyEnabled,
      default_open: incoming.default_open === true,
      max_entries: Math.max(25, Math.min(500, Number(incoming.max_entries ?? 150) || 150)),
      categories: Array.from(new Set(categories)),
      levels: Array.from(new Set(levels)),
    };
  }

  isDebugEnabled() {
    return this.config?.debug?.enabled === true;
  }

  _sanitizeDebugValue(value) {
    let text = value == null ? "" : String(value);
    text = text.replace(/(rtsp:\/\/)([^\s@]+)@/gi, "$1<redacted>@");
    text = text.replace(/(authSig=)[^&\s]+/gi, "$1<redacted>");
    text = text.replace(/(authorization["']?\s*[:=]\s*["']?)[^\s"']+/gi, "$1<redacted>");
    return text;
  }

  _sanitizeDebugObject(value) {
    if (value == null) return value;
    if (Array.isArray(value)) return value.map((item) => this._sanitizeDebugObject(item));
    if (typeof value === "object") {
      const next = {};
      Object.entries(value).forEach(([key, raw]) => {
        const lower = String(key || "").toLowerCase();
        if (["password", "authorization", "authsig", "token", "access_token", "username"].includes(lower)) {
          next[key] = "<redacted>";
        } else {
          next[key] = this._sanitizeDebugObject(raw);
        }
      });
      return next;
    }
    return typeof value === "string" ? this._sanitizeDebugValue(value) : value;
  }

  _debugEventLevelFromData(event = "", details = {}) {
    const name = String(event || "").toLowerCase();
    if (details?.error || /fail|error|denied|missing|closed/.test(name)) return "error";
    if (/warn|fallback|pause|stop/.test(name)) return "warn";
    if (/request|selected|created|open|received|active|start|resume|seek|switch|loaded/.test(name)) return "info";
    return "debug";
  }

  _pushDebug(category = "general", level = "info", event = "event", message = "", details = {}, source = "frontend") {
    const entry = {
      idx: ++this._debugSeq,
      time: new Date().toISOString(),
      category: String(category || "general").toLowerCase(),
      level: String(level || "info").toLowerCase(),
      source: String(source || "frontend").toLowerCase(),
      event: String(event || "event"),
      message: String(message || event || "Event"),
      camera: this.selectedCamera?.channel != null ? String(this.selectedCamera.channel) : "",
      details: this._sanitizeDebugObject(details || {}),
    };
    const maxEntries = Number(this.config?.debug?.max_entries ?? 150) || 150;
    this._debugEntries = [...(this._debugEntries || []), entry].slice(-maxEntries);
    return entry;
  }

_subscribeDebug() {
  if (!this._hass || this._debugSubscribed) return;

  this._debugSubscribed = true;

  this._debugUnsubscribe = this._hass.connection.subscribeMessage(
    (msg) => {
      const event = msg?.event;
      if (!event) return;

      const entry = this._buildBackendDebugEntries([event])[0] || event;
      const maxEntries = Number(this.config?.debug?.max_entries ?? 150) || 150;
      const key = String(entry?.idx || `${entry?.time || ""}-${entry?.message || ""}`);
      const existing = Array.isArray(this._debugEntries) ? this._debugEntries.filter((item) => String(item?.idx || `${item?.time || ""}-${item?.message || ""}`) !== key) : [];
      this._debugEntries = [...existing, entry].slice(-maxEntries);
      this.requestUpdate?.();
      this.render?.();
    },
    {
      type: "ha_hikvision_bridge/subscribe_debug"
    }
  );
}

_buildBackendDebugEntries(debugEntries = []) {
  if (!Array.isArray(debugEntries)) return [];
  return debugEntries.map((entry, index) => {
    const responseStatus = Number(entry?.response?.status || 0);
    const legacyLevel = responseStatus >= 400 || entry?.ok === false || entry?.reason || entry?.error ? "error" : "info";
    const cameraId = entry?.camera_id || entry?.camera || this.selectedCamera?.channel || "";
    return {
      idx: entry?.id || `backend-${index}-${entry?.requested_time || entry?.search_start || entry?.ts || index}`,
      time: entry?.ts || entry?.time || entry?.requested_time || entry?.search_start || new Date().toISOString(),
      category: String(entry?.category || "backend").toLowerCase(),
      level: String(entry?.level || legacyLevel).toLowerCase(),
      source: "backend",
      event: entry?.event || "backend_event",
      message: entry?.message || entry?.reason || entry?.error || `Backend event${responseStatus ? ` HTTP ${responseStatus}` : ""}`,
      camera: cameraId ? String(cameraId) : "",
      details: this._sanitizeDebugObject({
        entry_id: entry?.entry_id,
        context: entry?.context,
        track_id: entry?.track_id,
        requested_time: entry?.requested_time,
        search_start: entry?.search_start,
        search_end: entry?.search_end,
        match_count: entry?.match_count,
        request: entry?.request,
        response: entry?.response,
        ok: entry?.ok,
        reason: entry?.reason,
        error: entry?.error,
        selected_match: entry?.selected_match,
      }),
    };
  });
}

_syncBackendDebugEntries(debugEntries = []) {
  const normalized = this._buildBackendDebugEntries(debugEntries);
  const signature = JSON.stringify(normalized.map((entry) => [entry.idx, entry.time, entry.message, entry.details?.response?.status || "", entry.details?.requested_time || ""]));
  const frontend = (this._debugEntries || []).filter((entry) => entry.source !== "backend");
  const maxEntries = Number(this.config?.debug?.max_entries ?? 150) || 150;
  this._debugEntries = [...frontend, ...normalized].slice(-maxEntries);
}



_toggleDebugFilter(kind, value) {
    const current = new Set(this._debugFilters?.[kind] || ["all"]);
    const normalized = String(value || "all").toLowerCase();
    if (normalized === "all") {
      this._debugFilters = { ...(this._debugFilters || {}), [kind]: ["all"] };
      this.render();
      return;
    }
    current.delete("all");
    if (current.has(normalized)) current.delete(normalized);
    else current.add(normalized);
    this._debugFilters = { ...(this._debugFilters || {}), [kind]: current.size ? Array.from(current) : ["all"] };
    this.render();
  }

  _getFilteredDebugEntries() {
    const categoryFilters = new Set(this._debugFilters?.categories || ["all"]);
    const levelFilters = new Set(this._debugFilters?.levels || ["all"]);
    return (this._debugEntries || []).filter((entry) => {
      const categoryMatch = categoryFilters.has("all") || categoryFilters.has(String(entry?.category || "").toLowerCase());
      const levelMatch = levelFilters.has("all") || levelFilters.has(String(entry?.level || "").toLowerCase());
      return categoryMatch && levelMatch;
    }).slice().reverse();
  }

  formatDebugEntryText(entry) {
    if (!entry) return "";
    const lines = [
      "=== Hikvision Debug Event ===",
      `Time: ${entry.time || ""}`,
      `Source: ${entry.source || ""}`,
      `Category: ${entry.category || ""}`,
      `Level: ${entry.level || ""}`,
      `Event: ${entry.event || ""}`,
      `Message: ${entry.message || ""}`,
      `Camera: ${entry.camera || ""}`,
      "",
      "--- Details ---",
      JSON.stringify(this._sanitizeDebugObject(entry.details || {}), null, 2),
      "",
    ];
    return lines.join("\n");
  }

  copyDebugText(text) {
    const value = String(text || "");
    if (!value) return;
    navigator.clipboard.writeText(value).catch((err) => console.error("Failed to copy debug text", err));
  }

  downloadDebugText(text, prefix = "hikvision-debug") {
    const value = String(text || "");
    if (!value) return;
    const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${prefix}-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  renderDebugDashboard(camAttrs = {}) {
    if (!this.isDebugEnabled()) return "";
    this._lastCameraAttrs = camAttrs || {};
    this._syncBackendDebugEntries(camAttrs?.playback_debug || []);
    const entries = this._getFilteredDebugEntries();
    const summary = {
      total: (this._debugEntries || []).length,
      error: (this._debugEntries || []).filter((entry) => entry.level === "error").length,
      warn: (this._debugEntries || []).filter((entry) => entry.level === "warn").length,
      audio: (this._debugEntries || []).filter((entry) => entry.category === "audio").length,
      playback: (this._debugEntries || []).filter((entry) => entry.category === "playback").length,
      video: (this._debugEntries || []).filter((entry) => entry.category === "video").length,
      backend: (this._debugEntries || []).filter((entry) => entry.category === "backend").length,
    };
    const categories = ["all", "audio", "playback", "video", "backend"];
    const levels = ["all", "error", "warn", "info", "debug"];
    const openAttr = this._debugDashboardOpen ? "open" : "";
    return `
      <div class="hik-panel hik-info-card hik-debug-dashboard">
        <details id="hik-debug-dashboard-details" ${openAttr}>
          <summary class="hik-debug-summary">
            <span class="hik-sub"><ha-icon icon="mdi:bug-outline"></ha-icon>Debug Dashboard</span>
            <span class="hik-mini-note">${this.escapeHtml(String(entries.length))} shown · ${this.escapeHtml(String(summary.total))} captured</span>
          </summary>
          <div class="hik-status-row">
            <span class="hik-pill neutral"><ha-icon icon="mdi:counter"></ha-icon>Total ${this.escapeHtml(String(summary.total))}</span>
            <span class="hik-pill ${summary.error ? "warn" : "neutral"}"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>Errors ${this.escapeHtml(String(summary.error))}</span>
            <span class="hik-pill neutral"><ha-icon icon="mdi:alert-outline"></ha-icon>Warn ${this.escapeHtml(String(summary.warn))}</span>
            <span class="hik-pill neutral"><ha-icon icon="mdi:microphone-outline"></ha-icon>Audio ${this.escapeHtml(String(summary.audio))}</span>
            <span class="hik-pill neutral"><ha-icon icon="mdi:play-box-multiple-outline"></ha-icon>Playback ${this.escapeHtml(String(summary.playback))}</span>
            <span class="hik-pill neutral"><ha-icon icon="mdi:video-outline"></ha-icon>Video ${this.escapeHtml(String(summary.video))}</span>
            <span class="hik-pill neutral"><ha-icon icon="mdi:server-network-outline"></ha-icon>Backend ${this.escapeHtml(String(summary.backend))}</span>
          </div>
          <div class="hik-debug-toolbar">
            <div class="hik-debug-filter-group">
              ${categories.map((value) => `<button type="button" class="hik-debug-chip ${(this._debugFilters?.categories || ["all"]).includes(value) ? "active" : ""}" data-debug-filter="categories" data-debug-value="${value}">${this.escapeHtml(value)}</button>`).join("")}
            </div>
            <div class="hik-debug-filter-group">
              ${levels.map((value) => `<button type="button" class="hik-debug-chip ${(this._debugFilters?.levels || ["all"]).includes(value) ? "active" : ""}" data-debug-filter="levels" data-debug-value="${value}">${this.escapeHtml(value)}</button>`).join("")}
            </div>
            <div class="hik-debug-actions">
              <button class="hik-debug-btn" data-debug-global-action="copy-all">Copy shown</button>
              <button class="hik-debug-btn" data-debug-global-action="download-all">Download shown</button>
              <button class="hik-debug-btn" data-debug-global-action="clear">Clear frontend</button>
            </div>
          </div>
          ${entries.length ? entries.slice(0, 40).map((entry, index) => {
            const debugText = this.formatDebugEntryText(entry);
            const badgeClass = entry.level === "error" ? "warn" : entry.level === "warn" ? "primary" : "neutral";
            return `
              <div class="hik-debug-block">
                <div class="hik-status-row">
                  <span class="hik-pill ${badgeClass}"><ha-icon icon="mdi:timeline-clock-outline"></ha-icon>${this.escapeHtml(entry.category || "general")}</span>
                  <span class="hik-pill neutral"><ha-icon icon="mdi:flag-outline"></ha-icon>${this.escapeHtml(entry.level || "info")}</span>
                  <span class="hik-pill neutral"><ha-icon icon="mdi:source-branch"></ha-icon>${this.escapeHtml(entry.source || "frontend")}</span>
                  ${entry.camera ? `<span class="hik-pill neutral"><ha-icon icon="mdi:cctv"></ha-icon>CH ${this.escapeHtml(String(entry.camera))}</span>` : ""}
                </div>
                <div class="hik-mini-note"><b>${this.escapeHtml(entry.event || "event")}</b> · ${this.escapeHtml(entry.message || "")}</div>
                <div class="hik-mini-note">${this.escapeHtml(entry.time || "")}</div>
                <div class="hik-debug-actions">
                  <button class="hik-debug-btn" data-debug-entry-action="copy">Copy</button>
                  <button class="hik-debug-btn" data-debug-entry-action="download">Download</button>
                </div>
                <textarea class="hik-debug-textarea" readonly>${this.escapeHtml(debugText)}</textarea>
                ${entry?.details ? `<details ${index === 0 ? "open" : ""}><summary>Details</summary><pre class="hik-debug-pre">${this.escapeHtml(JSON.stringify(entry.details, null, 2))}</pre></details>` : ""}
              </div>`;
          }).join("") : `<div class="hik-empty-note">No debug events for the current filters.</div>`}
        </details>
      </div>`;
  }

  async _startTalkbackDirect() {
    try {
      if (this._talkActive) return;
      this._setAudioDebugStatus({ requested: true, active: false, ws: "starting", pc: "starting", last_error: "" });
      this._pushAudioDebug("talk_start_requested", {});
      const rtspUrl = this._preferredRtspUrl || "";
      if (!rtspUrl) throw new Error("No RTSP URL available for talkback");
      this._pushAudioDebug("rtsp_selected", { rtspUrl });

      this._talkStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this._setAudioDebugStatus({ mic: "granted" });
      this._pushAudioDebug("mic_granted", { trackCount: this._talkStream?.getTracks?.().length || 0 });

      const pc = new RTCPeerConnection();
      pc.addEventListener("connectionstatechange", () => this._setAudioDebugStatus({ pc: pc.connectionState || "unknown" }));
      pc.addEventListener("iceconnectionstatechange", () => this._setAudioDebugStatus({ ice: pc.iceConnectionState || "unknown" }));
      pc.addEventListener("signalingstatechange", () => this._setAudioDebugStatus({ signaling: pc.signalingState || "unknown" }));
      this._pushAudioDebug("pc_created", {});
      this._talkStream.getTracks().forEach((track) => pc.addTrack(track, this._talkStream));

      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);

      const wsUrl = await this._getSignedWebRtcUrl(rtspUrl);
      this._pushAudioDebug("signed_ws_url", { wsUrl });
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => { this._setAudioDebugStatus({ ws: "open" }); this._pushAudioDebug("ws_open", {}); });
      ws.addEventListener("close", (ev) => { this._setAudioDebugStatus({ ws: "closed" }); this._pushAudioDebug("ws_close", { code: ev.code, reason: ev.reason }); });
      ws.addEventListener("error", () => { this._setAudioDebugStatus({ ws: "error" }); this._pushAudioDebug("ws_error", { error: "Talkback websocket failed" }); });

      const answerReady = new Promise((resolve, reject) => {
        const cleanup = () => {
          ws.removeEventListener("message", onMessage);
          ws.removeEventListener("error", onError);
        };
        const onError = () => {
          cleanup();
          reject(new Error("Talkback websocket failed"));
        };
        const onMessage = async (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "webrtc/answer") {
              this._pushAudioDebug("answer_received", {});
              await pc.setRemoteDescription({ type: "answer", sdp: msg.value });
              cleanup();
              resolve();
              return;
            }
            if (msg.type === "error") {
              this._pushAudioDebug("server_error", { error: msg.value || "unknown" });
            }
            if (msg.type === "webrtc/candidate" && msg.value) {
              try { await pc.addIceCandidate(new RTCIceCandidate(msg.value)); } catch (e) {}
            }
          } catch (err) {
            cleanup();
            reject(err);
          }
        };
        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", onError, { once: true });
      });

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "webrtc/offer", value: offer.sdp }));
        this._pushAudioDebug("offer_sent", {});
      }, { once: true });

      pc.onicecandidate = (event) => {
        if (event.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "webrtc/candidate", value: event.candidate }));
        }
      };

      await answerReady;

      this._talkPc = pc;
      this._talkWs = ws;
      this._talkActive = true;
      this._setAudioDebugStatus({ requested: true, active: true, pc: pc.connectionState || "connected", signaling: pc.signalingState || "stable" });
      this._pushAudioDebug("talk_active", {});
    } catch (err) {
      this._setAudioDebugStatus({ requested: true, active: false, ws: "failed", pc: "failed", last_error: String(err?.message || err) });
      this._pushAudioDebug("talk_failed", { error: String(err?.message || err) });
      console.error("Direct talk failed:", err);
      this._stopTalkbackDirect();
      throw err;
    }
  }

  async _getSignedWebRtcUrl(rtspUrl) {
    if (!this._hass) throw new Error("No HA connection");

    const result = await this._hass.callWS({
      type: "ha_hikvision_bridge/webrtc_url",
      url: rtspUrl,
    });
    this._pushAudioDebug("signed_path_received", { hasPath: !!result?.path });

    const path = result?.path;
    if (!path) {
      throw new Error("Failed to obtain signed WebRTC path");
    }

    if (/^wss?:\/\//.test(path)) {
      return path;
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}${path}`;
  }


  _setAudioDebugStatus(patch = {}) {
    this._audioDebugStatus = { ...(this._audioDebugStatus || {}), ...patch };
  }

  _pushAudioDebug(event, details = {}) {
    const entry = {
      idx: ++this._audioDebugSeq,
      time: new Date().toISOString(),
      event: String(event || 'event'),
      details: details || {},
    };
    this._audioDebugLog = [...(this._audioDebugLog || []), entry].slice(-60);
    if (details?.error) this._setAudioDebugStatus({ last_error: String(details.error) });
    const level = this._debugEventLevelFromData(event, details);
    this._pushDebug("audio", level, event, String(event || "Audio event").replace(/_/g, " "), details, "frontend");
  }

  shouldShowAudioDebug() {
    return this.config.show_audio_debug === true;
  }

  formatAudioDebugText(entry) {
    if (!entry) return '';
    const details = entry.details || {};
    const lines = [
      '=== Hikvision Audio Debug ===',
      `Time: ${entry.time || ''}`,
      `Event: ${entry.event || ''}`,
      '',
      '--- Details ---',
      JSON.stringify(details, null, 2),
      '',
    ];
    return lines.join("\n");
  }

  renderAudioDebug() {
    if (!this.shouldShowAudioDebug()) return '';
    const status = this._audioDebugStatus || {};
    const entries = (this._audioDebugLog || []).slice().reverse();
    return `
      <div class="hik-panel hik-info-card hik-audio-debug-panel">
        <div class="hik-sub"><ha-icon icon="mdi:bug-outline"></ha-icon>Audio Debug</div>
        <div class="hik-status-row">
          <span class="hik-pill neutral"><ha-icon icon="mdi:gesture-tap-button"></ha-icon>Requested ${this.escapeHtml(String(!!status.requested))}</span>
          <span class="hik-pill ${status.active ? 'good' : 'neutral'}"><ha-icon icon="mdi:microphone${status.active ? '' : '-off'}"></ha-icon>Active ${this.escapeHtml(String(!!status.active))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:web"></ha-icon>WS ${this.escapeHtml(status.ws || 'idle')}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:access-point-network"></ha-icon>ICE ${this.escapeHtml(status.ice || 'idle')}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:lan-connect"></ha-icon>PC ${this.escapeHtml(status.pc || 'idle')}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:source-branch"></ha-icon>Signal ${this.escapeHtml(status.signaling || 'stable')}</span>
        </div>
        <div class="hik-mini-note">RTSP ${this.escapeHtml(this._preferredRtspUrl || '-')}</div>
        ${status.last_error ? `<div class="hik-mini-note" style="color:var(--error-color);">Last error: ${this.escapeHtml(status.last_error)}</div>` : ''}
        ${entries.length ? entries.slice(0,8).map((entry, index) => {
          const debugText = this.formatAudioDebugText(entry);
          return `
          <div class="hik-debug-block">
            <div class="hik-status-row">
              <span class="hik-pill ${/fail|error|close/i.test(entry.event) ? 'warn' : 'neutral'}"><ha-icon icon="mdi:timeline-clock-outline"></ha-icon>${this.escapeHtml(entry.event)}</span>
              <span class="hik-pill neutral"><ha-icon icon="mdi:clock-outline"></ha-icon>${this.escapeHtml(entry.time)}</span>
            </div>
            <div class="hik-debug-actions">
              <button class="hik-debug-btn" data-debug-index="${index}" data-debug-action="copy">Copy</button>
              <button class="hik-debug-btn" data-debug-index="${index}" data-debug-action="download">Download</button>
            </div>
            <textarea class="hik-debug-textarea" readonly>${this.escapeHtml(debugText)}</textarea>
          </div>`;
        }).join('') : '<div class="hik-empty-note">No audio debug events yet</div>'}
      </div>`;
  }

  _stopTalkbackDirect() {
    this._pushAudioDebug("talk_stop", {});
    this._setAudioDebugStatus({ requested: false, active: false, ws: "idle", pc: "idle", ice: "idle", signaling: "stable" });
    try {
      if (this._talkWs) {
        this._talkWs.close();
        this._talkWs = null;
      }
    } catch (err) {}
    try {
      if (this._talkPc) {
        this._talkPc.close();
        this._talkPc = null;
      }
    } catch (err) {}
    if (this._talkStream) {
      this._talkStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (err) {}
      });
      this._talkStream = null;
    }
    this._talkActive = false;
  }

  _detachTalkReleaseListeners() {
    if (typeof this._talkReleaseCleanup === "function") {
      try { this._talkReleaseCleanup(); } catch (err) {}
    }
    this._talkReleaseCleanup = null;
    this._talkPointerId = null;
    this._talkHoldActive = false;
  }

  _attachTalkReleaseListeners(button, pointerId = null) {
    this._detachTalkReleaseListeners();
    this._talkPointerId = pointerId;

    const finish = (ev) => {
      if (ev?.type?.startsWith?.("pointer") && this._talkPointerId != null) {
        if (ev.pointerId != null && ev.pointerId !== this._talkPointerId) return;
      }
      this._handleTalkButtonUp(ev);
    };

    const blurFinish = () => this._handleTalkButtonUp();
    const visibilityFinish = () => {
      if (document.visibilityState === "hidden") this._handleTalkButtonUp();
    };
    const opts = { capture: true };

    window.addEventListener("pointerup", finish, opts);
    window.addEventListener("pointercancel", finish, opts);
    window.addEventListener("mouseup", finish, opts);
    window.addEventListener("touchend", finish, opts);
    window.addEventListener("touchcancel", finish, opts);
    window.addEventListener("blur", blurFinish, opts);
    document.addEventListener("visibilitychange", visibilityFinish, opts);

    if (button?.setPointerCapture && pointerId != null) {
      try { button.setPointerCapture(pointerId); } catch (err) {}
    }

    this._talkReleaseCleanup = () => {
      if (button?.releasePointerCapture && pointerId != null) {
        try { button.releasePointerCapture(pointerId); } catch (err) {}
      }
      window.removeEventListener("pointerup", finish, opts);
      window.removeEventListener("pointercancel", finish, opts);
      window.removeEventListener("mouseup", finish, opts);
      window.removeEventListener("touchend", finish, opts);
      window.removeEventListener("touchcancel", finish, opts);
      window.removeEventListener("blur", blurFinish, opts);
      document.removeEventListener("visibilitychange", visibilityFinish, opts);
    };
  }

  getCardSize() {
    return this._controlsVisible ? 11 : 9;
  }

  static getStubConfig() {
    return {
      type: "custom:ha-hikvision-bridge-card",
      title: "ha-hikvision-bridge-card",
      auto_discover: true,
      controls_mode: "always",
      show_camera_info: true,
      show_stream_info: true,
      show_dvr_info: true,
      show_storage_info: true,
      show_alarm_dashboard: true,
      show_stream_mode_info: true,
      show_controls: true,
      show_playback_panel: true,
      playback_presets: [1, 5, 10, 30, 60, 300, 600, 3600],
    };
  }

  static getConfigElement() {
    return document.createElement("ha-hikvision-bridge-card-editor");
  }

  escapeHtml(value) {
    return String(value ?? "-")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  normalizeColor(value, fallback = "var(--primary-color)") {
    const raw = String(value || "").trim();
    if (!raw) return fallback;
    const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    if (hex.test(raw)) return raw;
    if (raw.startsWith("var(")) return raw;
    return fallback;
  }

  getEntity(entityId) {
    return this._hass?.states?.[entityId] || null;
  }

  _normalizeName(value, fallback) {
    const raw = String(value || fallback || "").trim();
    if (!raw) return fallback || "Camera";
    const words = raw.split(/\s+/);
    const half = Math.floor(words.length / 2);
    if (words.length >= 2 && words.length % 2 === 0) {
      const first = words.slice(0, half).join(" ").toLowerCase();
      const second = words.slice(half).join(" ").toLowerCase();
      if (first === second) return words.slice(0, half).join(" ");
    }
    return raw;
  }

  findEntityForChannel(channel, kind) {
    const states = this._hass?.states || {};
    const wanted = String(channel);
    for (const [entityId, stateObj] of Object.entries(states)) {
      const attrs = stateObj.attributes || {};
      if (String(attrs.channel) !== wanted) continue;
      if (kind === "camera" && entityId.startsWith("camera.")) return entityId;
      if (kind === "info" && entityId.startsWith("sensor.") && !entityId.includes("_stream")) return entityId;
      if (kind === "stream" && entityId.startsWith("sensor.") && entityId.includes("_stream")) return entityId;
      if (kind === "online" && entityId.startsWith("binary_sensor.") && entityId.includes("_online")) return entityId;
      if (kind === "ptz_supported" && entityId.startsWith("binary_sensor.") && entityId.includes("_ptz_supported")) return entityId;
      if (kind === "motion" && entityId.startsWith("binary_sensor.") && entityId.includes("_motion_alarm")) return entityId;
      if (kind === "video_loss" && entityId.startsWith("binary_sensor.") && entityId.includes("_video_loss_alarm")) return entityId;
      if (kind === "intrusion" && entityId.startsWith("binary_sensor.") && entityId.includes("_intrusion_alarm")) return entityId;
      if (kind === "line_crossing" && entityId.startsWith("binary_sensor.") && entityId.includes("_line_crossing_alarm")) return entityId;
      if (kind === "tamper" && entityId.startsWith("binary_sensor.") && entityId.includes("_tamper_alarm")) return entityId;
    }
    return null;
  }

  findGlobalEntities() {
    const states = this._hass?.states || {};
    const result = { dvr: null, storage: null, alarmStream: null, diskFull: null, diskError: null, alarmInputs: [] };

    const selected = this.selectedCamera;
    const selectedCameraEntityId = selected?.camera_entity || null;
    const selectedInfoEntityId = selected ? this.findEntityForChannel(selected.channel, "info") : null;
    const hintedIds = [selectedCameraEntityId, selectedInfoEntityId].filter(Boolean);
    const hintPrefixes = Array.from(new Set(hintedIds.map((entityId) => {
      const match = String(entityId).match(/^(?:camera|sensor|binary_sensor)\.([^.]+)_camera_\d+_.+$/);
      return match ? match[1] : null;
    }).filter(Boolean)));

    const chooseBestByExactSuffix = (suffix) => {
      const sensorIds = Object.keys(states).filter((entityId) => entityId.startsWith("sensor."));
      for (const prefix of hintPrefixes) {
        const hinted = sensorIds.find((entityId) => entityId === `sensor.${prefix}${suffix}`);
        if (hinted) return hinted;
      }
      return sensorIds.find((entityId) => entityId.endsWith(suffix)) || null;
    };

    result.dvr = chooseBestByExactSuffix("_nvr_system_info");
    result.storage = chooseBestByExactSuffix("_nvr_storage_info");

    const scoreEntity = (entityId, stateObj) => {
      if (!entityId.startsWith("sensor.")) return { dvrScore: -Infinity, storageScore: -Infinity };
      const attrs = stateObj.attributes || {};
      const text = `${entityId} ${(attrs.friendly_name || "")} ${Object.keys(attrs).join(" ")}`.toLowerCase();
      let dvrScore = 0;
      let storageScore = 0;
      if (/(dvr|nvr|hikvision|recorder|system)/.test(text)) dvrScore += 2;
      if (entityId.includes("_nvr_system_info")) dvrScore += 20;
      if (entityId.includes("_nvr_storage_info")) storageScore += 20;
      if (/(model|firmware|serial|device_name|device model|vendor)/.test(text)) dvrScore += 3;
      if (/(storage|disk|hdd|capacity|free space|used space|health|raid)/.test(text)) storageScore += 3;
      if (attrs.disk_mode !== undefined) {
        dvrScore += 3;
        storageScore += 2;
      }
      if (attrs.total_capacity_mb !== undefined || attrs.storage_total !== undefined || Array.isArray(attrs.hdds)) storageScore += 6;
      if (hintPrefixes.length && hintPrefixes.some((prefix) => entityId.startsWith(`sensor.${prefix}`))) {
        dvrScore += 8;
        storageScore += 8;
      }
      return { dvrScore, storageScore };
    };

    if (!result.dvr || !result.storage) {
      let bestDvr = { id: result.dvr, score: result.dvr ? Infinity : -Infinity };
      let bestStorage = { id: result.storage, score: result.storage ? Infinity : -Infinity };
      Object.entries(states).forEach(([entityId, stateObj]) => {
        const { dvrScore, storageScore } = scoreEntity(entityId, stateObj);
        if (!result.dvr && dvrScore > bestDvr.score) bestDvr = { id: entityId, score: dvrScore };
        if (!result.storage && storageScore > bestStorage.score) bestStorage = { id: entityId, score: storageScore };
      });
      if (!result.dvr) result.dvr = Number.isFinite(bestDvr.score) && bestDvr.score > 1 ? bestDvr.id : null;
      if (!result.storage) result.storage = Number.isFinite(bestStorage.score) && bestStorage.score > 1 ? bestStorage.id : null;
    }

    Object.entries(states).forEach(([entityId, stateObj]) => {
      if (!entityId.startsWith("binary_sensor.")) return;
      if (entityId.includes("_nvr_alarm_stream_connected")) result.alarmStream = entityId;
      else if (entityId.includes("_nvr_disk_full_alarm")) result.diskFull = entityId;
      else if (entityId.includes("_nvr_disk_error_alarm")) result.diskError = entityId;
      else if (entityId.includes("_nvr_alarm_input_")) result.alarmInputs.push(entityId);
    });
    return result;
  }

  discoverCameras() {
    if (!this._hass?.states) return [];
    const states = this._hass.states;
    const manualByChannel = new Map((this.config.cameras || []).map((c) => [String(c.channel), c]));
    const cameras = [];

    Object.entries(states).forEach(([entityId, stateObj]) => {
      if (!entityId.startsWith("camera.")) return;
      const attrs = stateObj.attributes || {};
      const channel = attrs.channel;
      if (channel === undefined || channel === null || channel === "") return;
      const ch = String(channel);
      const online = attrs.online !== false;
      const cardVisible = attrs.card_visible !== false;
      if (!online || !cardVisible) return;

      const infoEntityId = this.findEntityForChannel(ch, "info");
      const infoEntity = infoEntityId ? this.getEntity(infoEntityId) : null;
      const manual = manualByChannel.get(ch);
      const friendly = attrs.friendly_name || stateObj.attributes?.friendly_name || `Camera ${ch}`;
      const infoName = infoEntity?.attributes?.friendly_name || infoEntity?.attributes?.name || null;
      const stateName = (infoEntity?.state && !["streaming", "idle", "unknown", "unavailable"].includes(String(infoEntity.state).toLowerCase()))
        ? infoEntity.state
        : null;
      const name = this._normalizeName(manual?.name || infoName || friendly || stateName, `Camera ${ch}`);

      cameras.push({
        channel: Number(channel),
        name,
        camera_entity: entityId,
        presets: manual?.presets || [],
      });
    });

    return cameras.sort((a, b) => a.channel - b.channel);
  }

  get cameras() {
    if (this.config.auto_discover !== false) {
      const auto = this.discoverCameras();
      if (auto.length) return auto;
    }
    return (this.config.cameras || []).map((c) => ({ ...c, camera_entity: c.camera_entity || null }));
  }

  get selectedCamera() {
    const cams = this.cameras;
    if (!cams.length) return null;
    if (this.selected >= cams.length) this.selected = 0;
    return cams[this.selected];
  }

  refsForChannel(channel) {
    const selected = this.selectedCamera;
    return {
      info: this.findEntityForChannel(channel, "info"),
      stream: this.findEntityForChannel(channel, "stream"),
      online: this.findEntityForChannel(channel, "online"),
      ptz: this.findEntityForChannel(channel, "ptz_supported"),
      motion: this.findEntityForChannel(channel, "motion"),
      videoLoss: this.findEntityForChannel(channel, "video_loss"),
      intrusion: this.findEntityForChannel(channel, "intrusion"),
      lineCrossing: this.findEntityForChannel(channel, "line_crossing"),
      tamper: this.findEntityForChannel(channel, "tamper"),
      camera: selected?.camera_entity || this.findEntityForChannel(channel, "camera"),
    };
  }

  getPTZConfig() {
    const steps = this.config.ptz_steps || {};
    return {
      maxPan: Math.max(1, Number(steps.pan ?? this.config.max_pan_steps ?? 5)),
      maxTilt: Math.max(1, Number(steps.tilt ?? this.config.max_tilt_steps ?? 5)),
      maxZoom: Math.max(1, Number(steps.zoom ?? this.config.max_zoom_steps ?? 5)),
      returnStepDelay: Math.max(0, Number(this.config.return_step_delay ?? 150)),
    };
  }

  getPTZState(channel = null) {
    const cam = channel != null ? { channel } : this.selectedCamera;
    if (!cam) return { pan: 0, tilt: 0, zoom: 0 };
    const key = String(cam.channel);
    if (!this._ptzStateMap[key]) this._ptzStateMap[key] = { pan: 0, tilt: 0, zoom: 0 };
    return this._ptzStateMap[key];
  }

  resetPTZState(channel = null) {
    const cam = channel != null ? { channel } : this.selectedCamera;
    if (!cam) return;
    this._ptzStateMap[String(cam.channel)] = { pan: 0, tilt: 0, zoom: 0 };
  }

  updatePTZState(delta = {}) {
    const state = this.getPTZState();
    const cfg = this.getPTZConfig();
    state.pan = Math.max(-cfg.maxPan, Math.min(cfg.maxPan, state.pan + Number(delta.pan || 0)));
    state.tilt = Math.max(-cfg.maxTilt, Math.min(cfg.maxTilt, state.tilt + Number(delta.tilt || 0)));
    state.zoom = Math.max(-cfg.maxZoom, Math.min(cfg.maxZoom, state.zoom + Number(delta.zoom || 0)));
  }

  async handleReturnHome() {
    const cam = this.selectedCamera;
    if (!cam || !this._hass || !this.canPtz() || this._returningHome) return;
    const state = { ...this.getPTZState() };
    if (!state.pan && !state.tilt && !state.zoom) return;

    this.stopMove();
    this._returningHome = true;
    this.render();

    try {
      await this._hass.callService("ha_hikvision_bridge", "ptz_return_to_center", {
        channel: String(cam.channel),
        state,
        speed: Number(this.config.speed || 50),
        duration: Number(this.config.repeat_ms || 350),
        step_delay: Number(this.config.return_step_delay || 150),
      });
      this.resetPTZState(cam.channel);
    } finally {
      this._returningHome = false;
      this.render();
    }
  }

  handleSetHome() {
    const cam = this.selectedCamera;
    if (!cam) return;
    this.resetPTZState(cam.channel);
    this.render();
  }

  getDirectionInfo() {
    const state = this.getPTZState();
    const dx = Math.sign(state.pan);
    const dy = Math.sign(state.tilt);
    const map = {
      '0,0': { label: 'Home', icon: 'mdi:crosshairs-gps' },
      '1,0': { label: 'Right', icon: 'mdi:arrow-right-bold' },
      '-1,0': { label: 'Left', icon: 'mdi:arrow-left-bold' },
      '0,1': { label: 'Up', icon: 'mdi:arrow-up-bold' },
      '0,-1': { label: 'Down', icon: 'mdi:arrow-down-bold' },
      '1,1': { label: 'Up-right', icon: 'mdi:arrow-top-right-bold-box-outline' },
      '-1,1': { label: 'Up-left', icon: 'mdi:arrow-top-left-bold-box-outline' },
      '1,-1': { label: 'Down-right', icon: 'mdi:arrow-bottom-right-bold-box-outline' },
      '-1,-1': { label: 'Down-left', icon: 'mdi:arrow-bottom-left-bold-box-outline' },
    };
    return map[`${dx},${dy}`] || map['0,0'];
  }

  renderPTZIndicator() {
    const state = this.getPTZState();
    const cfg = this.getPTZConfig();
    const scale = 1 - (Math.abs(state.zoom) / cfg.maxZoom) * 0.45;
    const direction = this.getDirectionInfo();
    const cellClass = (x, y) => {
      const dx = Math.sign(state.pan);
      const dy = Math.sign(state.tilt);
      if (x === 0 && y === 0) return dx === 0 && dy === 0 ? 'active center' : 'center';
      return x === dx && y === dy ? 'active' : '';
    };
    const zoomFill = Math.max(0, state.zoom);
    const zoomOutFill = Math.max(0, -state.zoom);
    return `
      <div class="hik-position-card">
        <div class="hik-position-head">
          <div class="hik-sub" style="margin:0;"><ha-icon icon="mdi:crosshairs-question"></ha-icon>Position Tracker</div>
          <div class="hik-pill primary"><ha-icon icon="${direction.icon}"></ha-icon>${direction.label}</div>
        </div>
        <div class="hik-position-body">
          <div class="hik-indicator-wrap" style="transform:scale(${scale});">
            <div class="hik-indicator-grid">
              <div class="${cellClass(-1,1)}">↖</div>
              <div class="${cellClass(0,1)}">↑</div>
              <div class="${cellClass(1,1)}">↗</div>
              <div class="${cellClass(-1,0)}">←</div>
              <div class="${cellClass(0,0)}">•</div>
              <div class="${cellClass(1,0)}">→</div>
              <div class="${cellClass(-1,-1)}">↙</div>
              <div class="${cellClass(0,-1)}">↓</div>
              <div class="${cellClass(1,-1)}">↘</div>
            </div>
          </div>
          <div class="hik-position-meta">
            <div><b>Pan</b><span>${state.pan}</span></div>
            <div><b>Tilt</b><span>${state.tilt}</span></div>
            <div><b>Zoom</b><span>${state.zoom}</span></div>
            <div><b>Home return</b><span>${this._returningHome ? 'Running' : 'Ready'}</span></div>
          </div>
        </div>
        <div class="hik-zoom-track-wrap">
          <div class="hik-zoom-track-label"><span>Zoom out</span><span>Home</span><span>Zoom in</span></div>
          <div class="hik-zoom-track">
            <div class="hik-zoom-side out" style="--fill:${zoomOutFill}; --max:${cfg.maxZoom};"></div>
            <div class="hik-zoom-center"></div>
            <div class="hik-zoom-side in" style="--fill:${zoomFill}; --max:${cfg.maxZoom};"></div>
          </div>
        </div>
        <div class="hik-row">
          <button class="hik-btn" id="hik-set-home" ${this._returningHome ? 'disabled' : ''}><ha-icon icon="mdi:home-edit-outline"></ha-icon><span>Set Home</span></button>
          <button class="hik-btn" id="hik-return-home" ${(this._returningHome || (!state.pan && !state.tilt && !state.zoom) || !this.canPtz()) ? 'disabled' : ''}><ha-icon icon="mdi:home-arrow-left"></ha-icon><span>${this._returningHome ? 'Returning…' : 'Return Home'}</span></button>
        </div>
      </div>
    `;
  }

  stopMove() {
    if (this._repeatHandle) {
      clearInterval(this._repeatHandle);
      this._repeatHandle = null;
    }
  }

  getPTZDuration() {
    return Math.max(100, Number(this.config.ptz_duration ?? this.config.repeat_ms ?? 350));
  }

  getLensDuration() {
    return Math.max(60, Number(this.config.lens_duration ?? 180));
  }

  shouldUseLensStopSafeguard() {
    return this.config.lens_stop_safeguard === true;
  }

  executeLensPulse(service, direction = 0, options = {}) {
    const cam = this.selectedCamera;
    if (!cam || !this._hass || !this.isOnline() || this._returningHome) return Promise.resolve(false);

    const duration = Math.max(0, Number(options.duration ?? this.getLensDuration()));
    const speed = Number(options.speed ?? (service === "zoom"
      ? Number(this.config.speed || 50)
      : Number(this.config.lens_step || 60)));

    this._hass.callService("ha_hikvision_bridge", service, {
      channel: String(cam.channel),
      direction: Number(direction || 0),
      speed,
      duration,
    });

    if (service === "zoom") {
      this.updatePTZState({ zoom: Number(direction || 0) });
      this.render();
    }

    if (this.shouldUseLensStopSafeguard() && Number(direction || 0) !== 0 && duration > 0) {
      window.setTimeout(() => {
        const activeCam = this.selectedCamera;
        if (!activeCam || String(activeCam.channel) !== String(cam.channel)) return;
        this._hass.callService("ha_hikvision_bridge", service, {
          channel: String(cam.channel),
          direction: 0,
          speed,
          duration: 0,
        });
      }, duration + 20);
    }

    return Promise.resolve(true);
  }

  async handleRefocus() {
    const cam = this.selectedCamera;
    if (!cam || !this._hass || !this.isOnline() || this._returningHome) return;

    const pulse = this.getLensDuration();
    const settle = Math.max(80, Math.min(250, Math.round(pulse * 0.75)));
    const step = Math.max(1, Number(this.config.refocus_step ?? 40));

    await this.executeLensPulse("zoom", 1, { duration: pulse, speed: step });
    await new Promise((resolve) => window.setTimeout(resolve, pulse + settle));
    await this.executeLensPulse("zoom", -1, { duration: pulse, speed: step });
  }

  startMove(pan, tilt) {
    this.stopMove();
    const run = () => {
      const cam = this.selectedCamera;
      if (!cam || !this._hass || !this.canPtz() || this._returningHome) return;
      this._hass.callService("ha_hikvision_bridge", "ptz", {
        channel: String(cam.channel),
        pan,
        tilt,
        duration: this.getPTZDuration(),
      });
      this.updatePTZState({
        pan: pan > 0 ? 1 : pan < 0 ? -1 : 0,
        tilt: tilt > 0 ? 1 : tilt < 0 ? -1 : 0,
      });
      this.render();
    };
    run();
    this._repeatHandle = setInterval(run, this.config.repeat_ms);
  }

  callLens(service, direction = 0) {
    this.executeLensPulse(service, direction);
  }

  handleCenter() {
    this.handleReturnHome();
    if (this.config.controls_mode === "toggle") {
      this._controlsVisible = true;
    }
  }

  gotoPreset(preset) {
    const cam = this.selectedCamera;
    if (!cam || !this._hass || !this.canPtz()) return;
    this._hass.callService("ha_hikvision_bridge", "goto_preset", {
      channel: String(cam.channel),
      preset,
    });
  }

  isOnline() {
    const cam = this.selectedCamera;
    if (!cam) return false;
    const refs = this.refsForChannel(cam.channel);
    const onlineEntity = refs.online ? this.getEntity(refs.online) : null;
    if (onlineEntity) return onlineEntity.state === "on";
    const cameraEntity = refs.camera ? this.getEntity(refs.camera) : null;
    return cameraEntity?.attributes?.online !== false;
  }

  canPtz() {
    const cam = this.selectedCamera;
    if (!cam) return false;
    const refs = this.refsForChannel(cam.channel);
    const ptzEntity = refs.ptz ? this.getEntity(refs.ptz) : null;
    if (ptzEntity) return this.isOnline() && ptzEntity.state === "on";
    const cameraEntity = refs.camera ? this.getEntity(refs.camera) : null;
    return this.isOnline() && cameraEntity?.attributes?.ptz_supported === true;
  }


getPlaybackPresets() {
  const source = Array.isArray(this.config.playback_presets) ? this.config.playback_presets : [1, 5, 10, 30, 60, 300, 600, 3600];
  const values = source.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

getPlaybackState(channel = null) {
  const cam = channel != null ? { channel } : this.selectedCamera;
  if (!cam) return { currentTime: "", paused: false, preset: 1 };
  const key = String(cam.channel);
  if (!this._playbackStateMap[key]) {
    const presets = this.getPlaybackPresets();
    this._playbackStateMap[key] = { currentTime: "", paused: false, preset: presets[0] || 1 };
  }
  return this._playbackStateMap[key];
}

formatDateTimeLocal(value = null) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

syncPlaybackState(cameraAttrs = {}) {
  const state = this.getPlaybackState();
  if (!state.currentTime) state.currentTime = this.formatDateTimeLocal();
  const requested = cameraAttrs.playback_requested_time;
  if (requested) state.currentTime = this.formatDateTimeLocal(requested);
  if (cameraAttrs.playback_active !== true) state.paused = false;
  return state;
}


formatPlaybackIndicatorState(cameraAttrs = {}, playbackState = null) {
  const state = playbackState || this.getPlaybackState();
  const playbackActive = cameraAttrs.playback_active === true && !!cameraAttrs.playback_uri;
  const paused = playbackActive && state?.paused === true;
  return {
    playbackActive,
    live: !playbackActive,
    paused,
    running: playbackActive && !paused,
    statusLabel: !playbackActive ? "Live" : paused ? "Paused" : "Playing",
  };
}

renderPlaybackOverlay(indicator = {}) {
  if (!indicator.playbackActive) return "";
  return `
    <div class="hik-video-overlay-badges">
      <span class="hik-video-badge recording"><span class="hik-rec-dot"></span>Playback</span>
      ${indicator.paused ? `<span class="hik-video-badge paused"><ha-icon icon="mdi:pause"></ha-icon>Paused</span>` : `<span class="hik-video-badge live-state"><ha-icon icon="mdi:play"></ha-icon>Playing</span>`}
    </div>
  `;
}

shouldShowPlaybackDebug(debugEntries = []) {
  return this.config.show_playback_debug === true && Array.isArray(debugEntries) && debugEntries.some((entry) => Number(entry?.response?.status || 0) !== 200 || entry?.ok === false || entry?.reason || entry?.error);
}

formatPlaybackDebugText(entry) {
  if (!entry) return "";

  const parts = [
    "=== Hikvision Playback Debug ===",
    `Reason: ${entry?.reason || entry?.error || `HTTP ${entry?.response?.status || "error"}`}`,
    `Track ID: ${entry?.track_id ?? ""}`,
    `Requested Time: ${entry?.requested_time ?? ""}`,
    `Search Start: ${entry?.search_start ?? ""}`,
    `Search End: ${entry?.search_end ?? ""}`,
    `HTTP Status: ${entry?.response?.status ?? ""}`,
    `Match Count: ${entry?.match_count ?? ""}`,
    "",
    "--- Request Body ---",
    entry?.request?.body || "",
    "",
    "--- Response Body ---",
    entry?.response?.body || "",
    "",
  ];

  return parts.join("\n");
}

copyPlaybackDebug(text) {
  const value = String(text || "");
  if (!value) return;
  navigator.clipboard.writeText(value).catch((err) => {
    console.error("Failed to copy playback debug text", err);
  });
}

downloadPlaybackDebug(text) {
  const value = String(text || "");
  if (!value) return;

  const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `hikvision-playback-debug-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

handleDebugAction(ev) {
  const button = ev.target.closest("[data-debug-action]");
  if (!button) return false;

  const container = button.closest(".hik-debug-block");
  const textarea = container?.querySelector(".hik-debug-textarea");
  const text = textarea?.value || textarea?.textContent || "";
  const action = button.getAttribute("data-debug-action");

  if (action === "copy") {
    this.copyPlaybackDebug(text);
    textarea?.focus();
    textarea?.select();
    return true;
  }

  if (action === "download") {
    this.downloadPlaybackDebug(text);
    return true;
  }

  return false;
}

renderControlsPanel({ online = false, ptz = false, speed = 50, cameraAlarmBadges = [] } = {}) {
  if (this.config.show_controls === false && !this._controlsVisible) return "";
  return `
    <div class="hik-panel hik-controls-block">
      <div class="hik-controls-head">
        <div class="hik-sub" style="margin:0;"><ha-icon icon="mdi:gamepad-round-up"></ha-icon>Controls</div>
      </div>

      ${this._controlsVisible ? `
        <div class="hik-ptz-shell">
          <div class="hik-console-surface hik-motion-console">
            <div class="hik-console-topbar">
              <div>
                <div class="hik-console-kicker">Motion Console</div>
              </div>
              <div class="hik-console-badges">
                <span class="hik-console-badge"><ha-icon icon="mdi:speedometer"></ha-icon>PTZ ${speed}</span>
                <span class="hik-console-badge"><ha-icon icon="mdi:timer-outline"></ha-icon>PTZ ${this.getPTZDuration()}ms</span>
                ${cameraAlarmBadges.length ? `<span class="hik-console-badge"><ha-icon icon="mdi:alert-outline"></ha-icon>${cameraAlarmBadges.length} alarm${cameraAlarmBadges.length === 1 ? "" : "s"}</span>` : ""}
                <button type="button" class="hik-btn hik-console-action" id="hik-refocus" ${(!online || this._returningHome) ? 'disabled' : ''}>
                  <ha-icon icon="mdi:image-auto-adjust"></ha-icon>
                  <span>Refocus</span>
                </button>
              </div>
            </div>

            <div class="hik-motion-grid">
              <div class="hik-rail zoom">
                <div class="hik-rail-head"><ha-icon icon="mdi:magnify-scan"></ha-icon><span>Zoom</span></div>
                <div class="hik-rail-stack vertical">
                  <button type="button" class="hik-rail-btn lens-btn" data-service="zoom" data-direction="1" ${(!online || this._returningHome) ? 'disabled' : ''} title="Zoom in" aria-label="Zoom in">
                    <ha-icon icon="mdi:magnify-plus-outline"></ha-icon>
                    <span class="hik-rail-sign">+</span>
                    <span class="hik-rail-text">In</span>
                  </button>
                  <button type="button" class="hik-rail-btn lens-btn" data-service="zoom" data-direction="-1" ${(!online || this._returningHome) ? 'disabled' : ''} title="Zoom out" aria-label="Zoom out">
                    <ha-icon icon="mdi:magnify-minus-outline"></ha-icon>
                    <span class="hik-rail-sign">−</span>
                    <span class="hik-rail-text">Out</span>
                  </button>
                </div>
              </div>

              <div class="hik-pad-shell">
                <div class="hik-pad-wrap">
                  <div class="hik-pad-stage">
                    <div class="hik-pad-meta-row">
                      <span class="hik-console-badge"><ha-icon icon="mdi:crosshairs-gps"></ha-icon>${ptz ? 'PTZ ready' : 'PTZ unavailable'}</span>
                    </div>
                    <div class="hik-pad">
                      <div></div>
                      ${this.iconButton({ icon: "mdi:pan-up", label: "Move up", cls: "ptz-btn", attrs: `data-pan="0" data-tilt="${speed}"`, disabled: !ptz || this._returningHome })}
                      <div></div>

                      ${this.iconButton({ icon: "mdi:pan-left", label: "Move left", cls: "ptz-btn", attrs: `data-pan="-${speed}" data-tilt="0"`, disabled: !ptz || this._returningHome })}
                      ${this.iconButton({ icon: "mdi:crosshairs-gps", label: "Return home", cls: "center", attrs: 'id="hik-center"', disabled: !ptz || this._returningHome })}
                      ${this.iconButton({ icon: "mdi:pan-right", label: "Move right", cls: "ptz-btn", attrs: `data-pan="${speed}" data-tilt="0"`, disabled: !ptz || this._returningHome })}

                      <div></div>
                      ${this.iconButton({ icon: "mdi:pan-down", label: "Move down", cls: "ptz-btn", attrs: `data-pan="0" data-tilt="-${speed}"`, disabled: !ptz || this._returningHome })}
                      <div></div>
                    </div>
                  </div>
                </div>
                <div class="hik-rail speed">
                  <div class="hik-speed-wrap">
                    <div class="hik-speed-label">
                      <span>PTZ speed</span>
                      <span class="hik-speed-value">${speed}</span>
                    </div>
                    <div class="hik-speed-track">
                      <input id="hik-speed" type="range" min="1" max="100" step="1" value="${speed}">
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="hik-console-surface hik-lens-console">
            <div class="hik-console-topbar">
              <div>
                <div class="hik-console-kicker">Lens Console</div>
              </div>
              <div class="hik-console-badges">
                <span class="hik-console-badge"><ha-icon icon="mdi:tune-variant"></ha-icon>Lens ${Number(this.config.lens_step || 60)}</span>
                <span class="hik-console-badge"><ha-icon icon="mdi:camera-control"></ha-icon>Lens ${this.getLensDuration()}ms</span>
              </div>
            </div>

            <div class="hik-lens-grid">
              <div class="hik-rail focus">
                <div class="hik-rail-head"><ha-icon icon="mdi:image-filter-center-focus"></ha-icon><span>Focus</span></div>
                <div class="hik-rail-stack horizontal lens-pair">
                  <button type="button" class="hik-rail-btn lens-btn" data-service="focus" data-direction="1" ${(!online || this._returningHome) ? 'disabled' : ''} title="Focus near" aria-label="Focus near">
                    <ha-icon icon="mdi:arrow-expand-horizontal"></ha-icon>
                    <span class="hik-rail-sign">+</span>
                    <span class="hik-rail-text">Near</span>
                  </button>
                  <button type="button" class="hik-rail-btn lens-btn" data-service="focus" data-direction="-1" ${(!online || this._returningHome) ? 'disabled' : ''} title="Focus far" aria-label="Focus far">
                    <ha-icon icon="mdi:arrow-collapse-horizontal"></ha-icon>
                    <span class="hik-rail-sign">−</span>
                    <span class="hik-rail-text">Far</span>
                  </button>
                </div>
              </div>

              <div class="hik-rail iris">
                <div class="hik-rail-head"><ha-icon icon="mdi:camera-iris"></ha-icon><span>Iris</span></div>
                <div class="hik-rail-stack horizontal lens-pair">
                  <button type="button" class="hik-rail-btn lens-btn" data-service="iris" data-direction="1" ${(!online || this._returningHome) ? 'disabled' : ''} title="Open iris" aria-label="Open iris">
                    <ha-icon icon="mdi:brightness-7"></ha-icon>
                    <span class="hik-rail-sign">+</span>
                    <span class="hik-rail-text">Open</span>
                  </button>
                  <button type="button" class="hik-rail-btn lens-btn" data-service="iris" data-direction="-1" ${(!online || this._returningHome) ? 'disabled' : ''} title="Close iris" aria-label="Close iris">
                    <ha-icon icon="mdi:brightness-5"></ha-icon>
                    <span class="hik-rail-sign">−</span>
                    <span class="hik-rail-text">Close</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ` : `
        <div class="hik-empty" style="text-align:center;">
          <div style="margin-bottom:8px;">Controls hidden</div>
          <div class="hik-mini-note">Use the toggle on the video panel to reveal the control console.</div>
        </div>
      `}
    </div>
  `;
}

renderPlaybackDebug(debugEntries = []) {
  if (!this.shouldShowPlaybackDebug(debugEntries)) return "";
  const failing = debugEntries.filter((entry) => Number(entry?.response?.status || 0) !== 200 || entry?.ok === false || entry?.reason || entry?.error).slice(-3).reverse();
  if (!failing.length) return "";
  return `
    <div class="hik-panel hik-info-card hik-playback-debug-panel">
      <div class="hik-sub"><ha-icon icon="mdi:bug-outline"></ha-icon>Playback Debug</div>
      <div class="hik-mini-note">Showing only failed or non-200 playback search attempts.</div>
      ${failing.map((entry, index) => {
        const debugText = this.formatPlaybackDebugText(entry);
        return `
        <div class="hik-debug-block">
          <div class="hik-status-row">
            <span class="hik-pill warn"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${this.escapeHtml(entry?.reason || entry?.error || `HTTP ${entry?.response?.status || 'error'}`)}</span>
            ${entry?.track_id ? `<span class="hik-pill neutral"><ha-icon icon="mdi:numeric"></ha-icon>Track ${this.escapeHtml(String(entry.track_id))}</span>` : ""}
          </div>
          ${entry?.requested_time ? `<div class="hik-mini-note">Requested ${this.escapeHtml(this.formatDateTimeLocal(entry.requested_time))}</div>` : ""}
          ${entry?.search_start || entry?.search_end ? `<div class="hik-mini-note">Search window ${this.escapeHtml(this.formatDateTimeLocal(entry.search_start || ""))} → ${this.escapeHtml(this.formatDateTimeLocal(entry.search_end || ""))}</div>` : ""}
          ${entry?.response?.status ? `<div class="hik-mini-note">HTTP ${this.escapeHtml(String(entry.response.status))}${entry?.match_count != null ? ` · Matches ${this.escapeHtml(String(entry.match_count))}` : ""}</div>` : ""}
          <div class="hik-debug-actions">
            <button class="hik-debug-btn" data-debug-index="${index}" data-debug-action="copy">Copy</button>
            <button class="hik-debug-btn" data-debug-index="${index}" data-debug-action="download">Download</button>
          </div>
          <textarea class="hik-debug-textarea" readonly>${this.escapeHtml(debugText)}</textarea>
          ${entry?.request?.body ? `<details ${index === 0 ? 'open' : ''}><summary>Request XML</summary><pre class="hik-debug-pre">${this.escapeHtml(entry.request.body)}</pre></details>` : ""}
          ${entry?.response?.body ? `<details><summary>Response body</summary><pre class="hik-debug-pre">${this.escapeHtml(entry.response.body)}</pre></details>` : ""}
        </div>
      `;}).join("")}
    </div>
  `;
}

formatPlaybackPreset(seconds) {
  const value = Number(seconds || 0);
  if (value >= 3600 && value % 3600 === 0) return `${value / 3600}h`;
  if (value >= 60 && value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

async startPlayback(timestamp = null) {
  const cam = this.selectedCamera;
  if (!cam || !this._hass) return;
  const refs = this.refsForChannel(cam.channel);
  if (!refs.camera) return;
  const state = this.getPlaybackState(cam.channel);
  const requested = timestamp || state.currentTime || this.formatDateTimeLocal();
  state.currentTime = requested;
  state.paused = false;
  this._pushDebug("playback", "info", "playback_start_requested", "Requested playback start", { requested_time: requested, entity_id: refs.camera }, "frontend");
  await this._hass.callService("ha_hikvision_bridge", "playback_seek", {
    entity_id: refs.camera,
    timestamp: requested,
  });
}

async stopPlayback() {
  const cam = this.selectedCamera;
  if (!cam || !this._hass) return;
  const refs = this.refsForChannel(cam.channel);
  if (!refs.camera) return;
  const state = this.getPlaybackState(cam.channel);
  state.paused = false;
  this._pushDebug("playback", "warn", "playback_stop_requested", "Requested return to live mode", { entity_id: refs.camera }, "frontend");
  await this._hass.callService("ha_hikvision_bridge", "playback_stop", {
    entity_id: refs.camera,
  });
}

pausePlayback() {
  const state = this.getPlaybackState();
  state.paused = true;
  this._pushDebug("playback", "warn", "playback_paused_locally", "Playback paused in the UI", { requested_time: state.currentTime || "" }, "frontend");
  this.render();
}

async resumePlayback() {
  const state = this.getPlaybackState();
  state.paused = false;
  this._pushDebug("playback", "info", "playback_resume_requested", "Requested playback resume", { requested_time: state.currentTime || "" }, "frontend");
  await this.startPlayback(state.currentTime || this.formatDateTimeLocal());
}

async seekPlayback(direction = 1) {
  const state = this.getPlaybackState();
  const seconds = Number(state.preset || 1) * Number(direction || 1);
  const base = state.currentTime ? new Date(state.currentTime) : new Date();
  if (Number.isNaN(base.getTime())) return;
  base.setSeconds(base.getSeconds() + seconds);
  state.currentTime = this.formatDateTimeLocal(base);
  this._pushDebug("playback", "info", "playback_seek_adjusted", direction < 0 ? "Playback seek moved backward" : "Playback seek moved forward", {
    direction: Number(direction || 1),
    seconds,
    requested_time: state.currentTime,
  }, "frontend");
  if (!state.paused) await this.startPlayback(state.currentTime);
  else this.render();
}

  selectCamera(index) {
    const cameras = this.cameras || [];
    if (!cameras.length) return;
    const nextIndex = Math.max(0, Math.min(Number(index) || 0, cameras.length - 1));
    if (nextIndex === this.selected) return;
    this.stopMove();
    this.selected = nextIndex;
    this._videoSignature = null;
    this._pushDebug("video", "info", "camera_selected", "Selected camera changed", { index: nextIndex, channel: cameras[nextIndex]?.channel, name: cameras[nextIndex]?.name || "" }, "frontend");
    this.render();
  }

  iconButton({ icon, label, cls = "", attrs = "", disabled = false, text = "" }) {
    return `
      <button type="button" class="hik-icon-btn ${cls}" ${attrs} ${disabled ? "disabled" : ""} title="${this.escapeHtml(label)}" aria-label="${this.escapeHtml(label)}">
        <ha-icon icon="${icon}"></ha-icon>
        ${text ? `<span>${this.escapeHtml(text)}</span>` : ""}
      </button>
    `;
  }

  lensControl({ title, icon, minusIcon, plusIcon, pending = true, online = false, serviceMinus = "", servicePlus = "", minusDirection = 0, plusDirection = 0, orientation = "vertical", compact = false, microLabel = "" }) {
    const disabled = !online || pending;
    const pendingText = pending ? '<div class="hik-mini-note">UI ready · backend wiring pending</div>' : "";
    const orientationClass = orientation === "horizontal" ? "horizontal" : "vertical";
    const label = this.escapeHtml(microLabel || title);
    return `
      <div class="hik-lens-card ${compact ? 'compact' : ''} ${orientationClass}">
        <div class="hik-lens-head">
          <div class="hik-lens-icon"><ha-icon icon="${icon}"></ha-icon></div>
          <div>
            <div class="hik-lens-title">${this.escapeHtml(title)}</div>
            <div class="hik-lens-kicker">${label}</div>
            ${pendingText}
          </div>
        </div>
        <div class="hik-lens-actions ${orientationClass}">
          ${this.iconButton({
            icon: minusIcon,
            label: `${title} down`,
            cls: `lens-btn lens-${orientationClass}`,
            attrs: serviceMinus ? `data-service="${serviceMinus}" data-direction="${minusDirection}"` : 'data-pending="true"',
            disabled,
            text: orientation === "horizontal" ? "–" : "−",
          })}
          ${this.iconButton({
            icon: plusIcon,
            label: `${title} up`,
            cls: `lens-btn lens-${orientationClass}`,
            attrs: servicePlus ? `data-service="${servicePlus}" data-direction="${plusDirection}"` : 'data-pending="true"',
            disabled,
            text: "+",
          })}
        </div>
      </div>
    `;
  }

  buildMetaGrid(items) {
    return `
      <div class="hik-meta">
        ${items.map(([label, value]) => `
          <div>
            <b>${this.escapeHtml(label)}</b>
            <span>${this.escapeHtml(value)}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  pickValue(sourceList, keys, fallback = "-") {
    const list = Array.isArray(sourceList) ? sourceList : [sourceList];
    for (const source of list) {
      if (!source) continue;
      for (const key of keys) {
        const value = source[key];
        if (value !== undefined && value !== null && value !== "") return value;
      }
    }
    return fallback;
  }



alarmOn(entityId) {
  const stateObj = entityId ? this.getEntity(entityId) : null;
  return stateObj ? String(stateObj.state).toLowerCase() === "on" : false;
}

collectCameraAlarmBadges(refs) {
  const badges = [];
  if (this.alarmOn(refs.motion)) badges.push({ icon: "mdi:motion-sensor", label: "Motion", level: "warn" });
  if (this.alarmOn(refs.videoLoss)) badges.push({ icon: "mdi:video-off-outline", label: "Video loss", level: "warn" });
  if (this.alarmOn(refs.intrusion)) badges.push({ icon: "mdi:shield-alert-outline", label: "Intrusion", level: "warn" });
  if (this.alarmOn(refs.lineCrossing)) badges.push({ icon: "mdi:vector-line", label: "Line crossing", level: "warn" });
  if (this.alarmOn(refs.tamper)) badges.push({ icon: "mdi:camera-lock-outline", label: "Tamper", level: "warn" });
  return badges;
}

collectNvrAlarmBadges(globalRefs, dvr = {}) {
  const badges = [];
  const activeCount = Number(this.pickValue([dvr], ["active_alarm_count"], 0)) || 0;
  if (this.alarmOn(globalRefs.diskFull)) badges.push({ icon: "mdi:harddisk", label: "Disk full", level: "warn" });
  if (this.alarmOn(globalRefs.diskError)) badges.push({ icon: "mdi:alert-circle-outline", label: "Disk warnings", level: "warn" });
  const activeInputs = (globalRefs.alarmInputs || []).filter((entityId) => this.alarmOn(entityId));
  activeInputs.forEach((entityId) => {
    const stateObj = this.getEntity(entityId);
    const name = stateObj?.attributes?.friendly_name || stateObj?.attributes?.name || entityId.split(".").pop().replaceAll("_", " ");
    badges.push({ icon: "mdi:alarm-light-outline", label: name, level: "warn" });
  });
  if (activeCount > 0) badges.unshift({ icon: "mdi:bell-alert-outline", label: `${activeCount} active alarm${activeCount === 1 ? "" : "s"}`, level: "warn" });
  return badges;
}

formatAlarmLabel(value) {
  return String(value || "-")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (m) => m.toUpperCase());
}


renderAlarmTable(rows = [], emptyText = "No alarm data") {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) {
    return `<div class="hik-empty-note">${this.escapeHtml(emptyText)}</div>`;
  }
  return `
    <div class="hik-alarm-table-wrap">
      <table class="hik-alarm-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          ${safeRows.map((row) => `
            <tr>
              <td>
                <span class="hik-alarm-name">
                  ${row.icon ? `<ha-icon icon="${this.escapeHtml(row.icon)}"></ha-icon>` : ""}
                  <span>${this.escapeHtml(row.name || "-")}</span>
                </span>
              </td>
              <td>
                <span class="hik-alarm-value ${this.escapeHtml(row.level || "neutral")}">${this.escapeHtml(row.value || "-")}</span>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

renderAlarmDashboard(globalRefs, dvr = {}, refs = {}, storageSummary = {}) {
  const activeCount = Number(this.pickValue([dvr], ["active_alarm_count"], 0)) || 0;
  const diskIssues = [globalRefs.diskFull, globalRefs.diskError].filter((entityId) => this.alarmOn(entityId)).length;
  const inputCount = (globalRefs.alarmInputs || []).filter((entityId) => this.alarmOn(entityId)).length;
  const cameraEvents = [
    ["Motion", refs.motion, "mdi:motion-sensor"],
    ["Video loss", refs.videoLoss, "mdi:video-off-outline"],
    ["Intrusion", refs.intrusion, "mdi:shield-alert-outline"],
    ["Line crossing", refs.lineCrossing, "mdi:vector-line"],
    ["Tamper", refs.tamper, "mdi:camera-lock-outline"],
  ];
  const activeCameraEvents = cameraEvents.filter(([, entityId]) => this.alarmOn(entityId));
  const cameraAlarmRows = cameraEvents.map(([label, entityId, icon]) => ({
    name: label,
    value: this.alarmOn(entityId) ? "Active" : "Idle",
    level: this.alarmOn(entityId) ? "warn" : "good",
    icon,
  }));
  const nvrAlarmRows = [
    {
      name: "Disk full",
      value: this.alarmOn(globalRefs.diskFull) ? "Active" : "Clear",
      level: this.alarmOn(globalRefs.diskFull) ? "warn" : "good",
      icon: "mdi:harddisk",
    },
    {
      name: "Disk warnings",
      value: this.alarmOn(globalRefs.diskError) ? "Active" : "Clear",
      level: this.alarmOn(globalRefs.diskError) ? "warn" : "good",
      icon: "mdi:alert-circle-outline",
    },
    ...(globalRefs.alarmInputs || []).map((entityId, index) => ({
      name: this.stateAttr(entityId, "friendly_name") || `Alarm input ${index + 1}`,
      value: this.alarmOn(entityId) ? "Active" : "Idle",
      level: this.alarmOn(entityId) ? "warn" : "good",
      icon: "mdi:alarm-light-outline",
    })),
  ];
  const lastType = this.formatAlarmLabel(this.pickValue([dvr], ["last_event_type"], "-"));
  const lastChannel = this.pickValue([dvr], ["last_event_channel"], "-");
  const lastState = this.formatAlarmLabel(this.pickValue([dvr], ["last_event_state"], "-"));
  const diskState = diskIssues ? "Warning" : this.pickValue(storageSummary, ["health"], "Healthy");
  const alarmSummaryRows = [
    {
      name: "Active alarms",
      value: String(activeCount),
      level: activeCount > 0 ? "warn" : "good",
      icon: "mdi:bell-alert-outline",
    },
    {
      name: "Disk warnings",
      value: diskIssues > 0 ? `${diskIssues} issue${diskIssues === 1 ? "" : "s"}` : String(diskState || "Healthy"),
      level: diskIssues > 0 ? "warn" : "good",
      icon: "mdi:alert-circle-outline",
    },
    {
      name: "Alarm inputs",
      value: inputCount > 0 ? `${inputCount} active` : "Idle",
      level: inputCount > 0 ? "warn" : "primary",
      icon: "mdi:alarm-light-outline",
    },
  ];
  const alarmMetaRows = [
    {
      name: "Last event",
      value: lastType,
      level: "neutral",
      icon: "mdi:history",
    },
    {
      name: "Channel / input",
      value: String(lastChannel),
      level: "neutral",
      icon: "mdi:camera-outline",
    },
    {
      name: "State",
      value: lastState,
      level: /active|triggered|alarm|warn/i.test(String(lastState || "")) ? "warn" : "good",
      icon: "mdi:state-machine",
    },
    {
      name: "Storage health",
      value: String(diskState || "-").replace(/^./, (m) => m.toUpperCase()),
      level: /warn|error|fault|bad|fail/i.test(String(diskState || "")) ? "warn" : "good",
      icon: "mdi:heart-pulse",
    },
  ];
  return `
    <div class="hik-panel hik-info-card hik-alarm-dashboard">
      <div class="hik-sub"><ha-icon icon="mdi:shield-home-outline"></ha-icon>Alarm Dashboard</div>
      <div class="hik-alarm-columns">
        <div class="hik-alarm-block">
          <div class="hik-mini-title">Alarm summary</div>
          ${this.renderAlarmTable(alarmSummaryRows, "No alarm summary available")}
        </div>
        <div class="hik-alarm-block">
          <div class="hik-mini-title">Event details</div>
          ${this.renderAlarmTable(alarmMetaRows, "No event details available")}
        </div>
      </div>
      <div class="hik-alarm-columns">
        <div class="hik-alarm-block">
          <div class="hik-mini-title">Selected camera</div>
          ${this.renderAlarmTable(cameraAlarmRows, activeCameraEvents.length ? "" : "No camera alarm data")}
        </div>
        <div class="hik-alarm-block">
          <div class="hik-mini-title">NVR alarms</div>
          ${this.renderAlarmTable(nvrAlarmRows, "No active NVR alarms")}
        </div>
      </div>
    </div>
  `;
}

  formatStorageSize(valueMb) {
    const value = Number(valueMb || 0);
    if (!Number.isFinite(value) || value < 0) return "-";
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} TB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
    return `${Math.round(value)} MB`;
  }

  normalizeDiskHealth(status) {
    const value = String(status || "unknown").trim().toLowerCase();
    if (["ok", "normal", "healthy", "rw"].includes(value)) return "green";
    if (["warning", "warn", "degraded", "rebuilding", "initializing", "formatting"].includes(value)) return "yellow";
    if (["error", "failed", "offline", "abnormal", "fault", "bad"].includes(value)) return "red";
    return "yellow";
  }

  humanizeDiskMode(value) {
    const raw = String(value || "").trim();
    if (!raw) return "-";
    return raw
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, (m) => m.toUpperCase());
  }

  summarizeStorage(attrs = {}, stateObj = null) {
    const sourceHdds = Array.isArray(attrs.hdds) ? attrs.hdds : [];
    const hdds = sourceHdds.map((disk, index) => {
      const capacityMb = Number(disk.capacity_mb ?? disk.capacity ?? 0) || 0;
      const freeMb = Number(disk.free_space_mb ?? disk.freeSpace ?? 0) || 0;
      const usedMb = Number(disk.used_space_mb ?? (capacityMb - freeMb) ?? 0) || 0;
      const status = disk.status || "unknown";
      return {
        ...disk,
        id: disk.id || String(index + 1),
        name: disk.name || disk.hddName || `HDD ${index + 1}`,
        type: disk.type || disk.hddType || "Disk",
        status,
        health_color: this.normalizeDiskHealth(status),
        capacity_mb: capacityMb,
        free_space_mb: freeMb,
        used_space_mb: Math.max(usedMb, 0),
        capacity_text: this.formatStorageSize(capacityMb),
        free_text: this.formatStorageSize(freeMb),
        used_text: this.formatStorageSize(Math.max(usedMb, 0)),
      };
    });
    const calcTotal = hdds.reduce((sum, disk) => sum + Number(disk.capacity_mb || 0), 0);
    const calcFree = hdds.reduce((sum, disk) => sum + Number(disk.free_space_mb || 0), 0);
    const calcUsed = hdds.reduce((sum, disk) => sum + Number(disk.used_space_mb || 0), 0);
    const totalRaw = Number(this.pickValue(attrs, ["total_capacity_mb", "storage_total", "total_capacity", "capacity_total", "hdd_total", "disk_total"], calcTotal || 0)) || calcTotal;
    const usedRaw = Number(this.pickValue(attrs, ["used_capacity_mb", "storage_used", "used_capacity", "capacity_used", "hdd_used", "disk_used"], calcUsed || 0)) || calcUsed;
    const freeRaw = Number(this.pickValue(attrs, ["free_capacity_mb", "storage_free", "free_capacity", "capacity_free", "hdd_free", "disk_free"], calcFree || 0)) || calcFree;
    const disks = Number(this.pickValue(attrs, ["disk_count", "hdd_count", "drives", "storage_disks"], hdds.length || 0)) || hdds.length;
    const failedDisks = Number(this.pickValue(attrs, ["failed_disks"], hdds.filter((disk) => disk.health_color === "red").length || 0)) || 0;
    const warningDisks = hdds.filter((disk) => disk.health_color === "yellow").length;
    const diskMode = this.humanizeDiskMode(this.pickValue(attrs, ["disk_mode"], "-"));
    const health = failedDisks > 0 ? "Critical" : (warningDisks > 0 ? "Warning" : "Healthy");
    return {
      total: this.formatStorageSize(totalRaw),
      used: this.formatStorageSize(usedRaw),
      free: this.formatStorageSize(freeRaw),
      totalRaw,
      usedRaw,
      freeRaw,
      disks,
      diskMode,
      health,
      hdds,
    };
  }


  _isWebRtcMode(streamMode, playbackUri = "") {
    const requestedMode = String(streamMode || this.config.video_mode || "rtsp_direct").toLowerCase();
    return Boolean(playbackUri) || requestedMode === "webrtc" || requestedMode === "webrtc_direct";
  }

  _getTalkMode() {
    return String(this.config.talk_mode || "hold").toLowerCase() === "toggle" ? "toggle" : "hold";
  }

  _getVideoVolumeFraction() {
    return Math.max(0, Math.min(1, Number(this._volume || 0) / 100));
  }

  _getAudioBoostMultiplier() {
    return Math.max(1, Math.min(3, Number(this._audioBoost || 100) / 100));
  }

  _teardownAudioGraph() {
    if (this._audioMeterRaf) {
      cancelAnimationFrame(this._audioMeterRaf);
      this._audioMeterRaf = null;
    }
    if (this._audioGraph?.source) {
      try { this._audioGraph.source.disconnect(); } catch (err) {}
    }
    if (this._audioGraph?.analyser) {
      try { this._audioGraph.analyser.disconnect(); } catch (err) {}
    }
    if (this._audioGraph?.gain) {
      try { this._audioGraph.gain.disconnect(); } catch (err) {}
    }
    if (this._audioGraph?.context) {
      try { this._audioGraph.context.close(); } catch (err) {}
    }
    this._audioGraph = null;
    this._audioGraphElement = null;
    this._audioMeterLevel = 0;
  }

  _findNestedMediaElement(root) {
    if (!root) return null;
    if (typeof root.matches === "function" && (root.matches("video") || root.matches("audio"))) return root;
    if (typeof root.querySelector === "function") {
      const direct = root.querySelector("video, audio");
      if (direct) return direct;
    }
    const nodes = root.children ? Array.from(root.children) : [];
    for (const node of nodes) {
      if (node.shadowRoot) {
        const nested = this._findNestedMediaElement(node.shadowRoot);
        if (nested) return nested;
      }
      const nested = this._findNestedMediaElement(node);
      if (nested) return nested;
    }
    return null;
  }

  _updateAudioMeter() {
    if (!this._audioGraph?.analyser) return;
    try {
      const analyser = this._audioGraph.analyser;
      const data = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = Math.abs(data[i] - 128) / 128;
        if (value > peak) peak = value;
      }
      this._audioMeterLevel = Math.max(0, Math.min(1, peak * 2.2));
      const meter = this.querySelector(".hik-audio-meter-fill");
      if (meter) meter.style.setProperty("--hik-audio-level", `${Math.round(this._audioMeterLevel * 100)}%`);
    } catch (err) {
      this._audioMeterLevel = 0;
    }
    this._audioMeterRaf = requestAnimationFrame(() => this._updateAudioMeter());
  }

  async _ensureAudioGraph(mediaElement) {
    if (!mediaElement || !mediaElement.captureStream) {
      this._applyAudioFallback(mediaElement);
      return;
    }
    if (this._audioGraphElement === mediaElement && this._audioGraph) {
      this._syncAudioGraphState(mediaElement);
      return;
    }
    this._teardownAudioGraph();
    try {
      const stream = mediaElement.captureStream();
      if (!stream || !stream.getAudioTracks().length) {
        this._applyAudioFallback(mediaElement);
        return;
      }
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        this._applyAudioFallback(mediaElement);
        return;
      }
      const context = new AudioCtx();
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(context.destination);
      this._audioGraph = { context, source, gain, analyser };
      this._audioGraphElement = mediaElement;
      this._syncAudioGraphState(mediaElement);
      this._updateAudioMeter();
    } catch (err) {
      this._teardownAudioGraph();
      this._applyAudioFallback(mediaElement);
    }
  }

  _applyAudioFallback(mediaElement) {
    if (!mediaElement) return;
    mediaElement.muted = !this._speakerEnabled || (this._talkRequested && this.config.mute_during_talk !== false);
    mediaElement.volume = this._getVideoVolumeFraction();
  }

  _syncAudioGraphState(mediaElement = this._audioGraphElement) {
    if (!this._audioGraph?.gain || !mediaElement) {
      this._applyAudioFallback(mediaElement);
      return;
    }
    const gainValue = this._speakerEnabled ? (this._getVideoVolumeFraction() * this._getAudioBoostMultiplier()) : 0;
    this._audioGraph.gain.gain.value = gainValue;
    mediaElement.volume = 0;
    mediaElement.muted = true;
    if (this._audioGraph.context?.state === "suspended" && this._speakerEnabled) {
      this._audioGraph.context.resume().catch(() => {});
    }
  }

  _syncMediaAudio() {
    requestAnimationFrame(() => {
      const host = this.querySelector("#hikvision-video-host");
      const mediaElement = this._findNestedMediaElement(host);
      if (!mediaElement) return;
      this._ensureAudioGraph(mediaElement);
    });
  }

  _setSpeakerEnabled(enabled) {
    this._speakerEnabled = Boolean(enabled);
    this._syncAudioGraphState();
    this._applyAudioFallback(this._audioGraphElement || this._findNestedMediaElement(this.querySelector("#hikvision-video-host")));
    this.render();
  }

  _setVolume(value) {
    this._volume = Math.max(0, Math.min(100, Number(value) || 0));
    this._syncAudioGraphState();
    this._applyAudioFallback(this._audioGraphElement || this._findNestedMediaElement(this.querySelector("#hikvision-video-host")));
    const label = this.querySelector(".hik-volume-value");
    if (label) label.textContent = `${Math.round(this._volume)}%`;
  }

  _setAudioBoost(value) {
    this._audioBoost = Math.max(100, Math.min(300, Number(value) || 100));
    this._syncAudioGraphState();
    const label = this.querySelector(".hik-boost-value");
    if (label) label.textContent = `${(this._audioBoost / 100).toFixed(1)}×`;
  }

  async _setTalkActive(active) {
    const next = Boolean(active);

    if (!next) {
      if (!this._talkRequested && !this._talkActive) return;
      this._talkRequested = false;
      this._talkLatched = false;
      this._stopTalkbackDirect();
      this._syncAudioGraphState();
      this._applyAudioFallback(this._audioGraphElement || this._findNestedMediaElement(this.querySelector("#hikvision-video-host")));
      this.render();
      return;
    }

    if (this._talkRequested || this._talkActive) return;
    this._talkRequested = true;

    try {
      await this._startTalkbackDirect();
    } catch (err) {
      this._talkRequested = false;
      this._talkLatched = false;
      this._detachTalkReleaseListeners();
    }

    this._syncAudioGraphState();
    this._applyAudioFallback(this._audioGraphElement || this._findNestedMediaElement(this.querySelector("#hikvision-video-host")));
    this.render();
  }

  _handleTalkButtonDown(ev) {
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    if (this._getTalkMode() === "toggle") return;
    if (ev?.button != null && ev.button !== 0) return;
    if (this._talkHoldActive) return;
    this._talkHoldActive = true;
    this._attachTalkReleaseListeners(ev?.currentTarget || ev?.target || null, ev?.pointerId ?? null);
    this._setTalkActive(true).catch(() => {});
  }

  _handleTalkButtonUp(ev) {
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    if (this._getTalkMode() === "toggle") return;
    if (!this._talkHoldActive && !this._talkRequested && !this._talkActive) return;
    this._detachTalkReleaseListeners();
    this._setTalkActive(false).catch(() => {});
  }

  _bindHoldTalkButton(button) {
    if (!button) return;
    const down = (ev) => this._handleTalkButtonDown(ev);
    const up = (ev) => this._handleTalkButtonUp(ev);
    const suppress = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    if (window.PointerEvent) {
      button.onpointerdown = down;
      button.onpointerup = up;
      button.onpointercancel = up;
      button.onlostpointercapture = up;
    } else {
      button.onmousedown = down;
      button.onmouseup = up;
      button.onmouseleave = up;
      button.ontouchstart = down;
      button.ontouchend = up;
      button.ontouchcancel = up;
    }
    button.onclick = suppress;
    button.oncontextmenu = suppress;
    button.style.touchAction = "none";
    button.style.userSelect = "none";
  }

  _handleTalkToggle(ev) {
    ev.preventDefault();
    if (this._getTalkMode() !== "toggle") return;
    this._talkLatched = !this._talkLatched;
    this._setTalkActive(this._talkLatched).catch(() => {});
  }

  _renderAudioControls(streamMode, playbackActive = false) {
    if (this.config.show_audio_controls === false) return "";
    const isWebRtc = this._isWebRtcMode(streamMode, playbackActive ? "playback" : "");
    const muteDuringTalk = this.config.mute_during_talk !== false;
    const talkMode = this._getTalkMode();
    const speakerActive = this._speakerEnabled && !(this._talkRequested && muteDuringTalk);
    const speakerIcon = speakerActive ? "mdi:volume-high" : "mdi:volume-off";
    const speakerLabel = !this._speakerEnabled ? "Speaker off" : (this._talkRequested && muteDuringTalk ? "Speaker muted during talk" : "Speaker on");
    const talkLabel = talkMode === "toggle"
      ? (this._talkRequested ? "End talk" : "Start talk")
      : (this._talkRequested ? "Talking…" : "Hold to talk");
    const talkAttrs = talkMode === "toggle"
      ? 'id="hik-talk-toggle"'
      : 'id="hik-talk-hold"';
    const talkHandlers = talkMode === "toggle"
      ? ""
      : `data-hold-talk="true"`;
    return `
      <div class="hik-audio-panel">
        <div class="hik-audio-head">
          <div class="hik-sub" style="margin:0;"><ha-icon icon="mdi:volume-source"></ha-icon>Audio Console</div>
          <div class="hik-audio-pills">
            <span class="hik-pill ${speakerActive ? "good" : "neutral"}"><ha-icon icon="${speakerIcon}"></ha-icon>${speakerLabel}</span>
            <span class="hik-pill ${isWebRtc ? "primary" : "neutral"}"><ha-icon icon="${isWebRtc ? "mdi:wan" : "mdi:lan"}"></ha-icon>${isWebRtc ? "WebRTC audio path" : "Receive-only mode"}</span>
            ${isWebRtc ? `<span class="hik-pill ${this._talkRequested ? "warn" : "neutral"}"><ha-icon icon="mdi:microphone${this._talkRequested ? '' : '-off'}"></ha-icon>${this._talkRequested ? "Mic live" : "Mic standby"}</span>` : ""}
          </div>
        </div>
        <div class="hik-audio-grid">
          <button type="button" class="hik-btn hik-audio-btn ${speakerActive ? "is-on" : ""}" id="hik-speaker-toggle">
            <ha-icon icon="${speakerIcon}"></ha-icon>
            <span>${this._speakerEnabled ? "Mute speaker" : "Enable speaker"}</span>
          </button>
          <label class="hik-audio-slider">
            <span>Volume <b class="hik-volume-value">${Math.round(this._volume)}%</b></span>
            <input id="hik-volume" type="range" min="0" max="100" step="1" value="${Math.round(this._volume)}">
          </label>
          <label class="hik-audio-slider">
            <span>Boost <b class="hik-boost-value">${(this._audioBoost / 100).toFixed(1)}×</b></span>
            <input id="hik-audio-boost" type="range" min="100" max="300" step="10" value="${Math.round(this._audioBoost)}">
          </label>
          ${isWebRtc && !playbackActive ? `
            <button type="button" class="hik-btn hik-audio-btn hik-talk-btn ${this._talkRequested ? "live" : ""}" ${talkAttrs} ${talkHandlers} aria-pressed="${this._talkRequested ? "true" : "false"}">
              <ha-icon icon="mdi:microphone"></ha-icon>
              <span>${talkLabel}</span>
            </button>
          ` : `
            <div class="hik-audio-note">
              <ha-icon icon="mdi:information-outline"></ha-icon>
              <span>${playbackActive ? "Talk is disabled during playback." : "Microphone controls appear only in WebRTC mode."}</span>
            </div>
          `}
        </div>
        <div class="hik-audio-meter" title="Output level meter">
          <div class="hik-audio-meter-fill" style="--hik-audio-level:${Math.round(this._audioMeterLevel * 100)}%;"></div>
        </div>
        <div class="hik-mini-note">${muteDuringTalk ? "Speaker auto-mutes while you talk to prevent feedback." : "Speaker remains active while talking."}${isWebRtc ? ` Talk mode: ${talkMode}.` : ""}</div>
      </div>
    `;
  }

  renderVideo(cameraEntityId, rtspUrl, directRtspUrl, streamMode, playbackUri = "", playbackPaused = false) {
    const host = this.querySelector("#hikvision-video-host");
    if (!host) return;

    const requestedMode = String(streamMode || this.config.video_mode || "rtsp_direct").toLowerCase();
    const playbackMode = Boolean(playbackUri);
    const useWebRtc = playbackMode || requestedMode === "webrtc" || requestedMode === "webrtc_direct";
    const useSnapshot = !playbackMode && requestedMode === "snapshot";
    const preferredRtspUrl = playbackMode ? playbackUri : (requestedMode === "webrtc_direct" || requestedMode === "rtsp_direct" ? (directRtspUrl || rtspUrl) : (rtspUrl || directRtspUrl));
    this._preferredRtspUrl = preferredRtspUrl || "";
    const signature = JSON.stringify({
      entity: cameraEntityId || "",
      rtsp: preferredRtspUrl || "",
      mode: playbackMode ? "playback" : requestedMode,
      paused: playbackPaused ? 1 : 0,
    });

    if (this._lastRenderedVideoSignature !== signature) {
      this._lastRenderedVideoSignature = signature;
      this._pushDebug("video", playbackMode ? "info" : "debug", "video_render_requested", playbackMode ? "Rendering playback video path" : "Rendering live video path", {
        camera_entity: cameraEntityId || "",
        requested_mode: requestedMode,
        playback_mode: playbackMode,
        use_webrtc: useWebRtc,
        use_snapshot: useSnapshot,
      }, "frontend");
    }

    if (playbackPaused) {
      if (this._videoSignature !== signature) {
        this._cleanupVideoCard();
        this._pushDebug("video", "warn", "playback_paused", "Playback render paused", { camera_entity: cameraEntityId || "" }, "frontend");
        host.innerHTML = `<div class="hik-empty">Playback paused</div>`;
        this._videoSignature = signature;
      }
      return;
    }

    if (!cameraEntityId || !this.getEntity(cameraEntityId)) {
      if (this._videoSignature !== "missing-camera") {
        this._cleanupVideoCard();
        this._pushDebug("video", "error", "missing_camera_entity", "No camera entity available for video render", { camera_entity: cameraEntityId || "" }, "frontend");
        host.innerHTML = `<div class="hik-empty">No camera entity available</div>`;
        this._videoSignature = "missing-camera";
      }
      return;
    }

    if (this._videoSignature === signature && this._videoCard) {
      this._videoCard.hass = this._hass;
      this._syncWebRtcCardConfig(playbackMode);
      if (this._videoCard.parentNode !== host) {
        host.innerHTML = "";
        host.appendChild(this._videoCard);
      }
      return;
    }

    this._cleanupVideoCard();
    host.innerHTML = "";
    this._videoSignature = signature;

    if (useWebRtc && preferredRtspUrl) {
      window.loadCardHelpers().then(async (helpers) => {
        if (this._videoSignature !== signature) return;
        try {
          const webrtcConfig = this._buildWebRtcCardConfig(preferredRtspUrl, playbackMode);
          const webrtcCard = await helpers.createCardElement(webrtcConfig);
          if (this._videoSignature !== signature) {
            if (typeof webrtcCard.remove === "function") webrtcCard.remove();
            return;
          }
          webrtcCard.hass = this._hass;
          host.innerHTML = "";
          host.appendChild(webrtcCard);
          this._videoCard = webrtcCard;
          this._videoCardConfig = webrtcConfig;
          this._pushDebug("video", "info", "webrtc_card_ready", "WebRTC card created successfully", { playback_mode: playbackMode, url: preferredRtspUrl || "" }, "frontend");
          this._syncMediaAudio();
        } catch (err) {
          this._pushDebug("video", "error", "webrtc_card_failed", "WebRTC card failed to start", { error: String(err?.message || err) }, "frontend");
          if (this._videoSignature === signature) host.innerHTML = `<div class="hik-empty">WebRTC card is not available or failed to start. Switch stream mode to RTSP.</div>`;
        }
      }).catch((err) => {
        this._pushDebug("video", "error", "webrtc_helpers_failed", "WebRTC helpers failed to load", { error: String(err?.message || err || "unknown") }, "frontend");
        if (this._videoSignature === signature) host.innerHTML = `<div class="hik-empty">WebRTC helpers failed to load.</div>`;
      });
      return;
    }

    window.loadCardHelpers().then(async (helpers) => {
      if (this._videoSignature !== signature) return;
      try {
        const videoCard = await helpers.createCardElement({
          type: "picture-entity",
          entity: cameraEntityId,
          camera_view: useSnapshot ? "auto" : "live",
          show_name: false,
          show_state: false,
        });
        if (this._videoSignature !== signature) {
          if (typeof videoCard.remove === "function") videoCard.remove();
          return;
        }
        videoCard.hass = this._hass;
        host.innerHTML = "";
        host.appendChild(videoCard);
        this._videoCard = videoCard;
        this._pushDebug("video", "info", "video_card_ready", "Video card created successfully", { camera_entity: cameraEntityId || "", snapshot_mode: useSnapshot }, "frontend");
        this._syncMediaAudio();
      } catch (err) {
        this._pushDebug("video", "error", "video_card_failed", "Unable to create live video card", { error: String(err?.message || err) }, "frontend");
        if (this._videoSignature === signature) host.innerHTML = `<div class="hik-empty">Unable to create live video card</div>`;
      }
    }).catch((err) => {
      this._pushDebug("video", "error", "card_helpers_failed", "Unable to load card helpers", { error: String(err?.message || err || "unknown") }, "frontend");
      if (this._videoSignature === signature) host.innerHTML = `<div class="hik-empty">Unable to load card helpers</div>`;
    });
  }

  render() {
    if (!this._hass) return;
    const cameras = this.cameras || [];
    const cam = this.selectedCamera;
    if (!cameras.length || !cam) {
      this.innerHTML = `<ha-card><div style="padding:16px;"><div style="font-size:18px;font-weight:600;margin-bottom:8px;">${this.escapeHtml(this.config.title)}</div><div>No connected cameras found</div></div></ha-card>`;
      return;
    }

    const refs = this.refsForChannel(cam.channel);
    const infoEntity = refs.info ? this.getEntity(refs.info) : null;
    const streamEntity = refs.stream ? this.getEntity(refs.stream) : null;
    const cameraEntity = refs.camera ? this.getEntity(refs.camera) : null;
    const onlineEntity = refs.online ? this.getEntity(refs.online) : null;
    const ptzEntity = refs.ptz ? this.getEntity(refs.ptz) : null;
    const globalRefs = this.findGlobalEntities();
    const dvrEntity = globalRefs.dvr ? this.getEntity(globalRefs.dvr) : null;
    const storageEntity = globalRefs.storage ? this.getEntity(globalRefs.storage) : null;

    const info = infoEntity?.attributes || {};
    const stream = streamEntity?.attributes || {};
    const camAttrs = cameraEntity?.attributes || {};
    const dvr = dvrEntity?.attributes || {};
    const storage = storageEntity?.attributes || {};
    const storageSummary = this.summarizeStorage(storage, storageEntity);
    const online = onlineEntity ? onlineEntity.state === "on" : camAttrs.online !== false;
    const ptz = ptzEntity ? ptzEntity.state === "on" : camAttrs.ptz_supported === true;
    const presets = cam.presets || [];
    const speed = Number(this.config.speed || 50);
    const streamProfile = String(camAttrs.stream_profile || stream.stream_profile || info.stream_profile || "main").toLowerCase();
    const streamProfileLabel = streamProfile === "sub" ? "Sub-stream" : "Main-stream";
    const rtspUrl = camAttrs.rtsp_url || stream.rtsp_url || info.rtsp_url || "";
    const directRtspUrl = camAttrs.rtsp_direct_url || stream.rtsp_direct_url || info.rtsp_direct_url || "";
    const entityName = refs.camera || "-";
    const ptzMode = camAttrs.ptz_control_method || info.ptz_control_method || (camAttrs.ptz_proxy_supported ? "proxy" : (camAttrs.ptz_direct_supported ? "direct" : "none"));
    const streamMode = String(camAttrs.stream_mode || "rtsp_direct").toLowerCase();
    const videoMethod = camAttrs.video_method || (streamMode === "snapshot" ? "Snapshot" : streamMode === "webrtc_direct" ? "WebRTC Direct" : streamMode === "webrtc" ? "WebRTC" : streamMode === "rtsp_direct" ? "RTSP Direct" : "RTSP");
    const playbackState = this.syncPlaybackState(camAttrs);
    const playbackPresets = this.getPlaybackPresets();
    if (!playbackPresets.includes(Number(playbackState.preset))) playbackState.preset = playbackPresets[0] || 1;
    const playbackIndicator = this.formatPlaybackIndicatorState(camAttrs, playbackState);
    const playbackActive = playbackIndicator.playbackActive;
    const cameraAlarmBadges = this.collectCameraAlarmBadges(refs);
    const nvrAlarmBadges = this.collectNvrAlarmBadges(globalRefs, dvr);
    const accent = this.normalizeColor(this.config.accent_color);
    const panelTint = Math.max(0, Math.min(24, Number(this.config.panel_tint || 8)));
    const controlsMode = this.config.controls_mode || "always";
    const speedPlacement = String(this.config.speed_position || (this.config.speed_orientation === "horizontal" ? "below" : "right")).toLowerCase();
    const padLayoutClass = ["left", "right"].includes(speedPlacement) ? "pad-layout-side" : "pad-layout-stack";
    const infoCards = [];

    if (this.config.show_camera_info !== false) {
      infoCards.push(`
        <div class="hik-panel hik-info-card">
          <div class="hik-sub"><ha-icon icon="mdi:information-outline"></ha-icon>Camera Info</div>
          ${this.buildMetaGrid([
            ["Entity", entityName],
            ["Channel", String(cam.channel || this.pickValue([info, camAttrs], ["channel"], "-"))],
            ["Model", this.pickValue([info, camAttrs], ["model"], "-")],
            ["IP", this.pickValue([info, camAttrs], ["ip_address", "ip"], "-")],
            ["Manage port", this.pickValue([info, camAttrs], ["manage_port"], "-")],
            ["Control method", ptzMode || "-"],
            ["Firmware", this.pickValue([info, camAttrs], ["firmware_version", "firmware"], "-")],
            ["Serial", this.pickValue([info, camAttrs], ["serial_number", "serial"], "-")],
          ])}
        </div>
      `);
    }

    if (this.config.show_stream_info !== false) {
      infoCards.push(`
        <div class="hik-panel hik-info-card">
          <div class="hik-sub"><ha-icon icon="mdi:video-wireless-outline"></ha-icon>Stream Info</div>
          <div class="hik-select-group" style="margin-bottom:12px;">
            <div class="hik-select-wrap">
              <ha-icon icon="mdi:camera-switch"></ha-icon>
              <label for="streamProfile" style="font-size:12px; opacity:0.8;">Channel stream</label>
            </div>
            <div class="hik-select-wrap">
              <select id="streamProfile" class="hik-select">
                <option value="main" ${streamProfile === "main" ? "selected" : ""}>Main-stream</option>
                <option value="sub" ${streamProfile === "sub" ? "selected" : ""}>Sub-stream</option>
              </select>
            </div>
          </div>
          ${this.buildMetaGrid([
            ["Profile", streamProfileLabel],
            ["Stream", streamEntity?.state || cameraEntity?.state || "-"],
            ["Stream ID", camAttrs.stream_id || stream.stream_id || info.stream_id || "-"],
            ["Transport", camAttrs.stream_transport || stream.transport || "-"],
            ["Bitrate mode", camAttrs.stream_bitrate_mode || stream.bitrate_mode || "-"],
            ["Bitrate", camAttrs.stream_bitrate || stream.constant_bitrate || stream.bitrate || "-"],
            ["Max frame rate", camAttrs.stream_max_frame_rate || stream.max_frame_rate || stream.frame_rate || "-"],
            ["Audio codec", camAttrs.stream_audio_codec || stream.audio_codec || "-"],
          ])}
          <div style="margin-top:12px;">
            <b>RTSP URL</b>
            <div class="hik-code">${this.escapeHtml(rtspUrl || "-")}</div>
          </div>
          <div style="margin-top:12px;">
            <b>Direct RTSP URL</b>
            <div class="hik-code">${this.escapeHtml(directRtspUrl || "-")}</div>
          </div>
        </div>
      `);
    }


    if (this.config.show_stream_mode_info !== false) {
      infoCards.push(`
      <div class="hik-panel hik-info-card">
        <div class="hik-sub"><ha-icon icon="mdi:transit-connection-variant"></ha-icon>Stream Mode Info</div>
        <div class="hik-select-group" style="margin-bottom:12px;">
          <div class="hik-select-wrap">
            <ha-icon icon="mdi:transit-connection-variant"></ha-icon>
            <label for="streamMode" style="font-size:12px; opacity:0.8;">Stream mode</label>
          </div>
          <div class="hik-select-wrap">
            <select id="streamMode" class="hik-select">
              <option value="webrtc_direct" ${streamMode === "webrtc_direct" ? "selected" : ""}>WebRTC (Direct RTSP)</option>
              <option value="webrtc" ${streamMode === "webrtc" ? "selected" : ""}>WebRTC (ISAPI RTSP)</option>
              <option value="rtsp_direct" ${streamMode === "rtsp_direct" ? "selected" : ""}>RTSP (Direct)</option>
              <option value="rtsp" ${streamMode === "rtsp" ? "selected" : ""}>RTSP (ISAPI)</option>
              <option value="snapshot" ${streamMode === "snapshot" ? "selected" : ""}>Snapshot</option>
            </select>
          </div>
        </div>
        ${this.buildMetaGrid([
          ["Current mode", videoMethod],
          ["Requested mode", streamMode || "-"],
          ["WebRTC path", ["webrtc", "webrtc_direct"].includes(streamMode) ? "Enabled" : "Disabled"],
          ["RTSP source", streamMode === "webrtc_direct" || streamMode === "rtsp_direct" ? "Direct RTSP" : streamMode === "snapshot" ? "Camera snapshot" : "ISAPI RTSP"],
          ["Live view", streamMode === "snapshot" ? "Snapshot" : "Live"],
          ["Muted UI", ["webrtc", "webrtc_direct"].includes(streamMode) ? "Yes" : "Managed by HA card"],
          ["Card helper", ["webrtc", "webrtc_direct"].includes(streamMode) ? "custom:webrtc-camera" : "picture-entity"],
          ["Preferred URL", streamMode === "webrtc_direct" || streamMode === "rtsp_direct" ? (directRtspUrl || "-") : (rtspUrl || directRtspUrl || "-")],
        ])}
      </div>
    `);
    }

    if (this.config.show_alarm_dashboard !== false) {
      infoCards.push(this.renderAlarmDashboard(globalRefs, dvr, refs, storageSummary));
    }

    if (this.config.show_dvr_info !== false) {
      infoCards.push(`
        <div class="hik-panel hik-info-card">
          <div class="hik-sub"><ha-icon icon="mdi:server"></ha-icon>NVR System Info</div>
          ${this.buildMetaGrid([
            ["Entity", globalRefs.dvr || "Auto-detect pending"],
            ["Name", this.pickValue([dvr], ["device_name", "friendly_name", "dvr_name", "nvr_name"], dvrEntity?.state || "-")],
            ["Model", this.pickValue([dvr], ["model", "device_model", "system_model"], "-")],
            ["Vendor", this.pickValue([dvr], ["manufacturer", "vendor", "brand"], "Hikvision")],
            ["Firmware", this.pickValue([dvr], ["firmware_version", "firmware", "software_version"], "-")],
            ["Serial", this.pickValue([dvr], ["serial_number", "serial"], "-")],
            ["Alarm stream", this.alarmOn(globalRefs.alarmStream) ? "Connected" : "Disconnected"],
            ["Active alarms", this.pickValue([dvr], ["active_alarm_count"], nvrAlarmBadges.filter((badge) => badge.level === "warn").length || 0)],
            ["Work mode", this.pickValue([dvr, storage], ["work_mode"], "-")],
          ])}
          ${nvrAlarmBadges.length ? `<div class="hik-status-row">${nvrAlarmBadges.map((badge) => `<span class="hik-pill ${badge.level || "warn"}"><ha-icon icon="${badge.icon}"></ha-icon>${this.escapeHtml(badge.label)}</span>`).join("")}</div>` : ""}
        </div>
      `);
    }

    if (this.config.show_storage_info !== false) {
      infoCards.push(`
        <div class="hik-panel hik-info-card">
          <div class="hik-sub"><ha-icon icon="mdi:harddisk"></ha-icon>NVR Storage Info</div>
          ${this.buildMetaGrid([
            ["Entity", globalRefs.dvr || globalRefs.storage || "Auto-detect pending"],
            ["Disk mode", storageSummary.diskMode],
            ["Total capacity", storageSummary.total],
            ["Total used", storageSummary.used],
            ["Total free", storageSummary.free],
            ["Disks", storageSummary.disks],
            ["Overall health", storageSummary.health],
          ])}
          ${(storageSummary.hdds || []).length ? `<div class="hik-storage-list">${storageSummary.hdds.map((disk) => `
            <div class="hik-storage-item ${this.escapeHtml(disk.health_color || "yellow")}">
              <div class="hik-storage-row">
                <b>${this.escapeHtml(disk.name || `HDD ${disk.id || "?"}`)}</b>
                <span class="hik-health-chip ${this.escapeHtml(disk.health_color || "yellow")}"><span class="hik-health-dot"></span>${this.escapeHtml(String(disk.status || "unknown").toUpperCase())}</span>
              </div>
              <span>${this.escapeHtml(`${disk.type || "Disk"} · Size ${disk.capacity_text}`)}</span>
              <span>${this.escapeHtml(`Used ${disk.used_text} · Free ${disk.free_text}`)}</span>
            </div>`).join("")}</div>` : `<div class="hik-empty-note">No HDD data available</div>`}
        </div>
      `);
    }

    const preservedVideoHost = this._preserveVideoHost();

    this.innerHTML = `
      <ha-card data-entity="${this.escapeHtml(entityName)}" style="--hik-accent:${accent};--hik-panel-tint:${panelTint}%;">
        <style>
          .hik-wrap { padding: 14px; }
          .hik-titlebar { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom: 14px; }
          .hik-title { font-size: 20px; font-weight: 700; line-height: 1.2; }
          .hik-subtitle { font-size: 12px; opacity: 0.72; margin-top: 4px; }
          .hik-chip-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
          .hik-chip { border:none; border-radius:999px; padding:8px 12px; cursor:pointer; background: var(--secondary-background-color); color: var(--primary-text-color); display:flex; align-items:center; gap:8px; transition: transform 0.15s ease, box-shadow 0.15s ease; }
          .hik-chip:hover { transform: translateY(-1px); }
          .hik-chip.active { outline: 2px solid var(--hik-accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--hik-accent) 35%, transparent); }
          .hik-chip ha-icon { --mdc-icon-size: 16px; color: var(--hik-accent); }
          .hik-grid { display:grid; grid-template-columns: minmax(320px, 1fr); gap:14px; }
          .hik-panel { border:1px solid color-mix(in srgb, var(--hik-accent) 12%, var(--divider-color)); border-radius:18px; padding:14px; background: color-mix(in srgb, var(--card-background-color) calc(100% - var(--hik-panel-tint)), var(--hik-accent) var(--hik-panel-tint)); }
          .hik-sub { font-weight:700; margin-bottom:10px; display:flex; align-items:center; gap:8px; }
          .hik-sub ha-icon { --mdc-icon-size: 18px; color: var(--hik-accent); }
          .hik-status-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
          .hik-pill { border-radius:999px; padding:6px 10px; background: var(--secondary-background-color); font-size: 12px; display:flex; align-items:center; gap:6px; }
          .hik-pill.good { background: color-mix(in srgb, var(--success-color, #2e7d32) 18%, var(--secondary-background-color)); }
          .hik-pill.warn { background: color-mix(in srgb, var(--warning-color, #ed6c02) 18%, var(--secondary-background-color)); }
          .hik-pill.primary { background: color-mix(in srgb, var(--hik-accent) 18%, var(--secondary-background-color)); }
.hik-health-chip { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:4px 8px; font-size:11px; font-weight:700; letter-spacing:0.04em; }
          .hik-health-chip.green { background: color-mix(in srgb, var(--success-color, #2e7d32) 18%, var(--secondary-background-color)); }
          .hik-health-chip.yellow { background: color-mix(in srgb, var(--warning-color, #ed6c02) 18%, var(--secondary-background-color)); }
          .hik-health-chip.red { background: color-mix(in srgb, var(--error-color, #d32f2f) 18%, var(--secondary-background-color)); }
          .hik-health-dot { width:8px; height:8px; border-radius:50%; background: currentColor; display:inline-block; }
          .hik-select-wrap { display:flex; align-items:center; gap:8px; }
          .hik-select-group { display:grid; gap:6px; min-width: 180px; }
          .hik-stream-panel { margin-top:14px; }
          .hik-storage-list { display:grid; gap:10px; margin-top:12px; }
          .hik-storage-item { border:1px solid var(--divider-color); border-radius:16px; padding:12px; display:grid; gap:6px; background: color-mix(in srgb, var(--card-background-color) calc(100% - var(--hik-panel-tint)), var(--hik-accent) var(--hik-panel-tint)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hik-accent) 8%, transparent); }
          .hik-storage-item b { color: var(--hik-accent); }
          .hik-alarm-table-wrap { margin-top: 8px; overflow-x: auto; }
          .hik-alarm-table { width:100%; border-collapse:collapse; font-size:13px; }
          .hik-alarm-table th, .hik-alarm-table td { padding:10px 12px; text-align:left; border-bottom:1px solid color-mix(in srgb, var(--hik-accent) 8%, var(--divider-color)); vertical-align:middle; }
          .hik-alarm-table th { font-size:11px; letter-spacing:0.08em; text-transform:uppercase; opacity:0.72; font-weight:700; }
          .hik-alarm-table tbody tr:last-child td { border-bottom:none; }
          .hik-alarm-name { display:inline-flex; align-items:center; gap:8px; }
          .hik-alarm-name ha-icon { --mdc-icon-size:16px; color: var(--hik-accent); }
          .hik-alarm-value { display:inline-flex; align-items:center; min-height:26px; padding:0 10px; border-radius:999px; font-size:12px; font-weight:700; }
          .hik-alarm-value.good { background: color-mix(in srgb, var(--success-color, #2e7d32) 18%, var(--secondary-background-color)); }
          .hik-alarm-value.warn { background: color-mix(in srgb, var(--warning-color, #ed6c02) 18%, var(--secondary-background-color)); }
          .hik-alarm-value.primary { background: color-mix(in srgb, var(--hik-accent) 18%, var(--secondary-background-color)); }
          .hik-alarm-value.neutral { background: var(--secondary-background-color); }
          .hik-storage-item.green { border-color: color-mix(in srgb, var(--success-color, #2e7d32) 35%, var(--divider-color)); }
          .hik-storage-item.yellow { border-color: color-mix(in srgb, var(--warning-color, #ed6c02) 35%, var(--divider-color)); }
          .hik-storage-item.red { border-color: color-mix(in srgb, var(--error-color, #d32f2f) 35%, var(--divider-color)); }
          .hik-storage-row { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
          .hik-stream-grid { display:grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap:12px; }
          .hik-select { min-height:34px; border:none; border-radius:12px; padding:0 10px; background: var(--secondary-background-color); color: var(--primary-text-color); }
          .hik-icon-btn, .hik-btn, .hik-toggle-btn { min-height:46px; min-width:46px; border:none; border-radius:14px; cursor:pointer; background: var(--secondary-background-color); color: var(--primary-text-color); display:inline-flex; align-items:center; justify-content:center; gap:8px; transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease; }
          .hik-icon-btn ha-icon, .hik-btn ha-icon, .hik-toggle-btn ha-icon { --mdc-icon-size: 20px; }
          .hik-icon-btn:hover:not(:disabled), .hik-btn:hover:not(:disabled), .hik-toggle-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0,0,0,0.16); }
          .hik-icon-btn:disabled, .hik-btn:disabled, .hik-toggle-btn:disabled { opacity:0.45; cursor:not-allowed; box-shadow:none; }
          .hik-toggle-btn { width:100%; background: color-mix(in srgb, var(--hik-accent) 16%, var(--secondary-background-color)); font-weight:600; }
          .hik-ptz-shell { display:grid; gap:14px; }
          .hik-console-surface { border:1px solid color-mix(in srgb, var(--hik-accent) 12%, var(--divider-color)); border-radius:22px; padding:14px; background: linear-gradient(180deg, color-mix(in srgb, var(--card-background-color) 95%, var(--hik-accent) 5%), color-mix(in srgb, var(--card-background-color) 90%, var(--hik-accent) 10%)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.03); display:grid; gap:12px; overflow:hidden; }
          .hik-console-topbar { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
          .hik-console-kicker { font-size:10px; letter-spacing:0.12em; text-transform:uppercase; opacity:0.62; }
                    .hik-console-badges { display:flex; gap:8px; flex-wrap:wrap; }
          .hik-console-badge { min-height:26px; padding:0 10px; border-radius:999px; background: color-mix(in srgb, var(--hik-accent) 14%, var(--secondary-background-color)); display:inline-flex; align-items:center; gap:6px; font-size:12px; }
          .hik-console-action { min-height:30px; padding:0 12px; border-radius:999px; font-size:12px; background: color-mix(in srgb, var(--hik-accent) 18%, var(--secondary-background-color)); }
          .hik-motion-grid { display:grid; grid-template-columns:minmax(72px,82px) minmax(0,1fr); gap:12px; align-items:stretch; }
          .hik-rail { border:1px solid color-mix(in srgb, var(--hik-accent) 9%, var(--divider-color)); border-radius:18px; background: color-mix(in srgb, var(--card-background-color) 90%, var(--hik-accent) 10%); padding:8px; display:grid; gap:8px; align-content:start; min-width:0; }
          .hik-rail.zoom { min-height:100%; }
                    .hik-rail.iris { padding:10px; }
          .hik-rail.speed { padding:10px 12px; }
          .hik-rail-head { display:flex; align-items:center; justify-content:center; gap:6px; font-size:10px; letter-spacing:0.1em; text-transform:uppercase; opacity:0.72; text-align:center; }
          .hik-rail-head ha-icon { --mdc-icon-size:14px; color:var(--hik-accent); }
          .hik-rail-stack { display:grid; gap:8px; }
          .hik-rail-stack.vertical { grid-template-columns:1fr; }
          .hik-rail-stack.horizontal { grid-template-columns:repeat(2, minmax(0,1fr)); }
          .hik-rail-btn { min-height:54px; min-width:0; width:100%; border:none; border-radius:14px; cursor:pointer; background: color-mix(in srgb, var(--secondary-background-color) 92%, transparent); color: var(--primary-text-color); display:grid; justify-items:center; align-content:center; gap:2px; padding:6px 4px; transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease; }
          .hik-rail-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0,0,0,0.14); }
          .hik-rail-btn:disabled { opacity:0.45; cursor:not-allowed; box-shadow:none; }
          .hik-rail-btn ha-icon { --mdc-icon-size:16px; color:var(--hik-accent); }
          .hik-rail-sign { font-size:16px; line-height:1; font-weight:700; }
          .hik-rail-text { font-size:10px; line-height:1.1; opacity:0.72; }
          .hik-pad-shell { display:grid; gap:10px; min-width:0; }
          .hik-pad-stage { display:grid; gap:10px; }
          .hik-pad-meta-row { display:flex; justify-content:flex-end; }
          .hik-lens-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; }
          .hik-lens-grid .hik-rail { padding:10px; }
          .hik-lens-grid .hik-rail-head { justify-content:flex-start; }
          .hik-lens-grid .lens-pair { grid-template-columns:repeat(2, minmax(0,1fr)); }
          .hik-pad-wrap { border:1px solid color-mix(in srgb, var(--hik-accent) 10%, var(--divider-color)); border-radius:20px; padding:10px; background: color-mix(in srgb, var(--card-background-color) 88%, var(--hik-accent) 12%); display:grid; justify-content:center; }
          .hik-pad { display:grid; grid-template-columns:repeat(3,minmax(54px,1fr)); gap:8px; justify-content:center; align-items:center; max-width:230px; width:min(100%,230px); }
          .hik-pad .hik-icon-btn { min-height:54px; min-width:54px; border-radius:16px; background: color-mix(in srgb, var(--secondary-background-color) 92%, transparent); }
          .hik-pad .hik-icon-btn ha-icon { --mdc-icon-size:18px; }
          .hik-pad .hik-icon-btn.center { background: color-mix(in srgb, var(--hik-accent) 22%, var(--secondary-background-color)); }
          .hik-controls-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom: 12px; }
          .hik-speed-wrap { display:grid; gap:8px; min-width:0; }
          .hik-speed-label { display:flex; justify-content:space-between; align-items:center; font-size: 12px; gap:8px; }
          .hik-speed-value { font-weight: 700; opacity: 0.8; color: var(--hik-accent); }
          .hik-speed-track { width:100%; }
          input[type=range] { width: 100%; accent-color: var(--hik-accent); }
          .hik-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
          .hik-meta { display:grid; grid-template-columns: 1fr 1fr; gap:10px 14px; font-size:14px; }
          .hik-meta div b { display:block; opacity:0.68; font-size:12px; margin-bottom:3px; }
          .hik-empty { padding:16px; border:1px dashed var(--divider-color); border-radius:14px; }
          .hik-code { font-family: monospace; word-break: break-all; line-height: 1.45; }
          .hik-presets { display:flex; gap:8px; flex-wrap:wrap; }
          .hik-playback-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:12px; }
          .hik-playback-input-wrap { display:grid; gap:6px; }
          .hik-playback-input-wrap span { font-size:12px; opacity:0.82; }
          .hik-playback-actions { flex-wrap:wrap; }
          .hik-preset-btn { padding: 0 14px; min-width: unset; }
          .hik-info-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:14px; margin-top:14px; }
          .hik-video-shell { position:relative; }
          .hik-merged-shell { display:grid; gap:14px; }
          .hik-video-block { position:relative; aspect-ratio:16 / 9; min-height:240px; overflow:hidden; border-radius:20px; background: radial-gradient(circle at top, rgba(255,255,255,0.06), rgba(0,0,0,0.94) 55%), #000; box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 18px 34px rgba(0,0,0,0.26); }
          #hikvision-video-host { width:100%; height:100%; display:block; }
          #hikvision-video-host > * { width:100%; height:100%; display:block; }
          .hik-video-block video, .hik-video-block img, .hik-video-block iframe { width:100%; height:100%; object-fit:contain; background:#000; }
          .hik-controls-block { border-top:1px solid color-mix(in srgb, var(--hik-accent) 10%, var(--divider-color)); padding-top:14px; }
          .hik-overlay-toggle { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); z-index:3; }
          .hik-overlay-toggle .hik-toggle-btn { width:auto; padding: 0 16px; border-radius:999px; min-height:42px; box-shadow:0 8px 24px rgba(0,0,0,0.28); backdrop-filter: blur(10px); }
          .hik-faint { opacity:0.72; }
          .hik-position-card { margin-top:14px; border:1px solid color-mix(in srgb, var(--hik-accent) 12%, var(--divider-color)); border-radius:16px; padding:12px; background: color-mix(in srgb, var(--card-background-color) 92%, var(--hik-accent) 8%); display:grid; gap:12px; }
          .hik-video-overlay-badges { position:absolute; inset:14px auto auto 14px; z-index:3; display:flex; gap:8px; flex-wrap:wrap; pointer-events:none; }
          .hik-video-badge { min-height:30px; padding:0 12px; border-radius:999px; display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:700; backdrop-filter: blur(8px); box-shadow: 0 8px 22px rgba(0,0,0,0.24); }
          .hik-video-badge ha-icon { --mdc-icon-size:14px; }
          .hik-video-badge.recording { color:#fff; background: linear-gradient(90deg, rgba(120,0,0,0.92), rgba(220,0,0,0.96), rgba(120,0,0,0.92)); background-size: 200% 100%; animation: hikPulseRecording 1.4s ease-in-out infinite; }
          .hik-video-badge.live-state { color: var(--primary-text-color); background: rgba(0,0,0,0.48); }
          .hik-video-badge.paused { color: var(--primary-text-color); background: rgba(0,0,0,0.58); }
          .hik-audio-panel { display:grid; gap:12px; margin-top:14px; padding:14px; border-radius:18px; border:1px solid color-mix(in srgb, var(--hik-accent) 12%, var(--divider-color)); background: color-mix(in srgb, var(--card-background-color) 92%, var(--hik-accent) 8%); }
          .hik-audio-head { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center; }
          .hik-audio-pills { display:flex; gap:8px; flex-wrap:wrap; }
          .hik-audio-grid { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:10px; align-items:end; }
          .hik-audio-btn { width:100%; justify-content:center; }
          .hik-talk-btn.live { background: color-mix(in srgb, var(--error-color) 20%, var(--card-background-color)); border-color: color-mix(in srgb, var(--error-color) 30%, transparent); }
          .hik-audio-slider { display:grid; gap:6px; min-width:0; }
          .hik-audio-slider span { display:flex; justify-content:space-between; gap:8px; font-size:12px; }
          .hik-audio-note { min-height:44px; display:flex; gap:8px; align-items:center; padding:0 12px; border-radius:12px; border:1px dashed color-mix(in srgb, var(--hik-accent) 16%, var(--divider-color)); }
          .hik-audio-meter { position:relative; min-height:10px; border-radius:999px; overflow:hidden; background: color-mix(in srgb, var(--secondary-background-color) 88%, transparent); }
          .hik-audio-meter-fill { position:absolute; inset:0 auto 0 0; width: var(--hik-audio-level, 0%); max-width:100%; background: linear-gradient(90deg, color-mix(in srgb, var(--success-color) 70%, #22c55e), color-mix(in srgb, var(--warning-color) 80%, #f59e0b), color-mix(in srgb, var(--error-color) 80%, #ef4444)); transition: width 90ms linear; }
          .hik-debug-block { margin-top:12px; padding:12px; border-radius:14px; background: color-mix(in srgb, var(--card-background-color) 70%, rgba(255,255,255,0.03)); border:1px solid rgba(255,255,255,0.06); }
          .hik-debug-block details { margin-top:8px; }
          .hik-debug-block summary { cursor:pointer; font-size:12px; opacity:0.9; }
          .hik-debug-pre { margin:8px 0 0; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-size:11px; line-height:1.35; padding:10px; border-radius:12px; background:rgba(0,0,0,0.28); }
          .hik-debug-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
          .hik-debug-btn { border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.06); color:inherit; border-radius:10px; padding:6px 10px; font-size:12px; cursor:pointer; }
          .hik-debug-btn:hover { background:rgba(255,255,255,0.10); }
          .hik-debug-textarea { width:100%; min-height:220px; margin-top:10px; padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,0.10); background:rgba(0,0,0,0.28); color:inherit; font-size:11px; line-height:1.35; font-family:monospace; resize:vertical; box-sizing:border-box; white-space:pre; }
          .hik-debug-summary { cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:12px; }
          .hik-debug-summary::-webkit-details-marker { display:none; }
          .hik-debug-toolbar { display:grid; gap:10px; margin:12px 0; }
          .hik-debug-filter-group { display:flex; gap:8px; flex-wrap:wrap; }
          .hik-debug-chip { border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.04); color:inherit; border-radius:999px; padding:6px 10px; font-size:12px; cursor:pointer; text-transform:capitalize; }
          .hik-debug-chip.active { background:rgba(255,255,255,0.14); border-color:rgba(255,255,255,0.22); }
          .hik-rec-dot { width:9px; height:9px; border-radius:50%; background:#fff; box-shadow:0 0 0 0 rgba(255,255,255,0.65); animation: hikRecDot 1.4s ease-in-out infinite; }
          @keyframes hikPulseRecording { 0% { background-position: 0% 50%; filter: brightness(0.92); } 50% { background-position: 100% 50%; filter: brightness(1.08); } 100% { background-position: 0% 50%; filter: brightness(0.92); } }
          @keyframes hikRecDot { 0% { transform: scale(0.9); box-shadow:0 0 0 0 rgba(255,255,255,0.65); } 70% { transform: scale(1.08); box-shadow:0 0 0 8px rgba(255,255,255,0); } 100% { transform: scale(0.9); box-shadow:0 0 0 0 rgba(255,255,255,0); } }
          @keyframes hikTalkPulse { 0% { transform: translateY(0) scale(1); box-shadow: 0 0 0 1px color-mix(in srgb, var(--error-color) 26%, transparent), 0 0 0 0 color-mix(in srgb, var(--error-color) 18%, transparent), 0 18px 32px rgba(0,0,0,0.16); } 60% { transform: translateY(-1px) scale(1.01); box-shadow: 0 0 0 1px color-mix(in srgb, var(--error-color) 36%, transparent), 0 0 0 12px color-mix(in srgb, var(--error-color) 0%, transparent), 0 20px 34px rgba(0,0,0,0.18); } 100% { transform: translateY(0) scale(1); box-shadow: 0 0 0 1px color-mix(in srgb, var(--error-color) 26%, transparent), 0 0 0 0 color-mix(in srgb, var(--error-color) 0%, transparent), 0 18px 32px rgba(0,0,0,0.16); } }
          .hik-position-head { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
          .hik-position-body { display:grid; grid-template-columns: 120px 1fr; gap:14px; align-items:center; }
          .hik-indicator-wrap { transition: transform 0.18s ease; transform-origin:center; }
          .hik-indicator-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; text-align:center; font-size:20px; }
          .hik-indicator-grid div { min-height:28px; display:flex; align-items:center; justify-content:center; opacity:0.22; border-radius:10px; background: color-mix(in srgb, var(--secondary-background-color) 88%, transparent); }
          .hik-indicator-grid div.active { opacity:1; color:var(--hik-accent); background: color-mix(in srgb, var(--hik-accent) 18%, var(--secondary-background-color)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hik-accent) 22%, transparent); }
          .hik-indicator-grid div.center { font-size:24px; }
          .hik-position-meta { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }
          .hik-position-meta div b { display:block; opacity:0.68; font-size:12px; margin-bottom:3px; }
          .hik-zoom-track-wrap { display:grid; gap:6px; }
          .hik-zoom-track-label { display:flex; justify-content:space-between; font-size:12px; opacity:0.72; }
          .hik-zoom-track { display:grid; grid-template-columns:1fr 18px 1fr; align-items:center; gap:8px; }
          .hik-zoom-side { position:relative; min-height:10px; border-radius:999px; background: var(--secondary-background-color); overflow:hidden; }
          .hik-zoom-side::after { content:""; position:absolute; inset:0; width: calc((var(--fill) / var(--max)) * 100%); background: color-mix(in srgb, var(--hik-accent) 40%, transparent); }
          .hik-zoom-side.out::after { right:0; left:auto; }
          .hik-zoom-center { width:18px; height:18px; border-radius:999px; background: color-mix(in srgb, var(--hik-accent) 24%, var(--secondary-background-color)); justify-self:center; }
          @media (max-width: 1080px) {
            .hik-grid, .hik-info-grid, .hik-stream-grid { grid-template-columns:1fr; }
          }
          @media (max-width: 700px) {
            .hik-titlebar, .hik-controls-head, .hik-console-topbar { flex-direction:column; align-items:stretch; }
            .hik-meta { grid-template-columns:1fr; }
            .hik-console-badges { width:100%; }
            .hik-motion-grid, .hik-lens-grid { grid-template-columns:1fr; }
            .hik-audio-grid { grid-template-columns:1fr; }
            .hik-pad { max-width:220px; }
          }
        </style>
        <div class="hik-wrap">
          ${this.config.show_title !== false ? `
          <div class="hik-titlebar">
            <div>
              <div class="hik-title">${this.escapeHtml(this.config.title)}</div>
              <div class="hik-subtitle">Elite PTZ console with configurable sections, NVR overview, and storage summary</div>
            </div>
            <div class="hik-pill ${online ? "good" : "warn"}">
              <ha-icon icon="${online ? "mdi:lan-connect" : "mdi:lan-disconnect"}"></ha-icon>
              ${online ? "Online" : "Offline"}
            </div>
          </div>` : ""}

          ${this.config.show_camera_chips !== false ? `
          <div class="hik-chip-row">
            ${cameras.map((c, i) => `
              <button type="button" class="hik-chip ${i === this.selected ? "active" : ""}" data-cam="${i}">
                <ha-icon icon="mdi:cctv"></ha-icon>
                <span>${this.escapeHtml(c.name || `Camera ${c.channel}`)}</span>
              </button>
            `).join("")}
          </div>` : ""}

          <div class="hik-grid">
            <div class="hik-panel hik-video-shell">
              <div class="hik-merged-shell">
                <div class="hik-video-block">
                  <div id="hikvision-video-host"></div>
                  ${this.renderPlaybackOverlay(playbackIndicator)}
                  <div class="hik-overlay-toggle">
                      <button type="button" class="hik-toggle-btn" id="hik-controls-toggle-middle">
                        <ha-icon icon="mdi:tune-variant"></ha-icon>
                        <span>${this._controlsVisible ? "Hide controls" : "Show controls"}</span>
                      </button>
                  </div>
                </div>
                ${this.config.show_status_pills !== false ? `
                <div class="hik-status-row">
                  <span class="hik-pill"><ha-icon icon="mdi:numeric-${cam.channel}-circle-outline"></ha-icon>Channel ${cam.channel}</span>
                  <span class="hik-pill ${online ? "good" : "warn"}"><ha-icon icon="${online ? "mdi:check-circle-outline" : "mdi:alert-circle-outline"}"></ha-icon>${online ? "Connected" : "Offline"}</span>
                  <span class="hik-pill ${ptz ? "good" : "warn"}"><ha-icon icon="mdi:axis-arrow"></ha-icon>${ptz ? `PTZ ${this.escapeHtml(ptzMode)}` : "No PTZ"}</span>
                  <span class="hik-pill primary"><ha-icon icon="mdi:video-outline"></ha-icon>Video ${this.escapeHtml(videoMethod)}</span>
                  ${cameraAlarmBadges.map((badge) => `<span class="hik-pill ${badge.level || "warn"}"><ha-icon icon="${badge.icon}"></ha-icon>${this.escapeHtml(badge.label)}</span>`).join("")}
                </div>` : ""}
                ${this._renderAudioControls(streamMode, playbackActive)}
                ${this.renderDebugDashboard(camAttrs)}
              </div>
            </div>

            ${this.renderControlsPanel({ online, ptz, speed, cameraAlarmBadges })}


${this.config.show_playback_panel !== false ? `
  <div class="hik-panel hik-info-card hik-playback-panel">
    <div class="hik-sub"><ha-icon icon="mdi:play-box-multiple-outline"></ha-icon>Playback</div>
    <div class="hik-playback-grid">
      <label class="hik-playback-input-wrap">
        <span>Start time</span>
        <input id="hik-playback-time" class="hik-select" type="datetime-local" step="1" value="${this.escapeHtml(playbackState.currentTime || this.formatDateTimeLocal())}">
      </label>
      <label class="hik-playback-input-wrap">
        <span>Jump preset</span>
        <select id="hik-playback-preset" class="hik-select">
          ${playbackPresets.map((value) => `<option value="${value}" ${Number(playbackState.preset) === Number(value) ? "selected" : ""}>${this.escapeHtml(this.formatPlaybackPreset(value))}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="hik-status-row">
      <span class="hik-pill ${playbackIndicator.playbackActive ? "primary" : "good"}"><ha-icon icon="${playbackIndicator.playbackActive ? "mdi:record-rec" : "mdi:camera-outline"}"></ha-icon>${playbackIndicator.playbackActive ? "Playback mode" : "Live mode"}</span>
      <span class="hik-pill ${playbackIndicator.playbackActive ? (playbackIndicator.paused ? "warn" : "primary") : "good"}"><ha-icon icon="${playbackIndicator.playbackActive ? (playbackIndicator.paused ? "mdi:pause-circle-outline" : "mdi:play-circle-outline") : "mdi:waveform"}"></ha-icon>${playbackIndicator.statusLabel}</span>
      <span class="hik-pill neutral"><ha-icon icon="mdi:skip-next"></ha-icon>${this.escapeHtml(this.formatPlaybackPreset(playbackState.preset || 1))}</span>
    </div>
    ${camAttrs.playback_clip_start_time && playbackIndicator.playbackActive ? `<div class="hik-mini-note">Clip start ${this.escapeHtml(this.formatDateTimeLocal(camAttrs.playback_clip_start_time))}${camAttrs.playback_requested_time ? ` · Requested ${this.escapeHtml(this.formatDateTimeLocal(camAttrs.playback_requested_time))}` : ""}</div>` : ""}
    ${camAttrs.playback_error ? `<div class="hik-mini-note" style="color:var(--error-color);">${this.escapeHtml(camAttrs.playback_error)}</div>` : ""}
    <div class="hik-row hik-playback-actions">
      <button type="button" class="hik-btn" id="hik-playback-back"><ha-icon icon="mdi:rewind"></ha-icon><span>Back</span></button>
      ${playbackState.paused ? `<button type="button" class="hik-btn" id="hik-playback-resume"><ha-icon icon="mdi:play"></ha-icon><span>Play</span></button>` : `<button type="button" class="hik-btn" id="hik-playback-pause"><ha-icon icon="mdi:pause"></ha-icon><span>Pause</span></button>`}
      <button type="button" class="hik-btn" id="hik-playback-forward"><ha-icon icon="mdi:fast-forward"></ha-icon><span>Forward</span></button>
      <button type="button" class="hik-btn" id="hik-playback-start"><ha-icon icon="mdi:calendar-play"></ha-icon><span>Start</span></button>
      <button type="button" class="hik-btn" id="hik-playback-stop"><ha-icon icon="mdi:cctv-off"></ha-icon><span>Live</span></button>
    </div>
  </div>
` : ""}

                ${this.config.show_position_info !== false ? this.renderPTZIndicator() : ""}

                <div style="margin-top:16px;">
                  <div class="hik-sub"><ha-icon icon="mdi:bookmark-multiple-outline"></ha-icon>Presets</div>
                  <div class="hik-presets">
                    ${presets.length ? presets.map((p) => {
                      const pid = typeof p === "object" ? p.id : p;
                      const pname = typeof p === "object" ? (p.name || `Preset ${p.id}`) : `Preset ${p}`;
                      return `<button type="button" class="hik-btn hik-preset-btn preset-btn" data-preset="${pid}" ${ptz ? "" : "disabled"}>${this.escapeHtml(pname)}</button>`;
                    }).join("") : `<span class="hik-mini-note">No presets configured</span>`}
                  </div>
                </div>
            </div>
          </div>

          ${infoCards.length ? `<div class="hik-info-grid">${infoCards.join("")}</div>` : ""}
        </div>
      </ha-card>
    `;

    this._restorePreservedVideoHost(preservedVideoHost);
    this.renderVideo(refs.camera, rtspUrl, directRtspUrl, streamMode, camAttrs.playback_active === true ? (camAttrs.playback_uri || "") : "", playbackState.paused);
    this._syncMediaAudio();

    this.querySelectorAll("[data-cam]").forEach((btn) => {
      const handler = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.selectCamera(Number(btn.dataset.cam));
      };
      btn.addEventListener("click", handler);
      btn.addEventListener("pointerup", handler);
    });
    const streamModeSelect = this.querySelector("#streamMode");
    if (streamModeSelect && refs.camera) {
      streamModeSelect.addEventListener("change", (e) => {
        this._hass.callService("ha_hikvision_bridge", "set_stream_mode", {
          entity_id: refs.camera,
          mode: e.target.value,
        });
      });
    }

    const streamProfileSelect = this.querySelector("#streamProfile");
    if (streamProfileSelect && refs.camera) {
      streamProfileSelect.addEventListener("change", (e) => {
        this._hass.callService("ha_hikvision_bridge", "set_stream_profile", {
          entity_id: refs.camera,
          profile: e.target.value,
        });
      });
    }

    this.querySelector("#hik-speaker-toggle")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      this._setSpeakerEnabled(!this._speakerEnabled);
    });
    this.querySelector("#hik-volume")?.addEventListener("input", (ev) => this._setVolume(ev.target.value));
    this.querySelector("#hik-audio-boost")?.addEventListener("input", (ev) => this._setAudioBoost(ev.target.value));

    const holdTalkBtn = this.querySelector("#hik-talk-hold");
    if (holdTalkBtn) this._bindHoldTalkButton(holdTalkBtn);
    this.querySelector("#hik-talk-toggle")?.addEventListener("click", (ev) => this._handleTalkToggle(ev));

    const toggleControls = () => {
      this._controlsVisible = !this._controlsVisible;
      this.render();
    };
    this.querySelector("#hik-controls-toggle-middle")?.addEventListener("click", toggleControls);

    this.querySelectorAll(".ptz-btn").forEach((btn) => {
      const pan = Number(btn.dataset.pan);
      const tilt = Number(btn.dataset.tilt);
      const start = (ev) => { ev.preventDefault(); this.startMove(pan, tilt); };
      const stop = () => this.stopMove();
      btn.addEventListener("mousedown", start);
      btn.addEventListener("mouseup", stop);
      btn.addEventListener("mouseleave", stop);
      btn.addEventListener("touchstart", start, { passive: false });
      btn.addEventListener("touchend", stop);
      btn.addEventListener("touchcancel", stop);
    });

    this.querySelector("#hik-center")?.addEventListener("click", () => this.handleCenter());
    this.querySelectorAll(".lens-btn[data-service]").forEach((btn) => btn.addEventListener("click", () => this.callLens(btn.dataset.service, Number(btn.dataset.direction || 0))));
    this.querySelector("#hik-refocus")?.addEventListener("click", () => this.handleRefocus());
    this.querySelector("#hik-set-home")?.addEventListener("click", () => this.handleSetHome());
    this.querySelector("#hik-return-home")?.addEventListener("click", () => this.handleReturnHome());
    this.querySelectorAll(".preset-btn").forEach((btn) => btn.addEventListener("click", () => this.gotoPreset(Number(btn.dataset.preset))));
    this.querySelector("#hik-playback-time")?.addEventListener("change", (ev) => {
      const state = this.getPlaybackState();
      state.currentTime = ev.target.value;
    });
    this.querySelector("#hik-playback-preset")?.addEventListener("change", (ev) => {
      const state = this.getPlaybackState();
      state.preset = Number(ev.target.value || 1);
    });
    const debugDashboard = this.querySelector("#hik-debug-dashboard-details");
    if (debugDashboard) {
      debugDashboard.addEventListener("toggle", () => {
        this._debugDashboardOpen = debugDashboard.open === true;
      });
    }
    this.querySelectorAll("[data-debug-filter]").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const target = ev.currentTarget;
      this._toggleDebugFilter(target?.getAttribute("data-debug-filter"), target?.getAttribute("data-debug-value"));
    }));
    this.querySelectorAll("[data-debug-entry-action]").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const container = ev.currentTarget.closest(".hik-debug-block");
      const textarea = container?.querySelector(".hik-debug-textarea");
      const text = textarea?.value || textarea?.textContent || "";
      const action = ev.currentTarget.getAttribute("data-debug-entry-action");
      if (action === "copy") this.copyDebugText(text);
      if (action === "download") this.downloadDebugText(text, "hikvision-debug-entry");
    }));
    this.querySelectorAll("[data-debug-global-action]").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const action = ev.currentTarget.getAttribute("data-debug-global-action");
      const combined = this._getFilteredDebugEntries().map((entry) => this.formatDebugEntryText(entry)).join("\n\n");
      if (action === "copy-all") this.copyDebugText(combined);
      if (action === "download-all") this.downloadDebugText(combined, "hikvision-debug-dashboard");
      if (action === "clear") {
        this._debugEntries = (this._debugEntries || []).filter((entry) => entry.source === "backend");
        this.render();
      }
    }));
    this.querySelector("#hik-playback-start")?.addEventListener("click", () => this.startPlayback());
    this.querySelector("#hik-playback-stop")?.addEventListener("click", () => this.stopPlayback());
    this.querySelector("#hik-playback-pause")?.addEventListener("click", () => this.pausePlayback());
    this.querySelector("#hik-playback-resume")?.addEventListener("click", () => this.resumePlayback());
    this.querySelector("#hik-playback-back")?.addEventListener("click", () => this.seekPlayback(-1));
    this.querySelector("#hik-playback-forward")?.addEventListener("click", () => this.seekPlayback(1));
    this.querySelector("#hik-speed")?.addEventListener("input", (ev) => {
      this.config = { ...this.config, speed: Number(ev.target.value) };
      this.render();
    });
  }
}

class HikvisionPTZCardEditor extends HTMLElement {
  setConfig(config) {
    this.config = config || {};
    this.render();
  }

  rowCheckbox(id, label, checked) {
    return `<label style="display:flex;align-items:center;gap:8px;"><input id="${id}" type="checkbox" ${checked ? "checked" : ""}> ${label}</label>`;
  }

  render() {
    const videoMode = this.config.video_mode || "rtsp_direct";
    const controlsMode = this.config.controls_mode || "always";
    const speedPosition = String(this.config.speed_position || (this.config.speed_orientation === "horizontal" ? "below" : "right")).toLowerCase();
    const accent = this.config.accent_color || "#03a9f4";
    const tint = Number(this.config.panel_tint ?? 8);
    this.innerHTML = `
      <div style="padding:16px;display:grid;gap:16px;">
        <div style="font-size:18px;font-weight:700;">HA Hikvision Bridge Card Editor</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div><label>Title</label><br><input id="title" type="text" value="${this.config.title || "ha-hikvision-bridge-card"}" style="width:100%;"></div>
          <div><label>Default speed</label><br><input id="speed" type="number" min="1" max="100" value="${this.config.speed || 50}" style="width:100%;"></div>
          <div><label>Repeat interval (ms)</label><br><input id="repeat_ms" type="number" min="100" value="${this.config.repeat_ms || 350}" style="width:100%;"></div>
          <div><label>PTZ pulse duration (ms)</label><br><input id="ptz_duration" type="number" min="100" value="${this.config.ptz_duration ?? 300}" style="width:100%;"></div>
          <div><label>Focus / Iris step value</label><br><input id="lens_step" type="number" min="1" max="100" value="${this.config.lens_step || 60}" style="width:100%;"></div>
          <div><label>Lens pulse duration (ms)</label><br><input id="lens_duration" type="number" min="60" value="${this.config.lens_duration ?? 180}" style="width:100%;"></div>
          <div><label>Refocus zoom step</label><br><input id="refocus_step" type="number" min="1" max="100" value="${this.config.refocus_step ?? 40}" style="width:100%;"></div>
          <div>
            <label>Video mode</label><br>
            <select id="video_mode" style="width:100%;">
              <option value="webrtc_direct" ${videoMode === "webrtc_direct" ? "selected" : ""}>WebRTC direct RTSP</option>
              <option value="webrtc" ${videoMode === "webrtc" ? "selected" : ""}>WebRTC ISAPI RTSP</option>
              <option value="rtsp_direct" ${videoMode === "rtsp_direct" ? "selected" : ""}>RTSP direct</option>
              <option value="rtsp" ${videoMode === "rtsp" ? "selected" : ""}>RTSP ISAPI</option>
              <option value="snapshot" ${videoMode === "snapshot" ? "selected" : ""}>Snapshot</option>
            </select>
          </div>
          <div>
            <label>Controls display</label><br>
            <select id="controls_mode" style="width:100%;">
              <option value="always" ${controlsMode === "always" ? "selected" : ""}>Always show controls</option>
              <option value="toggle" ${controlsMode === "toggle" ? "selected" : ""}>Show only when button is pressed</option>
            </select>
          </div>
          <div><label>Accent color</label><br><input id="accent_color" type="color" value="${accent.startsWith('#') ? accent : '#03a9f4'}" style="width:100%;height:38px;"></div>
          <div><label>Panel tint strength</label><br><input id="panel_tint" type="range" min="0" max="24" step="1" value="${tint}" style="width:100%;"></div>
          <div>
            <label>PTZ speed slider placement</label><br>
            <select id="speed_position" style="width:100%;">
              <option value="left" ${speedPosition === "left" ? "selected" : ""}>Left of PTZ stick</option>
              <option value="right" ${speedPosition === "right" ? "selected" : ""}>Right of PTZ stick</option>
              <option value="above" ${speedPosition === "above" ? "selected" : ""}>Above PTZ stick</option>
              <option value="below" ${speedPosition === "below" ? "selected" : ""}>Below PTZ stick</option>
            </select>
          </div>
          <div><label>Playback jump presets (seconds)</label><br><input id="playback_presets" type="text" value="${(this.config.playback_presets || [1, 5, 10, 30, 60, 300, 600, 3600]).join(", ")}" style="width:100%;" placeholder="1, 5, 10, 30, 60"></div>
          <div>
            <label>Talk mode</label><br>
            <select id="talk_mode" style="width:100%;">
              <option value="hold" ${String(this.config.talk_mode || "hold") === "hold" ? "selected" : ""}>Hold to talk</option>
              <option value="toggle" ${String(this.config.talk_mode || "hold") === "toggle" ? "selected" : ""}>Toggle talk</option>
            </select>
          </div>
          <div><label>Speaker default</label><br><select id="speaker_default" style="width:100%;"><option value="off" ${this.config.speaker_default ? "" : "selected"}>Off</option><option value="on" ${this.config.speaker_default ? "selected" : ""}>On</option></select></div>
          <div><label>Default volume (%)</label><br><input id="volume_default" type="number" min="0" max="100" value="${Number(this.config.volume_default ?? 100)}" style="width:100%;"></div>
          <div><label>Audio boost (%)</label><br><input id="audio_boost" type="number" min="100" max="300" step="10" value="${Number(this.config.audio_boost ?? 100)}" style="width:100%;"></div>
        </div>

        <div style="padding:12px;border:1px solid var(--divider-color);border-radius:12px;display:grid;gap:10px;">
          <div style="font-weight:600;">Display options</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            ${this.rowCheckbox("auto_discover", "Auto-discover connected cameras", this.config.auto_discover !== false)}
            ${this.rowCheckbox("show_title", "Show title bar", this.config.show_title !== false)}
            ${this.rowCheckbox("show_camera_chips", "Show camera selector chips", this.config.show_camera_chips !== false)}
            ${this.rowCheckbox("show_status_pills", "Show status pills", this.config.show_status_pills !== false)}
            ${this.rowCheckbox("show_camera_info", "Show Camera Info", this.config.show_camera_info !== false)}
            ${this.rowCheckbox("show_stream_info", "Show Stream Info", this.config.show_stream_info !== false)}
            ${this.rowCheckbox("show_stream_mode_info", "Show Stream Mode Info", this.config.show_stream_mode_info !== false)}
            ${this.rowCheckbox("show_alarm_dashboard", "Show Alarm Dashboard", this.config.show_alarm_dashboard !== false)}
            ${this.rowCheckbox("show_controls", "Show control console by default", this.config.show_controls !== false)}
            ${this.rowCheckbox("show_dvr_info", "Show NVR System Info", this.config.show_dvr_info !== false)}
            ${this.rowCheckbox("show_storage_info", "Show NVR Storage Info", this.config.show_storage_info !== false)}
            ${this.rowCheckbox("show_position_info", "Show PTZ position tracker", this.config.show_position_info !== false)}
            ${this.rowCheckbox("lens_stop_safeguard", "Enable lens stop safeguard", this.config.lens_stop_safeguard === true)}
            ${this.rowCheckbox("show_playback_panel", "Show playback controls", this.config.show_playback_panel !== false)}
            ${this.rowCheckbox("debug_enabled", "Show unified debug dashboard", this.config.debug?.enabled === true)}
            ${this.rowCheckbox("show_audio_controls", "Show audio console", this.config.show_audio_controls !== false)}
            ${this.rowCheckbox("mute_during_talk", "Mute speaker while talking", this.config.mute_during_talk !== false)}
          </div>
        </div>

        <div style="padding:12px;border:1px solid var(--divider-color);border-radius:12px;display:grid;gap:10px;">
          <div style="font-weight:600;">Virtual PTZ tracking</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;">
            <div><label>Max pan steps</label><br><input id="max_pan_steps" type="number" min="1" max="20" value="${this.config.ptz_steps?.pan ?? this.config.max_pan_steps ?? 5}" style="width:100%;"></div>
            <div><label>Max tilt steps</label><br><input id="max_tilt_steps" type="number" min="1" max="20" value="${this.config.ptz_steps?.tilt ?? this.config.max_tilt_steps ?? 5}" style="width:100%;"></div>
            <div><label>Max zoom steps</label><br><input id="max_zoom_steps" type="number" min="1" max="20" value="${this.config.ptz_steps?.zoom ?? this.config.max_zoom_steps ?? 5}" style="width:100%;"></div>
            <div><label>Return step delay (ms)</label><br><input id="return_step_delay" type="number" min="0" max="2000" value="${this.config.return_step_delay ?? 150}" style="width:100%;"></div>
          </div>
        </div>
      </div>`;

    ["title", "speed", "repeat_ms", "ptz_duration", "lens_step", "lens_duration", "refocus_step", "video_mode", "controls_mode", "accent_color", "panel_tint", "speed_position", "playback_presets", "talk_mode", "speaker_default", "volume_default", "audio_boost", "auto_discover", "show_title", "show_camera_chips", "show_status_pills", "show_camera_info", "show_stream_info", "show_stream_mode_info", "show_alarm_dashboard", "show_controls", "show_dvr_info", "show_storage_info", "show_position_info", "lens_stop_safeguard", "show_playback_panel", "debug_enabled", "show_audio_controls", "mute_during_talk", "max_pan_steps", "max_tilt_steps", "max_zoom_steps", "return_step_delay"].forEach((id) => {
      this.querySelector(`#${id}`)?.addEventListener("change", () => this._valueChanged());
      this.querySelector(`#${id}`)?.addEventListener("input", () => this._valueChanged());
    });
  }

  _valueChanged() {
    const config = {
      ...this.config,
      type: "custom:ha-hikvision-bridge-card",
      title: this.querySelector("#title").value,
      speed: Number(this.querySelector("#speed").value),
      repeat_ms: Number(this.querySelector("#repeat_ms").value),
      ptz_duration: Number(this.querySelector("#ptz_duration").value),
      lens_step: Number(this.querySelector("#lens_step").value),
      lens_duration: Number(this.querySelector("#lens_duration").value),
      refocus_step: Number(this.querySelector("#refocus_step").value),
      video_mode: this.querySelector("#video_mode").value,
      controls_mode: this.querySelector("#controls_mode").value,
      accent_color: this.querySelector("#accent_color").value,
      panel_tint: Number(this.querySelector("#panel_tint").value),
      speed_position: this.querySelector("#speed_position").value,
      playback_presets: String(this.querySelector("#playback_presets").value || "").split(",").map((value) => Number(String(value).trim())).filter((value) => Number.isFinite(value) && value > 0),
      auto_discover: this.querySelector("#auto_discover").checked,
      show_title: this.querySelector("#show_title").checked,
      show_camera_chips: this.querySelector("#show_camera_chips").checked,
      show_status_pills: this.querySelector("#show_status_pills").checked,
      show_camera_info: this.querySelector("#show_camera_info").checked,
      show_stream_info: this.querySelector("#show_stream_info").checked,
      show_stream_mode_info: this.querySelector("#show_stream_mode_info").checked,
      show_alarm_dashboard: this.querySelector("#show_alarm_dashboard").checked,
      show_controls: this.querySelector("#show_controls").checked,
      show_dvr_info: this.querySelector("#show_dvr_info").checked,
      show_storage_info: this.querySelector("#show_storage_info").checked,
      show_position_info: this.querySelector("#show_position_info").checked,
      lens_stop_safeguard: this.querySelector("#lens_stop_safeguard").checked,
      show_playback_panel: this.querySelector("#show_playback_panel").checked,
      show_audio_controls: this.querySelector("#show_audio_controls").checked,
      debug: {
        ...(this.config.debug || {}),
        enabled: this.querySelector("#debug_enabled").checked,
      },
      mute_during_talk: this.querySelector("#mute_during_talk").checked,
      ptz_steps: {
        pan: Number(this.querySelector("#max_pan_steps").value),
        tilt: Number(this.querySelector("#max_tilt_steps").value),
        zoom: Number(this.querySelector("#max_zoom_steps").value),
      },
      return_step_delay: Number(this.querySelector("#return_step_delay").value),
    };
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }
}

if (!customElements.get("ha-hikvision-bridge-card")) customElements.define("ha-hikvision-bridge-card", HikvisionPTZCard);

if (!customElements.get("ha-hikvision-bridge-card-editor")) customElements.define("ha-hikvision-bridge-card-editor", HikvisionPTZCardEditor);


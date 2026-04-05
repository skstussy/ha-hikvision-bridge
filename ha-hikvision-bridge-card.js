/* UI Split Patch 2.6.1 */

class HikvisionPTZCard extends HTMLElement {
_toggleDebugExpand(entry) {
  entry._expanded = !entry._expanded;
  this.requestUpdate();
}

_renderWebRtcPtzStatus() {
  const s = this._debugSnapshot || {};
  return html`
    <div class="debug-card">
      <h3>WebRTC PTZ Status</h3>
      <div>Bound: ${s.webrtc_overlay_active ? "✅" : "❌"}</div>
      <div>Attempts: ${s.webrtc_ptz_attempts || 0}</div>
      <div>Candidate Roots: ${s.webrtc_ptz_candidate_roots || 0}</div>
      <div>Buttons Found: ${s.webrtc_ptz_button_count || 0}</div>
      <div>Last Reason: ${s.webrtc_ptz_last_bind_reason || "-"}</div>
      <div>Last Update: ${s.webrtc_ptz_last_bind_at || "-"}</div>
    </div>
  `;
}

_renderDebugRow(entry) {
  return html`
    <div class="debug-row" @click=${() => this._toggleDebugExpand(entry)}>
      <div class="time">${new Date(entry.time).toLocaleTimeString()}</div>
      <div class="cat">${entry.category}</div>
      <div class="lvl ${entry.level}">${entry.level}</div>
      <div class="evt">${entry.event}</div>
      <div class="cam">${entry.camera || "-"}</div>
      <div class="cnt">${entry.count > 1 ? "×" + entry.count : ""}</div>
    </div>
    ${entry._expanded ? html`
      <div class="debug-details">
        <pre>${JSON.stringify(entry.details, null, 2)}</pre>
      </div>
    ` : ""}
  `;
}


_pushDebugEntry(entry) {
  if (!this._debugEntries) this._debugEntries = [];

  const fingerprint = [
    entry.category,
    entry.level,
    entry.event,
    entry.message,
    entry.camera,
    entry.details?.reason || ""
  ].join("|");

  const existing = this._debugEntries.find(e => e._fp === fingerprint);

  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.last_seen = entry.time;
    existing.details = entry.details;
    return;
  }

  entry._fp = fingerprint;
  entry.count = 1;
  entry.last_seen = entry.time;

  this._debugEntries.unshift(entry);

  if (this._debugEntries.length > 300) {
    this._debugEntries.pop();
  }
}



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
        categories: ["audio", "playback", "video", "backend", "controls", "ptz", "webrtc", "service", "state", "render"],
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
    this._playbackOverlayVisible = this._playbackOverlayVisible ?? false;
    this._playbackRate = this._playbackRate ?? 2;
    this._playbackSeekInFlight = this._playbackSeekInFlight ?? false;
    this._lastPlaybackSeekAt = Number.isFinite(this._lastPlaybackSeekAt) ? this._lastPlaybackSeekAt : 0;
    this._playbackSeekHoldTimer = this._playbackSeekHoldTimer || null;
    this._ptzStateMap = this._ptzStateMap || {};
    this._playbackStateMap = this._playbackStateMap || {};
    this._returningHome = false;
    this._speakerEnabled = this._speakerEnabled ?? Boolean(this.config.speaker_default);
    this._volume = Number.isFinite(this._volume) ? this._volume : Math.max(0, Math.min(100, Number(this.config.volume_default ?? 100)));
    this._audioBoost = Number.isFinite(this._audioBoost) ? this._audioBoost : Math.max(100, Math.min(300, Number(this.config.audio_boost ?? 100)));
    this._micVolume = Number.isFinite(this._micVolume) ? this._micVolume : Math.max(0, Math.min(200, Number(this.config.mic_volume ?? 100)));
    this._talkRequested = this._talkRequested ?? false;
    this._talkLatched = this._talkLatched ?? false;
    this._audioMeterLevel = this._audioMeterLevel ?? 0;
    this._audioMeterPeak = this._audioMeterPeak ?? 0;
    this._micMeterLevel = this._micMeterLevel ?? 0;
    this._micMeterPeak = this._micMeterPeak ?? 0;
    this._audioMeterRaf = this._audioMeterRaf || null;
    this._micMeterRaf = this._micMeterRaf || null;
    this._audioGraph = this._audioGraph || null;
    this._audioGraphElement = this._audioGraphElement || null;
    this._talkAudioGraph = this._talkAudioGraph || null;
    this._talkPc = this._talkPc || null;
    this._talkWs = this._talkWs || null;
    this._talkStream = this._talkStream || null;
    this._talkActive = this._talkActive || false;
    this._talkHoldActive = this._talkHoldActive || false;
    this._talkReleaseCleanup = this._talkReleaseCleanup || null;
    this._videoAccessoryPanel = this._videoAccessoryPanel || "";
    this._debugOverlayOpen = this._debugOverlayOpen || false;
    this._debugOverlayRectLoaded = this._debugOverlayRectLoaded === true;
    const debugOverlayRectSeed = this._debugOverlayRectLoaded
      ? this._debugOverlayRect
      : (this._debugOverlayRect ?? this._loadDebugOverlayRect());
    this._debugOverlayRect = this._normalizeDebugOverlayRect(debugOverlayRectSeed);
    this._debugOverlayRectLoaded = true;
    this._debugOverlayDrag = this._debugOverlayDrag || null;
    this._debugOverlayResize = this._debugOverlayResize || null;
    this._audioDebugLog = Array.isArray(this._audioDebugLog) ? this._audioDebugLog : [];
    this._audioDebugSeq = Number.isFinite(this._audioDebugSeq) ? this._audioDebugSeq : 0;
    this._audioDebugStatus = this._audioDebugStatus || { requested: false, active: false, ws: "idle", pc: "idle", ice: "idle", signaling: "stable", mic: "idle", last_error: "" };
    this._debugEntries = Array.isArray(this._debugEntries) ? this._debugEntries : [];
    this._debugSeq = Number.isFinite(this._debugSeq) ? this._debugSeq : 0;
    this._debugFilters = this._debugFilters || { categories: ["all"], levels: ["all"] };
    this._debugDashboardOpen = this._debugDashboardOpen ?? (this.config?.debug?.default_open === true);
    this._debugTraceSeq = Number.isFinite(this._debugTraceSeq) ? this._debugTraceSeq : 0;
    this._lastDebugSnapshot = this._lastDebugSnapshot || null;
    this._panelOpenState = this._panelOpenState || {};
    this._gridMode = this._gridMode ?? false;
    this._gridFocusChannel = this._gridFocusChannel ?? null;
    this._gridManualFocusUntil = Number.isFinite(this._gridManualFocusUntil) ? this._gridManualFocusUntil : 0;
    this._gridMotionFocusUntil = Number.isFinite(this._gridMotionFocusUntil) ? this._gridMotionFocusUntil : 0;
    this._gridVideoCards = this._gridVideoCards || new Map();
    this._gridPendingFocusChannel = this._gridPendingFocusChannel || null;
    this._gridFocusTransitionTimer = this._gridFocusTransitionTimer || null;
    this._webRtcPtzCleanup = this._webRtcPtzCleanup || null;
    this._webRtcPtzBound = this._webRtcPtzBound || false;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._videoCard) this._videoCard.hass = hass;
    this._syncDebugRuntime();
    this.render();
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
    this._teardownTalkAudioGraph();
    this._teardownAudioGraph();
    this._cleanupVideoCard();
  }

  stopRepeater() {
    this.stopMove();
  }

  _cleanupVideoCard() {
    this._teardownWebRtcPtzBindings();
    if (this._mediaSyncObserver) {
      try { this._mediaSyncObserver.disconnect(); } catch (err) {}
    }
    this._mediaSyncObserver = null;
    this._teardownAudioGraph?.();
    this._teardownTalkAudioGraph?.();
    this._cleanupGridVideoCards?.();

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


  _buildWebRtcPtzConfig(playbackMode = false) {
    return null;
  }

  _buildWebRtcCardConfig(url, playbackMode = false) {
    const style = [
      ".ptz, .header, .menu, .toolbar, .controls { display:none !important; opacity:0 !important; pointer-events:none !important; }",
      ":host { --controls-display:none; }",
    ].join(" ");

    const config = {
      type: "custom:webrtc-camera",
      url,
      mode: "webrtc",
      media: "video,audio",
      muted: !this._speakerEnabled,
      ui: false,
      background: true,
      style,
    };

    return config;
  }

  _toggleFullscreenVideo() {
    const el = this.querySelector(".hik-video-block");
    if (!el) return;
    const doc = document;
    const isFs = doc.fullscreenElement === el;
    if (isFs) {
      doc.exitFullscreen?.().catch?.(() => {});
    } else {
      el.requestFullscreen?.().catch?.(() => {});
    }
  }

  _playbackTickerText() {
    const cam = this.selectedCamera || {};
    const refs = cam?.channel != null ? this.refsForChannel?.(cam.channel) || {} : {};
    const cameraEntity = refs.camera ? this.getEntity?.(refs.camera) : null;
    const attrs = cameraEntity?.attributes || {};
    const value = attrs.playback_requested_time || attrs.playback_clip_start_time || "";
    return value ? this.formatDateTimeLocal(value) : "";
  }

  _getPlaybackRate() {
    return Number(this._playbackRate || 2);
  }

  _setPlaybackRate(value) {
    const parsed = Number(value || 2);
    this._playbackRate = [2,5,10,20].includes(parsed) ? parsed : 2;
    this.render();
  }

  _seekPlaybackHold(direction = 1) {
    const rate = this._getPlaybackRate();
    this.seekPlayback(Number(direction || 1) * rate);
  }

  _bindPlaybackSeekHold(button, direction = 1) {
    if (!button) return;
    const click = (ev) => {
      ev.preventDefault();
      this.seekPlayback(direction);
    };
    button.addEventListener("click", click);
  }

  _getWebRtcPtzActionSignature(node) {
    if (!node) return "";
    const bits = [];
    const push = (value) => {
      if (value == null) return;
      const normalized = String(value).trim().toLowerCase();
      if (normalized) bits.push(normalized);
    };

    [node.title, node.ariaLabel, node.className, node.getAttribute?.("class"), node.getAttribute?.("aria-label"), node.getAttribute?.("label"), node.dataset?.action, node.dataset?.direction, node.dataset?.dir, node.textContent].forEach(push);
    node.querySelectorAll?.("[icon], ha-icon, mwc-icon-button, ha-icon-button, button").forEach((el) => {
      push(el.className);
      push(el.getAttribute?.("class"));
      push(el.getAttribute?.("icon"));
      push(el.getAttribute?.("aria-label"));
      push(el.getAttribute?.("label"));
      push(el.title);
      push(el.textContent);
    });

    return bits.join(" ");
  }

  _detectWebRtcPtzAction(node, traceId = "") {
    const signature = this._getWebRtcPtzActionSignature(node);
    if (!signature) return "";

    const has = (...terms) => terms.some((term) => signature.includes(term));
    const hasZoomWord = has("zoom", "magnify", "loupe", "search");
    let action = "";

    if (has("zoom out", "magnify-minus", "zoom_out") || (hasZoomWord && has("minus", "remove", "subtract", "mdi:minus", "mdi:magnify-minus", "-"))) action = "zoom_out";
    else if (has("zoom in", "magnify-plus", "zoom_in") || (hasZoomWord && has("plus", "add", "expand", "mdi:plus", "mdi:magnify-plus", "+"))) action = "zoom_in";
    else if (has("move left", " pan left", "arrow-left", "chevron-left", "keyboardarrowleft") || signature.startsWith("left")) action = "left";
    else if (has("move right", " pan right", "arrow-right", "chevron-right", "keyboardarrowright") || signature.startsWith("right")) action = "right";
    else if (has("move up", " pan up", "arrow-up", "chevron-up", "keyboardarrowup") || signature.startsWith("up")) action = "up";
    else if (has("move down", " pan down", "arrow-down", "chevron-down", "keyboardarrowdown") || signature.startsWith("down")) action = "down";

    if (this.isDebugEnabled()) {
      this._pushTraceDebug("webrtc", action ? "debug" : "warn", action ? "webrtc_ptz_action_detected" : "webrtc_ptz_action_unmatched", action ? `Detected WebRTC PTZ action ${action}` : "Could not classify WebRTC PTZ control", {
        trace_id: traceId || "",
        signature,
        node_name: node?.nodeName || "",
        class_name: node?.className || node?.getAttribute?.("class") || "",
      }, traceId || "", "frontend");
    }
    return action;
  }

  _triggerLegacyZoom(direction = 0, traceId = "") {
    const dir = Number(direction || 0);
    const legacyButton = this.querySelector(`.lens-btn[data-service="zoom"][data-direction="${dir}"]`);
    this._pushTraceDebug("ptz", "info", "legacy_zoom_attempt", dir > 0 ? "Routing zoom to legacy zoom in control" : "Routing zoom to legacy zoom out control", {
      direction: dir,
      legacy_button_found: !!legacyButton,
    }, traceId, "frontend");
    if (legacyButton && typeof legacyButton.click === "function") {
      legacyButton.click();
      return true;
    }
    this.callLens("zoom", dir, { trace_id: traceId, source: "webrtc" });
    return true;
  }

  _handleWebRtcPtzAction(action, phase = "click", traceId = "") {
    if (!action || !this.canPtz() || this._returningHome) {
      this._pushTraceDebug("webrtc", "warn", "webrtc_ptz_action_skipped", "Skipped WebRTC PTZ action", { action, phase, can_ptz: this.canPtz(), returning_home: !!this._returningHome }, traceId, "frontend");
      return;
    }

    const speed = Math.max(1, Math.min(100, Number(this.config.speed || 50)));
    this._pushTraceDebug("webrtc", phase === "end" ? "debug" : "info", "webrtc_ptz_action_routed", `Routing WebRTC PTZ action ${action}`, { action, phase, speed }, traceId, "frontend");
    if (phase === "end") {
      if (["left", "right", "up", "down"].includes(action)) this.stopMove({ trace_id: traceId, source: "webrtc", action });
      return;
    }

    if (action === "zoom_in") {
      this._triggerLegacyZoom(1, traceId);
      return;
    }
    if (action === "zoom_out") {
      this._triggerLegacyZoom(-1, traceId);
      return;
    }

    const pan = action === "left" ? -speed : action === "right" ? speed : 0;
    const tilt = action === "up" ? speed : action === "down" ? -speed : 0;

    this.stopMove({ trace_id: traceId, source: "webrtc", action: `${action}_preflight` });
    this.startMove(pan, tilt, { trace_id: traceId, source: "webrtc", action });
  }

  _clearWebRtcPtzRetryTimers() {}


  _getWebRtcCandidateRoots(root) {
    return [];
  }

  _findWebRtcPtzRoot(root) {
    return { ptzRoot: null, candidates: [], buttonCount: 0 };
  }

  _bindWebRtcPtzButtons(root) {
    return false;
  }


  _setupWebRtcPtzBindings(card, playbackMode = false) {
    this._teardownWebRtcPtzBindings();
    this._webRtcPtzBindAttempts = 0;
    this._webRtcPtzLastBindAt = new Date().toISOString();
    if (!card) {
      this._webRtcPtzLastBindReason = "disabled:no_card";
      return;
    }
    if (playbackMode) {
      this._webRtcPtzLastBindReason = "disabled:playback_mode";
      return;
    }
    this._webRtcPtzLastBindReason = "disabled:custom_overlay";
    this._webRtcPtzLastCandidateCount = 0;
    this._webRtcPtzLastButtonCount = 0;
    this._webRtcPtzBound = true;
  }


  _teardownWebRtcPtzBindings() {
    if (typeof this._webRtcPtzCleanup === "function") {
      try { this._webRtcPtzCleanup(); } catch (err) {}
    }
    this._webRtcPtzCleanup = null;
    this._webRtcPtzBound = false;
  }

  _syncWebRtcCardConfig(playbackMode = false) {
    const card = this._videoCard;
    const current = this._videoCardConfig;
    if (!card || !current || current.type !== "custom:webrtc-camera") return;
    const next = this._buildWebRtcCardConfig(current.url, playbackMode);
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    this._pushDebug("render", "info", "webrtc_card_config_sync", "Syncing WebRTC card config", { playback_mode: playbackMode, has_ptz: !!next.ptz }, "frontend");
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
    const categories = Array.isArray(incoming.categories) && incoming.categories.length ? incoming.categories.map((value) => String(value || "").toLowerCase()) : ["audio", "playback", "video", "backend", "controls", "ptz", "webrtc", "service", "state", "render"];
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

  _nextDebugTraceId(prefix = "trace") {
    this._debugTraceSeq = Number.isFinite(this._debugTraceSeq) ? this._debugTraceSeq + 1 : 1;
    return `${String(prefix || "trace").toLowerCase()}-${String(this._debugTraceSeq).padStart(4, "0")}`;
  }

  _getDebugCameraSnapshot() {
    const cam = this.selectedCamera || {};
    const refs = cam?.channel != null ? this.refsForChannel?.(cam.channel) || {} : {};
    const cameraEntity = refs.camera ? this.getEntity?.(refs.camera) : null;
    const playbackState = this.getPlaybackState?.(cam?.channel ?? null) || {};
    return {
      card_version: "1.0.22",
      selected_camera: cam?.name || "",
      channel: cam?.channel != null ? String(cam.channel) : "",
      online: !!this.isOnline?.(),
      ptz_supported: !!this.canPtz?.(),
      returning_home: !!this._returningHome,
      speaker_enabled: !!this._speakerEnabled,
      talk_active: !!this._talkActive,
      stream_mode: String(this._requestedStreamMode || this.config?.stream_mode || "auto"),
      playback_active: cameraEntity?.attributes?.playback_active === true,
      playback_requested_time: playbackState?.currentTime || cameraEntity?.attributes?.playback_requested_time || "",
      webrtc_configured: !!this._videoCardConfig && this._videoCardConfig?.type === "custom:webrtc-camera",
      webrtc_overlay_active: !!this._webRtcPtzBound,
      webrtc_ptz_attempts: this._webRtcPtzBindAttempts || 0,
      webrtc_ptz_last_bind_reason: this._webRtcPtzLastBindReason || "",
      webrtc_ptz_last_bind_at: this._webRtcPtzLastBindAt || "",
      webrtc_ptz_candidate_roots: this._webRtcPtzLastCandidateCount || 0,
      webrtc_ptz_button_count: this._webRtcPtzLastButtonCount || 0,
      speed: Math.max(1, Math.min(100, Number(this.config?.speed || 50))),
      ptz_duration: this.getPTZDuration?.(),
      lens_duration: this.getLensDuration?.(),
    };
  }

  _buildDebugSnapshot(camAttrs = null) {
    const snapshot = this._getDebugCameraSnapshot();
    if (camAttrs && typeof camAttrs === "object") {
      snapshot.backend_flags = this._sanitizeDebugObject({
        stream_mode: camAttrs.stream_mode,
        playback_uri: camAttrs.playback_uri ? "present" : "",
        playback_active: camAttrs.playback_active === true,
        online: camAttrs.online,
      });
    }
    this._lastDebugSnapshot = snapshot;
    return snapshot;
  }

  _pushTraceDebug(category = "general", level = "info", event = "event", message = "", details = {}, traceId = "", source = "frontend") {
    const payload = { ...(details || {}) };
    if (traceId) payload.trace_id = traceId;
    return this._pushDebug(category, level, event, message, payload, source);
  }

  _findDebugTraceEntries(traceId = "") {
    const key = String(traceId || "").trim();
    if (!key) return [];
    return (this._debugEntries || []).filter((entry) => String(entry?.details?.trace_id || "") === key);
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

  _isDebugPanelActive() {
    return this.config?.debug?.enabled === true && this._debugOverlayOpen === true;
  }

  _syncDebugRuntime() {
    const shouldRun = this._isDebugPanelActive() && !!this._hass;
    if (shouldRun) {
      this._subscribeDebug();
      return;
    }
    if (typeof this._debugUnsubscribe === "function") {
      try { this._debugUnsubscribe(); } catch (err) {}
    }
    this._debugUnsubscribe = null;
    this._debugSubscribed = false;
  }

  _toggleVideoAccessoryPanel(panel = "") {
    const next = String(panel || "");
    if (next === "debug") {
      const willOpen = this._debugOverlayOpen !== true;
      this._debugOverlayOpen = willOpen;
      if (willOpen) this._videoAccessoryPanel = "";
    } else {
      this._debugOverlayOpen = false;
      this._videoAccessoryPanel = this._videoAccessoryPanel === next ? "" : next;
    }
    this._syncDebugRuntime();
    this.render();
  }

  _renderVideoAccessoryPanel(content = "") {
    const panel = String(this._videoAccessoryPanel || "");
    if (!panel || !content) return "";
    return `
      <div class="hik-video-accessory-wrap">
        ${content}
      </div>
    `;
  }


  _debugOverlayStorageKey() {
    const cameraKey = this.selectedCamera?.entity || this.selectedCamera?.channel || this.selected || 'default';
    return `ha_hikvision_bridge_card.debug_overlay_rect.${cameraKey}`;
  }

  _debugOverlayMemoryStore() {
    try {
      if (!window.__haHikvisionBridgeCardDebugOverlayRects) window.__haHikvisionBridgeCardDebugOverlayRects = {};
      return window.__haHikvisionBridgeCardDebugOverlayRects;
    } catch (err) {
      return null;
    }
  }

  _normalizeDebugOverlayRect(rect = null) {
    const defaults = { width: 960, height: 620, x: 24, y: 24 };
    const src = rect && typeof rect === "object" ? rect : {};
    const widthRaw = Number(src.width);
    const heightRaw = Number(src.height);
    const xRaw = Number(src.x);
    const yRaw = Number(src.y);
    const width = Math.max(520, Math.min(1400, Number.isFinite(widthRaw) ? widthRaw : defaults.width));
    const height = Math.max(320, Math.min(1000, Number.isFinite(heightRaw) ? heightRaw : defaults.height));
    const x = Math.max(0, Number.isFinite(xRaw) ? xRaw : defaults.x);
    const y = Math.max(0, Number.isFinite(yRaw) ? yRaw : defaults.y);
    return { width, height, x, y };
  }

  _loadDebugOverlayRect() {
    try {
      const key = this._debugOverlayStorageKey();
      const memory = this._debugOverlayMemoryStore();
      const fromMemory = memory && memory[key];
      if (fromMemory) return this._normalizeDebugOverlayRect(fromMemory);
      const raw = window?.localStorage?.getItem?.(key);
      if (!raw) return null;
      const parsed = this._normalizeDebugOverlayRect(JSON.parse(raw));
      if (memory) memory[key] = parsed;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  _saveDebugOverlayRect() {
    try {
      const key = this._debugOverlayStorageKey();
      const rect = this._normalizeDebugOverlayRect(this._debugOverlayRect);
      const memory = this._debugOverlayMemoryStore();
      if (memory) memory[key] = rect;
      window?.localStorage?.setItem?.(key, JSON.stringify(rect));
    } catch (err) {}
  }

  _setDebugOverlayRect(nextRect = {}, { persist = true, rerender = true } = {}) {
    this._debugOverlayRect = this._normalizeDebugOverlayRect({ ...(this._debugOverlayRect || {}), ...(nextRect || {}) });
    if (persist) this._saveDebugOverlayRect();
    if (rerender) this.render();
  }


  _applyDebugOverlayRectToElement(overlay = null, rect = null) {
    const el = overlay || this.querySelector('.hik-debug-terminal-window');
    if (!el) return;
    const next = this._normalizeDebugOverlayRect(rect || this._debugOverlayRect);
    el.style.setProperty('--hik-debug-overlay-x', `${Math.round(next.x)}px`);
    el.style.setProperty('--hik-debug-overlay-y', `${Math.round(next.y)}px`);
    el.style.setProperty('--hik-debug-overlay-width', `${Math.round(next.width)}px`);
    el.style.setProperty('--hik-debug-overlay-height', `${Math.round(next.height)}px`);
  }

  _getDebugOverlayStyle() {
    const rect = this._normalizeDebugOverlayRect(this._debugOverlayRect);
    return `--hik-debug-overlay-x:${Math.round(rect.x)}px; --hik-debug-overlay-y:${Math.round(rect.y)}px; --hik-debug-overlay-width:${Math.round(rect.width)}px; --hik-debug-overlay-height:${Math.round(rect.height)}px;`;
  }

  _resetDebugOverlayRect() {
    this._setDebugOverlayRect(this._normalizeDebugOverlayRect(null));
  }

  _clampDebugOverlayRect(rect = null) {
    const next = this._normalizeDebugOverlayRect(rect || this._debugOverlayRect);
    const host = this.querySelector('.hik-video-block') || this.querySelector('.hik-card') || this;
    const hostWidth = Math.max(640, Math.round(host?.clientWidth || 0) || 960);
    const hostHeight = Math.max(420, Math.round(host?.clientHeight || 0) || 620);
    const width = Math.min(Math.max(520, next.width), Math.max(520, hostWidth - 24));
    const height = Math.min(Math.max(320, next.height), Math.max(320, hostHeight - 24));
    const maxX = Math.max(0, hostWidth - width - 12);
    const maxY = Math.max(0, hostHeight - height - 12);
    return { width, height, x: Math.min(Math.max(0, next.x), maxX), y: Math.min(Math.max(0, next.y), maxY) };
  }

  _bindDebugOverlayInteractions() {
    const overlay = this.querySelector('.hik-debug-terminal-window');
    const handle = this.querySelector('.hik-debug-terminal-head');
    const resizeHandle = this.querySelector('.hik-debug-resize-handle');
    if (!overlay || !handle || !resizeHandle) return;
    if (overlay.__hikDebugOverlayBound === true) {
      this._applyDebugOverlayRectToElement(overlay);
      return;
    }
    overlay.__hikDebugOverlayBound = true;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const target = event.target;
      if (target?.closest?.('button, input, select, textarea, a, [data-debug-global-action], [data-debug-entry-action], [data-debug-filter]')) return;
      event.preventDefault();
      const startRect = this._clampDebugOverlayRect(this._debugOverlayRect);
      this._debugOverlayDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect: startRect };
      overlay.classList.add('is-moving');
      try { handle.setPointerCapture(event.pointerId); } catch (err) {}
    });

    handle.addEventListener('pointermove', (event) => {
      if (!this._debugOverlayDrag || this._debugOverlayDrag.pointerId !== event.pointerId) return;
      const start = this._debugOverlayDrag;
      const next = this._clampDebugOverlayRect({ ...start.rect, x: start.rect.x + (event.clientX - start.startX), y: start.rect.y + (event.clientY - start.startY) });
      this._debugOverlayRect = next;
      this._applyDebugOverlayRectToElement(overlay, next);
    });

    const endDrag = (event) => {
      if (!this._debugOverlayDrag || this._debugOverlayDrag.pointerId !== event.pointerId) return;
      try { handle.releasePointerCapture(event.pointerId); } catch (err) {}
      overlay.classList.remove('is-moving');
      this._debugOverlayDrag = null;
      const next = this._clampDebugOverlayRect(this._debugOverlayRect);
      this._setDebugOverlayRect(next, { persist: true, rerender: false });
      this._applyDebugOverlayRectToElement(overlay, next);
      overlay.style.setProperty('--hik-debug-overlay-width', `${Math.round(next.width)}px`);
      overlay.style.setProperty('--hik-debug-overlay-height', `${Math.round(next.height)}px`);
    };

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const startRect = this._clampDebugOverlayRect(this._debugOverlayRect);
      this._debugOverlayResize = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect: startRect };
      overlay.classList.add('is-resizing');
      try { resizeHandle.setPointerCapture(event.pointerId); } catch (err) {}
    });

    resizeHandle.addEventListener('pointermove', (event) => {
      if (!this._debugOverlayResize || this._debugOverlayResize.pointerId !== event.pointerId) return;
      const start = this._debugOverlayResize;
      const next = this._clampDebugOverlayRect({
        ...start.rect,
        width: start.rect.width + (event.clientX - start.startX),
        height: start.rect.height + (event.clientY - start.startY),
      });
      this._debugOverlayRect = next;
      overlay.style.setProperty('--hik-debug-overlay-width', `${Math.round(next.width)}px`);
      overlay.style.setProperty('--hik-debug-overlay-height', `${Math.round(next.height)}px`);
      this._applyDebugOverlayRectToElement(overlay, next);
    });

    const endResize = (event) => {
      if (!this._debugOverlayResize || this._debugOverlayResize.pointerId !== event.pointerId) return;
      try { resizeHandle.releasePointerCapture(event.pointerId); } catch (err) {}
      overlay.classList.remove('is-resizing');
      this._debugOverlayResize = null;
      const next = this._clampDebugOverlayRect(this._debugOverlayRect);
      this._setDebugOverlayRect(next, { persist: true, rerender: false });
      this._applyDebugOverlayRectToElement(overlay, next);
      overlay.style.setProperty('--hik-debug-overlay-width', `${Math.round(next.width)}px`);
      overlay.style.setProperty('--hik-debug-overlay-height', `${Math.round(next.height)}px`);
    };

    resizeHandle.addEventListener('pointerup', endResize);
    resizeHandle.addEventListener('pointercancel', endResize);
  }

  _pushDebug(category = "general", level = "info", event = "event", message = "", details = {}, source = "frontend") {
    if (!this._isDebugPanelActive()) return null;
    const entry = {
      idx: ++this._debugSeq,
      time: new Date().toISOString(),
      category: String(category || "general").toLowerCase(),
      level: String(level || "info").toLowerCase(),
      source: String(source || "frontend").toLowerCase(),
      event: String(event || "event"),
      message: String(message || event || "Event"),
      camera: this.selectedCamera?.channel != null ? String(this.selectedCamera.channel) : "",
      details: this._sanitizeDebugObject({
        ...(details || {}),
        snapshot: (details && details.snapshot) ? details.snapshot : this._buildDebugSnapshot(this._lastCameraAttrs || null),
      }),
    };
    const maxEntries = Number(this.config?.debug?.max_entries ?? 150) || 150;
    this._debugEntries = [...(this._debugEntries || []), entry].slice(-maxEntries);
    return entry;
  }

_subscribeDebug() {
  if (!this._isDebugPanelActive() || !this._hass || this._debugSubscribed) return;

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
    const classification = String(
      entry?.classification
      || entry?.response?.classification
      || entry?.context?.classification
      || entry?.details?.classification
      || ""
    ).trim().toLowerCase();
    return {
      idx: entry?.id || `backend-${index}-${entry?.requested_time || entry?.search_start || entry?.ts || index}`,
      time: entry?.ts || entry?.time || entry?.requested_time || entry?.search_start || new Date().toISOString(),
      category: String(entry?.category || "backend").toLowerCase(),
      level: String(entry?.level || legacyLevel).toLowerCase(),
      source: "backend",
      event: entry?.event || "backend_event",
      message: entry?.message || entry?.reason || entry?.error || `Backend event${responseStatus ? ` HTTP ${responseStatus}` : ""}`,
      camera: cameraId ? String(cameraId) : "",
      classification,
      details: this._sanitizeDebugObject({
        entry_id: entry?.entry_id,
        classification,
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
    const query = String(this._debugSearchQuery || "").trim().toLowerCase();
    return (this._debugEntries || []).filter((entry) => {
      const categoryMatch = categoryFilters.has("all") || categoryFilters.has(String(entry?.category || "").toLowerCase());
      const levelMatch = levelFilters.has("all") || levelFilters.has(String(entry?.level || "").toLowerCase());
      if (!categoryMatch || !levelMatch) return false;
      if (!query) return true;
      const haystack = [
        entry?.time,
        entry?.source,
        entry?.category,
        entry?.level,
        entry?.event,
        entry?.message,
        entry?.camera,
        entry?.details?.trace_id,
        (() => {
          try { return JSON.stringify(this._sanitizeDebugObject(entry?.details || {})); }
          catch (err) { return ""; }
        })(),
      ].join(" ").toLowerCase();
      return haystack.includes(query);
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
      `Trace: ${entry?.details?.trace_id || ""}`,
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
    const fallbackCopy = () => {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "readonly");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        textarea.style.pointerEvents = "none";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        document.execCommand("copy");
        textarea.remove();
      } catch (err) {
        console.error("Failed to copy debug text", err);
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).catch(() => fallbackCopy());
      return;
    }
    fallbackCopy();
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

  _getPanelOpenState(key, defaultOpen = true) {
    if (!key) return defaultOpen;
    return Object.prototype.hasOwnProperty.call(this._panelOpenState || {}, key)
      ? this._panelOpenState[key] === true
      : defaultOpen;
  }

  _setPanelOpenState(key, open) {
    if (!key) return;
    this._panelOpenState = { ...(this._panelOpenState || {}), [key]: open === true };
  }

  _slugifyPanelKey(value) {
    return String(value || "section")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  }

  _makePanelsExpandable() {
    const getDirectChild = (panel, className) => Array.from(panel?.children || []).find((node) => node.classList?.contains(className)) || null;
    const wrapPanel = (panel, options = {}) => {
      if (!panel) return;
      if (panel.querySelector(':scope > details[data-expandable-key]')) return;

      const key = options.key || this._slugifyPanelKey(options.title || options.icon || 'section');
      const title = String(options.title || 'Section');
      const icon = String(options.icon || 'mdi:chevron-down');
      const defaultOpen = options.defaultOpen !== false;
      const note = String(options.note || '').trim();
      const headerClass = options.headerClass || '';
      const headerNode = headerClass ? getDirectChild(panel, headerClass) : null;

      if (headerNode) {
        try { headerNode.remove(); } catch (err) {}
      }

      const details = document.createElement('details');
      details.className = 'hik-expandable-details';
      details.dataset.expandableKey = key;
      if (this._getPanelOpenState(key, defaultOpen)) details.open = true;

      const summary = document.createElement('summary');
      summary.className = 'hik-debug-summary hik-expandable-summary';

      const titleWrap = document.createElement('span');
      titleWrap.className = 'hik-sub';
      titleWrap.style.margin = '0';

      const iconEl = document.createElement('ha-icon');
      iconEl.setAttribute('icon', icon);
      titleWrap.appendChild(iconEl);
      const titleText = document.createElement('span');
      titleText.textContent = title;
      titleWrap.appendChild(titleText);
      summary.appendChild(titleWrap);

      if (note) {
        const noteSpan = document.createElement('span');
        noteSpan.className = 'hik-mini-note';
        noteSpan.textContent = note;
        summary.appendChild(noteSpan);
      }

      const body = document.createElement('div');
      body.className = 'hik-expandable-body';
      while (panel.firstChild) body.appendChild(panel.firstChild);
      details.appendChild(summary);
      details.appendChild(body);
      panel.appendChild(details);
      panel.classList.add('hik-expandable-panel');
    };

    wrapPanel(this.querySelector('.hik-controls-block'), {
      key: 'controls',
      title: 'Controls',
      icon: 'mdi:gamepad-round-up',
      headerClass: 'hik-controls-head',
      note: this._controlsVisible ? 'PTZ, zoom, focus, presets' : 'Use Show controls to expand'
    });

    const audioPanel = this.querySelector('.hik-audio-panel');
    wrapPanel(audioPanel, {
      key: 'audio-console',
      title: 'Audio Console',
      icon: 'mdi:volume-source',
      headerClass: 'hik-audio-head',
      note: audioPanel ? Array.from(audioPanel.querySelectorAll('.hik-audio-head .hik-pill')).slice(0, 2).map((node) => node.textContent.trim()).filter(Boolean).join(' · ') : ''
    });

    const playbackPanel = this.querySelector('.hik-playback-panel');
    wrapPanel(playbackPanel, {
      key: 'playback',
      title: 'Playback',
      icon: 'mdi:play-box-multiple-outline',
      headerClass: 'hik-sub',
      note: playbackPanel?.querySelector('#hik-playback-time')?.value || ''
    });

    const positionPanel = this.querySelector('.hik-position-card');
    wrapPanel(positionPanel, {
      key: 'position-tracker',
      title: 'Position Tracker',
      icon: 'mdi:crosshairs-question',
      headerClass: 'hik-position-head',
      note: positionPanel?.querySelector('.hik-position-head .hik-pill')?.textContent?.trim() || ''
    });

    this.querySelectorAll('.hik-info-grid > .hik-panel.hik-info-card:not(.hik-debug-dashboard)').forEach((panel) => {
      const titleNode = getDirectChild(panel, 'hik-sub');
      const title = titleNode?.textContent?.trim() || 'Info';
      const icon = titleNode?.querySelector('ha-icon')?.getAttribute('icon') || 'mdi:information-outline';
      wrapPanel(panel, {
        key: `info-${this._slugifyPanelKey(title)}`,
        title,
        icon,
        headerClass: 'hik-sub'
      });
    });
  }


  _buildDebugCategorySummary() {
    const categories = ["audio", "playback", "video", "backend", "controls", "ptz", "webrtc", "service", "state", "render"];
    const entries = this._debugEntries || [];
    return categories.reduce((acc, category) => {
      acc[category] = entries.filter((entry) => entry.category === category).length;
      return acc;
    }, {});
  }

  _renderDebugSnapshot(camAttrs = {}) {
    const snapshot = this._buildDebugSnapshot(camAttrs);
    return `
      <div class="hik-debug-snapshot-grid">
        <span class="hik-pill neutral"><ha-icon icon="mdi:cctv"></ha-icon>CH ${this.escapeHtml(snapshot.channel || "-")}</span>
        <span class="hik-pill ${snapshot.online ? "good" : "warn"}"><ha-icon icon="mdi:lan-connect"></ha-icon>${snapshot.online ? "Online" : "Offline"}</span>
        <span class="hik-pill ${snapshot.ptz_supported ? "good" : "neutral"}"><ha-icon icon="mdi:axis-arrow"></ha-icon>PTZ ${snapshot.ptz_supported ? "Ready" : "Off"}</span>
        <span class="hik-pill ${snapshot.webrtc_overlay_active ? "good" : "neutral"}"><ha-icon icon="mdi:video-wireless-outline"></ha-icon>Overlay ${this.escapeHtml(String(snapshot.webrtc_overlay_active))}</span>
        <span class="hik-pill neutral"><ha-icon icon="mdi:speedometer"></ha-icon>Speed ${this.escapeHtml(String(snapshot.speed || "-"))}</span>
        <span class="hik-pill neutral"><ha-icon icon="mdi:timer-outline"></ha-icon>PTZ ${this.escapeHtml(String(snapshot.ptz_duration || "-"))}ms</span>
        <span class="hik-pill neutral"><ha-icon icon="mdi:camera-control"></ha-icon>Lens ${this.escapeHtml(String(snapshot.lens_duration || "-"))}ms</span>
        <span class="hik-pill neutral"><ha-icon icon="mdi:play-network-outline"></ha-icon>${this.escapeHtml(snapshot.stream_mode || "auto")}</span>
        <span class="hik-pill neutral"><ha-icon icon="mdi:volume-high"></ha-icon>Speaker ${snapshot.speaker_enabled ? "On" : "Off"}</span>
        <span class="hik-pill neutral"><ha-icon icon="mdi:microphone"></ha-icon>Talk ${snapshot.talk_active ? "Live" : "Idle"}</span>
      </div>`;
  }

  _getLatestTraceIdForCategory(category = "") {
    const key = String(category || "").toLowerCase();
    const entry = (this._debugEntries || []).slice().reverse().find((item) => (!key || item.category === key) && item?.details?.trace_id);
    return entry?.details?.trace_id || "";
  }

  _renderDebugDashboardBody(camAttrs = {}, options = {}) {
    if (!this.isDebugEnabled()) return "";
    const terminalMode = options?.terminal === true;
    this._lastCameraAttrs = camAttrs || {};
    this._syncBackendDebugEntries(camAttrs?.playback_debug || []);
    const entries = this._getFilteredDebugEntries();
    const categorySummary = this._buildDebugCategorySummary();
    const summary = {
      total: (this._debugEntries || []).length,
      error: (this._debugEntries || []).filter((entry) => entry.level === "error").length,
      warn: (this._debugEntries || []).filter((entry) => entry.level === "warn").length,
      ...categorySummary,
    };
    const categories = ["all", "audio", "playback", "video", "backend", "controls", "ptz", "webrtc", "service", "state", "render"];
    const levels = ["all", "error", "warn", "info", "debug"];
    const searchValue = this.escapeHtml(String(this._debugSearchQuery || ""));
    const visibleEntries = entries.slice(0, terminalMode ? 120 : 80);
    const entryKey = (entry) => [
      entry?.time || "",
      entry?.category || "",
      entry?.level || "",
      entry?.event || "",
      entry?.camera != null ? String(entry.camera) : "",
      entry?.source || "",
    ].join("|");
    const validSelectedKey = visibleEntries.some((entry) => entryKey(entry) === this._debugSelectedKey) ? this._debugSelectedKey : "";
    const selectedKey = validSelectedKey || (visibleEntries[0] ? entryKey(visibleEntries[0]) : "");
    this._debugSelectedKey = selectedKey || "";
    const selectedEntry = visibleEntries.find((entry) => entryKey(entry) === selectedKey) || null;
    const selectedDebugText = selectedEntry ? this.formatDebugEntryText(selectedEntry) : "";
    const selectedDetailsText = selectedEntry?.details ? JSON.stringify(selectedEntry.details, null, 2) : "";
    const rowClass = (entry) => {
      const level = String(entry?.level || "info").toLowerCase();
      if (level === "error") return "is-error";
      if (level === "warn") return "is-warn";
      if (level === "debug") return "is-debug";
      return "is-info";
    };
    return `
      <div class="hik-debug-warning-banner ${terminalMode ? "is-terminal" : ""}">
        <ha-icon icon="mdi:alert-outline"></ha-icon>
        <div>
          <b>Debug mode enabled</b>
          <span>Verbose diagnostics can reduce browser performance. Disable when not actively troubleshooting.</span>
        </div>
      </div>
      <div class="hik-debug-overview ${terminalMode ? "is-terminal" : ""}">
        <div class="hik-mini-note">Current snapshot</div>
        ${this._renderDebugSnapshot(camAttrs)}
        <div class="hik-status-row">
          <span class="hik-pill neutral"><ha-icon icon="mdi:counter"></ha-icon>Total ${this.escapeHtml(String(summary.total))}</span>
          <span class="hik-pill ${summary.error ? "warn" : "neutral"}"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>Errors ${this.escapeHtml(String(summary.error))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:alert-outline"></ha-icon>Warn ${this.escapeHtml(String(summary.warn))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:microphone-outline"></ha-icon>Audio ${this.escapeHtml(String(summary.audio))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:play-box-multiple-outline"></ha-icon>Playback ${this.escapeHtml(String(summary.playback))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:video-outline"></ha-icon>Video ${this.escapeHtml(String(summary.video))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:server-network-outline"></ha-icon>Backend ${this.escapeHtml(String(summary.backend))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:gesture-tap-button"></ha-icon>Controls ${this.escapeHtml(String(summary.controls))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:axis-arrow"></ha-icon>PTZ ${this.escapeHtml(String(summary.ptz))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:video-wireless-outline"></ha-icon>WebRTC ${this.escapeHtml(String(summary.webrtc))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:api"></ha-icon>Service ${this.escapeHtml(String(summary.service))}</span>
          <span class="hik-pill neutral"><ha-icon icon="mdi:state-machine"></ha-icon>State ${this.escapeHtml(String(summary.state))}</span>
        </div>
      </div>
      <div class="hik-debug-console-shell ${terminalMode ? "is-terminal" : ""}">
        <div class="hik-debug-toolbar ${terminalMode ? "is-terminal" : ""}">
          <div class="hik-debug-toolbar-head">
            <label class="hik-debug-search-wrap">
              <ha-icon icon="mdi:magnify"></ha-icon>
              <input class="hik-debug-search" type="search" placeholder="Search event, message, trace, details" value="${searchValue}" data-debug-search>
            </label>
            <div class="hik-debug-actions">
              <button type="button" class="hik-debug-btn" data-debug-global-action="copy-all">Copy shown</button>
              <button type="button" class="hik-debug-btn" data-debug-global-action="download-all">Download shown</button>
              <button type="button" class="hik-debug-btn" data-debug-global-action="copy-last-ptz-trace">Copy last PTZ trace</button>
              <button type="button" class="hik-debug-btn" data-debug-global-action="clear">Clear frontend</button>
            </div>
          </div>
          <div class="hik-debug-filter-group">
            ${categories.map((value) => `<button type="button" class="hik-debug-chip ${(this._debugFilters?.categories || ["all"]).includes(value) ? "active" : ""}" data-debug-filter="categories" data-debug-value="${value}">${this.escapeHtml(value)}</button>`).join("")}
          </div>
          <div class="hik-debug-filter-group">
            ${levels.map((value) => `<button type="button" class="hik-debug-chip ${(this._debugFilters?.levels || ["all"]).includes(value) ? "active" : ""}" data-debug-filter="levels" data-debug-value="${value}">${this.escapeHtml(value)}</button>`).join("")}
          </div>
        </div>
        <div class="hik-debug-list-shell ${terminalMode ? "is-terminal" : ""}">
          <div class="hik-debug-list-head" role="row">
            <span>Level</span>
            <span>Time</span>
            <span>Category</span>
            <span>Event</span>
            <span>Message</span>
            <span>Cam</span>
          </div>
          <div class="hik-debug-feed" role="log" aria-live="polite">
            ${visibleEntries.length ? visibleEntries.map((entry) => {
              const key = entryKey(entry);
              const selected = key === selectedKey;
              return `
                <button type="button" class="hik-debug-row ${rowClass(entry)} ${selected ? "selected" : ""}" data-debug-select="${this.escapeHtml(key)}" title="${this.escapeHtml(entry.message || entry.event || "")}">
                  <span class="hik-debug-cell hik-debug-level-cell"><span class="hik-debug-level-badge ${rowClass(entry)}">${this.escapeHtml(String(entry.level || "info").toUpperCase())}</span></span>
                  <span class="hik-debug-cell hik-debug-time-cell">${this.escapeHtml((entry.time || "").split("T")[1] || entry.time || "")}</span>
                  <span class="hik-debug-cell">${this.escapeHtml(entry.category || "general")}</span>
                  <span class="hik-debug-cell hik-debug-event-cell">${this.escapeHtml(entry.event || "event")}</span>
                  <span class="hik-debug-cell hik-debug-message-cell">${this.escapeHtml(entry.message || "")}</span>
                  <span class="hik-debug-cell hik-debug-cam-cell">${entry.camera ? `CH ${this.escapeHtml(String(entry.camera))}` : "-"}</span>
                </button>`;
            }).join("") : `<div class="hik-empty-note">No debug events for the current filters.</div>`}
          </div>
        </div>
        ${selectedEntry ? `
          <div class="hik-debug-detail-pane ${terminalMode ? "is-terminal" : ""}">
            <div class="hik-debug-detail-head">
              <div class="hik-debug-detail-title">
                <div class="hik-debug-detail-kicker">Selected event</div>
                <div class="hik-debug-detail-name">${this.escapeHtml(selectedEntry.event || "event")}</div>
              </div>
              <div class="hik-debug-actions">
                <button type="button" class="hik-debug-btn" data-debug-entry-action="copy">Copy</button>
                <button type="button" class="hik-debug-btn" data-debug-entry-action="download">Download</button>
              </div>
            </div>
            <div class="hik-status-row">
              <span class="hik-pill ${rowClass(selectedEntry) === "is-error" ? "warn" : rowClass(selectedEntry) === "is-warn" ? "primary" : "neutral"}"><ha-icon icon="mdi:flag-outline"></ha-icon>${this.escapeHtml(selectedEntry.level || "info")}</span>
              <span class="hik-pill neutral"><ha-icon icon="mdi:timeline-clock-outline"></ha-icon>${this.escapeHtml(selectedEntry.time || "")}</span>
              <span class="hik-pill neutral"><ha-icon icon="mdi:shape-outline"></ha-icon>${this.escapeHtml(selectedEntry.category || "general")}</span>
              <span class="hik-pill neutral"><ha-icon icon="mdi:source-branch"></ha-icon>${this.escapeHtml(selectedEntry.source || "frontend")}</span>
              ${selectedEntry.camera ? `<span class="hik-pill neutral"><ha-icon icon="mdi:cctv"></ha-icon>CH ${this.escapeHtml(String(selectedEntry.camera))}</span>` : ""}
              ${selectedEntry.classification ? `<span class="hik-pill neutral"><ha-icon icon="mdi:shape-plus-outline"></ha-icon>${this.escapeHtml(String(selectedEntry.classification))}</span>` : ""}
              ${selectedEntry?.details?.trace_id ? `<span class="hik-pill neutral"><ha-icon icon="mdi:timeline-text-outline"></ha-icon>${this.escapeHtml(String(selectedEntry.details.trace_id))}</span>` : ""}
            </div>
            ${selectedEntry.classification ? `<div class="hik-debug-classification-note">Endpoint classification: <b>${this.escapeHtml(String(selectedEntry.classification))}</b></div>` : ""}
            <div class="hik-debug-detail-message">${this.escapeHtml(selectedEntry.message || "")}</div>
            <textarea class="hik-debug-textarea" readonly>${this.escapeHtml(selectedDebugText)}</textarea>
            ${selectedEntry?.details ? `
              <details class="hik-debug-nested-details">
                <summary>Details JSON</summary>
                <pre class="hik-debug-pre">${this.escapeHtml(selectedDetailsText)}</pre>
              </details>
            ` : ""}
          </div>
        ` : ""}
      </div>`;
  }

  renderDebugDashboard(camAttrs = {}) {
    if (!this.isDebugEnabled()) return "";
    const openAttr = this._debugDashboardOpen ? "open" : "";
    return `
      <div class="hik-panel hik-info-card hik-debug-dashboard">
        <details id="hik-debug-dashboard-details" ${openAttr}>
          <summary class="hik-debug-summary">
            <span class="hik-sub"><ha-icon icon="mdi:bug-outline"></ha-icon>Debug Dashboard</span>
          </summary>
          ${this._renderDebugDashboardBody(camAttrs, { terminal: false })}
        </details>
      </div>`;
  }

  renderDebugOverlay(camAttrs = {}) {
    if (!this._isDebugPanelActive()) return "";
    return `
      <div class="hik-debug-terminal-overlay" role="dialog" aria-modal="false" aria-label="Debug console overlay">
        <div class="hik-debug-terminal-window" style="${this._getDebugOverlayStyle()}">
          <div class="hik-debug-terminal-head">
            <div class="hik-debug-terminal-title">
              <span class="hik-debug-terminal-dot red"></span>
              <span class="hik-debug-terminal-dot amber"></span>
              <span class="hik-debug-terminal-dot green"></span>
              <ha-icon icon="mdi:console-line"></ha-icon>
              <span>Debug Console</span>
            </div>
            <div class="hik-debug-terminal-actions">
              <button type="button" class="hik-video-media-btn" id="hik-debug-overlay-reset" title="Reset debug console size and position" aria-label="Reset debug console size and position">
                <ha-icon icon="mdi:fit-to-screen-outline"></ha-icon>
              </button>
              <button type="button" class="hik-video-media-btn" id="hik-debug-overlay-minimize" title="Close debug console" aria-label="Close debug console">
                <ha-icon icon="mdi:close"></ha-icon>
              </button>
            </div>
          </div>
          <div class="hik-debug-terminal-body">
            ${this._renderDebugDashboardBody(camAttrs, { terminal: true })}
          </div>
          <button type="button" class="hik-debug-resize-handle" aria-label="Resize debug console" title="Resize debug console"></button>
        </div>
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

      const micConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      };
      this._pushAudioDebug("mic_request", { constraints: micConstraints });
      this._talkStream = await navigator.mediaDevices.getUserMedia(micConstraints);
      this._ensureTalkAudioGraph(this._talkStream);
      this._setAudioDebugStatus({ mic: "granted" });
      this._pushAudioDebug("mic_granted", { trackCount: this._talkStream?.getTracks?.().length || 0 });

      const pc = new RTCPeerConnection();
      pc.addEventListener("connectionstatechange", () => {
        const state = pc.connectionState || "unknown";
        this._setAudioDebugStatus({ pc: state });
        this._pushAudioDebug("pc_state", { state });
      });
      pc.addEventListener("iceconnectionstatechange", () => {
        const state = pc.iceConnectionState || "unknown";
        this._setAudioDebugStatus({ ice: state });
        this._pushAudioDebug("ice_state", { state });
      });
      pc.addEventListener("signalingstatechange", () => {
        const state = pc.signalingState || "unknown";
        this._setAudioDebugStatus({ signaling: state });
        this._pushAudioDebug("signaling_state", { state });
      });
      this._pushAudioDebug("pc_created", {});
      const processedTalkStream = this._talkAudioGraph?.destination?.stream?.getAudioTracks?.().length
        ? this._talkAudioGraph.destination.stream
        : this._talkStream;
      processedTalkStream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, processedTalkStream);
        this._pushAudioDebug("track_added", {
          kind: track.kind,
          id: track.id,
          enabled: track.enabled,
          muted: typeof track.muted === "boolean" ? track.muted : undefined,
          readyState: track.readyState,
          sender: !!sender,
          processed: processedTalkStream !== this._talkStream,
        });
      });

      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      this._pushAudioDebug("offer_created", { hasSdp: !!offer?.sdp, type: offer?.type || "offer" });
      await pc.setLocalDescription(offer);
      this._pushAudioDebug("local_description_set", { type: pc.localDescription?.type || "", hasSdp: !!pc.localDescription?.sdp });

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
              this._pushAudioDebug("remote_description_set", { type: "answer", hasSdp: !!msg.value });
              cleanup();
              resolve();
              return;
            }
            if (msg.type === "error") {
              this._pushAudioDebug("server_error", { error: msg.value || "unknown" });
            }
            if (msg.type === "webrtc/candidate" && msg.value) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(msg.value));
                this._pushAudioDebug("ice_candidate_received", {
                  candidate: msg.value?.candidate || "",
                  sdpMid: msg.value?.sdpMid || "",
                  sdpMLineIndex: msg.value?.sdpMLineIndex,
                });
              } catch (e) {
                this._pushAudioDebug("ice_candidate_failed", { error: String(e?.message || e) });
              }
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
          this._pushAudioDebug("ice_candidate_sent", {
            candidate: event.candidate?.candidate || "",
            sdpMid: event.candidate?.sdpMid || "",
            sdpMLineIndex: event.candidate?.sdpMLineIndex,
          });
        } else if (!event.candidate) {
          this._pushAudioDebug("ice_gathering_complete", {});
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
    this._pushAudioDebug("talk_stop", {
      hadWs: !!this._talkWs,
      hadPc: !!this._talkPc,
      hadStream: !!this._talkStream,
      active: !!this._talkActive,
    });
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
    this._teardownTalkAudioGraph();
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
      camera: this.findEntityForChannel(channel, "camera"),
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

  stopMove(context = {}) {
    if (this._repeatHandle) {
      clearInterval(this._repeatHandle);
      this._repeatHandle = null;
      this._pushTraceDebug("ptz", "debug", "ptz_stop", "Stopped PTZ repeat loop", { ...context }, context?.trace_id || "", "frontend");
    } else if (context?.trace_id) {
      this._pushTraceDebug("ptz", "debug", "ptz_stop_noop", "PTZ stop requested with no active repeat loop", { ...context }, context?.trace_id || "", "frontend");
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
    const traceId = options?.trace_id || this._nextDebugTraceId("lens");
    if (!cam || !this._hass || !this.isOnline() || this._returningHome) {
      this._pushTraceDebug("service", "warn", "lens_pulse_skipped", "Skipped lens pulse", { service, direction: Number(direction || 0), online: this.isOnline(), returning_home: !!this._returningHome }, traceId, "frontend");
      return Promise.resolve(false);
    }

    const duration = Math.max(0, Number(options.duration ?? this.getLensDuration()));
    const speed = Number(options.speed ?? (service === "zoom"
      ? Number(this.config.speed || 50)
      : Number(this.config.lens_step || 60)));

    this._pushTraceDebug("service", "info", "lens_pulse_requested", `Calling lens service ${service}`, { service, direction: Number(direction || 0), speed, duration, source: options?.source || "panel" }, traceId, "frontend");
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
        this._pushTraceDebug("service", "info", "lens_pulse_requested", `Calling lens service ${service}`, { service, direction: Number(direction || 0), speed, duration, source: options?.source || "panel" }, traceId, "frontend");
    this._hass.callService("ha_hikvision_bridge", service, {
          channel: String(cam.channel),
          direction: 0,
          speed,
          duration: 0,
        });
      }, duration + 20);
    }

    this._pushTraceDebug("service", "debug", "lens_pulse_dispatched", `Lens service ${service} dispatched`, { service, direction: Number(direction || 0), speed, duration }, traceId, "frontend");
    return Promise.resolve(true);
  }

  async handleRefocus() {
    const cam = this.selectedCamera;
    const traceId = this._nextDebugTraceId("lens");
    if (!cam || !this._hass || !this.isOnline() || this._returningHome) {
      this._pushTraceDebug("controls", "warn", "refocus_skipped", "Skipped refocus", { online: this.isOnline(), returning_home: !!this._returningHome }, traceId, "frontend");
      return;
    }
    this._pushTraceDebug("controls", "info", "refocus_requested", "Refocus requested", {}, traceId, "frontend");

    const pulse = this.getLensDuration();
    const settle = Math.max(80, Math.min(250, Math.round(pulse * 0.75)));
    const step = Math.max(1, Number(this.config.refocus_step ?? 40));

    await this.executeLensPulse("zoom", 1, { duration: pulse, speed: step, trace_id: traceId, source: "refocus" });
    await new Promise((resolve) => window.setTimeout(resolve, pulse + settle));
    await this.executeLensPulse("zoom", -1, { duration: pulse, speed: step, trace_id: traceId, source: "refocus" });
  }

  startMove(pan, tilt, context = {}) {
    const traceId = context?.trace_id || this._nextDebugTraceId("ptz");
    this.stopMove({ ...context, trace_id: traceId, action: context?.action || "pre_start" });
    this._pushTraceDebug("ptz", "info", "ptz_move_requested", "Starting PTZ move", { pan, tilt, duration: this.getPTZDuration(), repeat_ms: this.config.repeat_ms, source: context?.source || "panel" }, traceId, "frontend");
    const run = () => {
      const cam = this.selectedCamera;
      if (!cam || !this._hass || !this.canPtz() || this._returningHome) {
        this._pushTraceDebug("ptz", "warn", "ptz_move_tick_skipped", "Skipped PTZ move tick", { pan, tilt, can_ptz: this.canPtz(), returning_home: !!this._returningHome }, traceId, "frontend");
        return;
      }
      this._pushTraceDebug("service", "debug", "ptz_service_requested", "Calling PTZ service", { pan, tilt, duration: this.getPTZDuration(), source: context?.source || "panel" }, traceId, "frontend");
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
    this._pushTraceDebug("ptz", "debug", "ptz_repeat_armed", "Armed PTZ repeat loop", { repeat_ms: this.config.repeat_ms }, traceId, "frontend");
  }

  callLens(service, direction = 0, context = {}) {
    const traceId = context?.trace_id || this._nextDebugTraceId("lens");
    this._pushTraceDebug("controls", "info", "lens_control_clicked", `Lens control ${service}`, { service, direction: Number(direction || 0), source: context?.source || "panel" }, traceId, "frontend");
    this.executeLensPulse(service, direction, { ...context, trace_id: traceId });
  }

  handleCenter() {
    this.handleReturnHome();
    if (this.config.controls_mode === "toggle") {
      this._controlsVisible = true;
    }
  }

  gotoPreset(preset) {
    const cam = this.selectedCamera;
    const traceId = this._nextDebugTraceId("ptz");
    if (!cam || !this._hass || !this.canPtz()) {
      this._pushTraceDebug("controls", "warn", "preset_skipped", "Skipped goto preset", { preset, can_ptz: this.canPtz() }, traceId, "frontend");
      return;
    }
    this._pushTraceDebug("controls", "info", "preset_requested", "Goto preset requested", { preset }, traceId, "frontend");
    this._hass.callService("ha_hikvision_bridge", "goto_preset", {
      channel: String(cam.channel),
      preset,
    });
  }

  isOnline() {
    const cam = this.selectedCamera;
    if (!cam) return false;
    if (this._gridMode) {
      this._gridFocusChannel = this._resolveGridFocusChannel();
    }
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

            <div class="hik-motion-grid hik-motion-grid-overlay">
              <div class="hik-pad-shell">
                <div class="hik-pad-wrap hik-webrtc-pad-wrap">
                  <div class="hik-pad-stage hik-webrtc-stage">
                    <div class="hik-pad-meta-row">
                      <span class="hik-console-badge"><ha-icon icon="mdi:star-four-points-outline"></ha-icon>Primary control surface is now on-video</span>
                    </div>
                    <div class="hik-webrtc-note hik-overlay-primary-note">
                      <ha-icon icon="mdi:gesture-tap-hold"></ha-icon>
                      <div>
                        <div class="hik-webrtc-note-title">Premium overlay active</div>
                        <div class="hik-webrtc-note-copy">Pan, tilt, zoom, and refocus now live directly on the video. The lower motion console keeps only speed and status context.</div>
                      </div>
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
  const cam = this.selectedCamera;
  const traceId = this._nextDebugTraceId("playback");
  const state = this.getPlaybackState();
  const now = Date.now();
  const cooldownMs = 1000;

  if (!cam || !this._hass) {
    this._pushTraceDebug("playback", "warn", "playback_seek_skipped", "Playback seek skipped", {
      reason: "missing_camera_or_hass",
      direction: Number(direction || 1),
    }, traceId, "frontend");
    return;
  }

  if (this._playbackSeekInFlight) {
    this._pushTraceDebug("playback", "warn", "playback_seek_skipped", "Playback seek skipped", {
      reason: "seek_in_flight",
      direction: Number(direction || 1),
    }, traceId, "frontend");
    return;
  }

  if (now - this._lastPlaybackSeekAt < cooldownMs) {
    this._pushTraceDebug("playback", "warn", "playback_seek_skipped", "Playback seek skipped", {
      reason: "cooldown",
      direction: Number(direction || 1),
      cooldown_ms: cooldownMs,
    }, traceId, "frontend");
    return;
  }

  const refs = this.refsForChannel(cam.channel);
  const cameraEntity = refs.camera ? this.getEntity(refs.camera) : null;
  const camAttrs = cameraEntity?.attributes || {};
  const playbackActive = camAttrs.playback_active === true && !!camAttrs.playback_uri;

  if (!playbackActive || !camAttrs.playback_uri) {
    this._pushTraceDebug("playback", "warn", "playback_seek_skipped", "Playback seek skipped", {
      reason: "playback_not_active",
      direction: Number(direction || 1),
      playback_active: playbackActive,
      playback_uri_present: !!camAttrs.playback_uri,
    }, traceId, "frontend");
    return;
  }

  const presetSeconds = Number(state.preset || 1);
  const seconds = Number(direction || 1) * presetSeconds;
  const base = state.currentTime ? new Date(state.currentTime) : new Date();
  if (Number.isNaN(base.getTime())) {
    this._pushTraceDebug("playback", "warn", "playback_seek_skipped", "Playback seek skipped", {
      reason: "invalid_current_time",
      current_time: state.currentTime || "",
    }, traceId, "frontend");
    return;
  }

  base.setSeconds(base.getSeconds() + seconds);
  state.currentTime = this.formatDateTimeLocal(base);
  this._playbackSeekInFlight = true;
  this._lastPlaybackSeekAt = now;

  this._pushTraceDebug("playback", "info", "playback_seek_adjusted", direction < 0 ? "Playback seek moved backward" : "Playback seek moved forward", {
    direction: Number(direction || 1),
    seconds,
    requested_time: state.currentTime,
    snapshot: this._getDebugCameraSnapshot(),
  }, traceId, "frontend");

  if (state.paused) {
    this._playbackSeekInFlight = false;
    this.render();
    return;
  }

  await this.stopPlayback();
  window.setTimeout(() => {
    Promise.resolve(this.startPlayback(state.currentTime)).finally(() => {
      window.setTimeout(() => {
        this._playbackSeekInFlight = false;
      }, 1200);
    });
  }, 350);
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

  _storageCapabilities(storage = {}, dvr = {}, camAttrs = {}) {
    const storageInfoSupported = this.pickValue([storage, dvr, camAttrs], ["storage_info_supported"], null);
    const storageHddCapsSupported = this.pickValue([storage, dvr, camAttrs], ["storage_hdd_caps_supported"], null);
    const storagePresent = this.pickValue([storage, dvr, camAttrs], ["storage_present"], null);
    const playbackSupported = this.pickValue([camAttrs, storage, dvr], ["playback_supported"], null);
    return {
      storageInfoSupported: storageInfoSupported === null ? null : storageInfoSupported === true,
      storageHddCapsSupported: storageHddCapsSupported === null ? null : storageHddCapsSupported === true,
      storagePresent: storagePresent === null ? null : storagePresent === true,
      playbackSupported: playbackSupported === null ? null : playbackSupported === true,
    };
  }

  _canShowStoragePanel(storage = {}, dvr = {}, camAttrs = {}) {
    const caps = this._storageCapabilities(storage, dvr, camAttrs);
    if (caps.storagePresent === false) return false;
    if (caps.storageInfoSupported === false && caps.storageHddCapsSupported === false) return false;
    return this.config.show_storage_info !== false;
  }

  _canShowPlaybackControls(storage = {}, dvr = {}, camAttrs = {}) {
    const caps = this._storageCapabilities(storage, dvr, camAttrs);
    if (caps.playbackSupported !== null) return caps.playbackSupported;
    if (caps.storagePresent === false) return false;
    if (caps.storageInfoSupported === false && caps.storageHddCapsSupported === false) return false;
    return this.config.show_playback_panel !== false;
  }

  _buildCapabilityNotices(camAttrs = {}, storage = {}, dvr = {}) {
    const notices = [];
    const caps = this._storageCapabilities(storage, dvr, camAttrs);
    const ptzCapabilityMode = String(camAttrs.ptz_capability_mode || "").trim();
    const ptzImplementation = String(camAttrs.ptz_implementation || "").trim();
    const ptzUnsupportedReason = String(camAttrs.ptz_unsupported_reason || "").trim();
    const ptzSupported = camAttrs.ptz_supported === true;

    if (!ptzSupported && (ptzCapabilityMode || ptzImplementation || ptzUnsupportedReason)) {
      notices.push({
        icon: 'mdi:axis-arrow-lock',
        title: 'PTZ controls hidden',
        text: ptzUnsupportedReason || `This build only enables PTZ when the device exposes a compatible ${ptzImplementation || ptzCapabilityMode || 'supported'} mode.`,
      });
    }

    if (caps.playbackSupported === false) {
      let reason = 'Recording playback is unavailable on this device.';
      if (caps.storagePresent === false) reason = 'Recording playback is hidden because no recording storage is detected.';
      else if (caps.storageInfoSupported === false && caps.storageHddCapsSupported === false) reason = 'Recording playback is hidden because the NVR does not expose supported storage capability endpoints.';
      notices.push({
        icon: 'mdi:play-box-multiple-outline',
        title: 'Playback unavailable',
        text: reason,
      });
    }

    if (caps.storagePresent === false || (caps.storageInfoSupported === false && caps.storageHddCapsSupported === false)) {
      let reason = 'Storage details are hidden because the device does not expose supported HDD information.';
      if (caps.storagePresent === false) reason = 'Storage details are hidden because no HDD or recording media is detected on this device.';
      notices.push({
        icon: 'mdi:harddisk-remove',
        title: 'Storage panel hidden',
        text: reason,
      });
    }

    return notices;
  }

  renderCapabilityBanner(camAttrs = {}, storage = {}, dvr = {}) {
    const notices = this._buildCapabilityNotices(camAttrs, storage, dvr);
    if (!notices.length) return '';
    return `
      <div class="hik-capability-banner">
        ${notices.map((notice) => `
          <div class="hik-capability-banner-item">
            <ha-icon icon="${notice.icon}"></ha-icon>
            <div>
              <b>${this.escapeHtml(notice.title || 'Capability note')}</b>
              <span>${this.escapeHtml(notice.text || '')}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
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
      storageInfoSupported: attrs.storage_info_supported === true,
      storageHddCapsSupported: attrs.storage_hdd_caps_supported === true,
      storageExtraCapsSupported: attrs.storage_extra_caps_supported === true,
      storagePresent: attrs.storage_present === true,
      playbackSupported: attrs.playback_supported === true,
    };
  }


  _isWebRtcMode(streamMode, playbackUri = "") {
    const requestedMode = String(streamMode || this.config.video_mode || "rtsp_direct").toLowerCase();
    return Boolean(playbackUri) || requestedMode === "webrtc" || requestedMode === "webrtc_direct";
  }

  _getTalkMode() {
    return String(this.config.talk_mode || "hold").toLowerCase() === "toggle" ? "toggle" : "hold";
  }

  _clampMeter(value, multiplier = 1) {
    return Math.max(0, Math.min(1, Number(value || 0) * multiplier));
  }

  _setMeterVisual(kind, level, peak) {
    const safeKind = kind === "mic" ? "mic" : "speaker";
    const meter = this.querySelector(`.hik-audio-meter-fill[data-meter="${safeKind}"]`);
    const marker = this.querySelector(`.hik-audio-meter-peak[data-meter="${safeKind}"]`);
    const percent = `${Math.round(this._clampMeter(level) * 100)}%`;
    const peakPercent = `${Math.round(this._clampMeter(peak) * 100)}%`;
    if (meter) meter.style.setProperty("--hik-audio-level", percent);
    if (marker) marker.style.setProperty("--hik-audio-peak", peakPercent);
  }

  _sampleAnalyserPeak(analyser) {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i] - 128) / 128;
      if (value > peak) peak = value;
    }
    return peak;
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
    this._audioMeterPeak = 0;
    this._setMeterVisual("speaker", 0, 0);
  }

  _teardownTalkAudioGraph() {
    if (this._micMeterRaf) {
      cancelAnimationFrame(this._micMeterRaf);
      this._micMeterRaf = null;
    }
    if (this._talkAudioGraph?.source) {
      try { this._talkAudioGraph.source.disconnect(); } catch (err) {}
    }
    if (this._talkAudioGraph?.analyser) {
      try { this._talkAudioGraph.analyser.disconnect(); } catch (err) {}
    }
    if (this._talkAudioGraph?.context) {
      try { this._talkAudioGraph.context.close(); } catch (err) {}
    }
    this._talkAudioGraph = null;
    this._micMeterLevel = 0;
    this._micMeterPeak = 0;
    this._setMeterVisual("mic", 0, 0);
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


  _scheduleMediaAudioSync(delay = 0) {
    if (this._gridMode) return;
    const runner = () => this._syncMediaAudio();
    if (delay > 0) {
      setTimeout(runner, delay);
      return;
    }
    requestAnimationFrame(runner);
  }

  _observeMediaElement(host) {
    if (this._mediaSyncObserver) {
      try { this._mediaSyncObserver.disconnect(); } catch (err) {}
    }
    this._mediaSyncObserver = null;
    if (this._gridMode) return;
    if (!host || typeof MutationObserver === "undefined") return;

    const sync = () => this._syncMediaAudio();
    this._mediaSyncObserver = new MutationObserver(() => sync());
    try {
      this._mediaSyncObserver.observe(host, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcObject", "muted", "volume", "autoplay", "playsinline"]
      });
    } catch (err) {
      this._mediaSyncObserver = null;
      return;
    }

    this._scheduleMediaAudioSync(0);
    this._scheduleMediaAudioSync(150);
    this._scheduleMediaAudioSync(500);
    this._scheduleMediaAudioSync(1200);
  }


  _updateAudioMeter() {
    if (!this._audioGraph?.analyser) return;
    try {
      const livePeak = this._sampleAnalyserPeak(this._audioGraph.analyser);
      this._audioMeterLevel = this._clampMeter(livePeak, 2.2);
      this._audioMeterPeak = Math.max(this._audioMeterLevel, this._audioMeterPeak * 0.93);
      this._setMeterVisual("speaker", this._audioMeterLevel, this._audioMeterPeak);
    } catch (err) {
      this._audioMeterLevel = 0;
      this._audioMeterPeak = 0;
      this._setMeterVisual("speaker", 0, 0);
    }
    this._audioMeterRaf = requestAnimationFrame(() => this._updateAudioMeter());
  }

  _updateTalkAudioMeter() {
    if (!this._talkAudioGraph?.analyser) return;
    try {
      const livePeak = this._sampleAnalyserPeak(this._talkAudioGraph.analyser);
      this._micMeterLevel = this._clampMeter(livePeak, 2.4);
      this._micMeterPeak = Math.max(this._micMeterLevel, this._micMeterPeak * 0.9);
      this._setMeterVisual("mic", this._micMeterLevel, this._micMeterPeak);
    } catch (err) {
      this._micMeterLevel = 0;
      this._micMeterPeak = 0;
      this._setMeterVisual("mic", 0, 0);
    }
    this._micMeterRaf = requestAnimationFrame(() => this._updateTalkAudioMeter());
  }

  _ensureTalkAudioGraph(stream) {
    if (!stream?.getAudioTracks?.().length) {
      this._teardownTalkAudioGraph();
      return;
    }
    if (this._talkAudioGraph?.stream === stream) {
      this._syncTalkAudioGraphState();
      return;
    }
    this._teardownTalkAudioGraph();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const context = new AudioCtx();
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      const analyser = context.createAnalyser();
      const destination = context.createMediaStreamDestination();
      analyser.fftSize = 256;
      source.connect(gain);
      gain.connect(analyser);
      gain.connect(destination);
      this._talkAudioGraph = { context, source, gain, analyser, destination, stream };
      this._syncTalkAudioGraphState();
      if (context.state === "suspended") context.resume().catch(() => {});
      this._updateTalkAudioMeter();
    } catch (err) {
      this._teardownTalkAudioGraph();
    }
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
    this._pushAudioDebug("speaker_sync", {
      enabled: this._speakerEnabled,
      gain: Number(gainValue || 0),
      graphState: this._audioGraph?.context?.state || "none"
    });
    if (this._audioGraph.context?.state === "suspended" && this._speakerEnabled) {
      this._audioGraph.context.resume().catch(() => {});
    }
  }

  _syncMediaAudio() {
    if (this._gridMode) return;
    const runSync = () => {
      const host = this.querySelector("#hikvision-video-host");
      const mediaElement = this._findNestedMediaElement(host);
      this._pushAudioDebug?.("media_sync_probe", {
        hasHost: !!host,
        hasMedia: !!mediaElement,
        mode: String(this.config.video_mode || "").toLowerCase(),
        speakerEnabled: !!this._speakerEnabled
      });
      if (!mediaElement) return false;

      this._ensureAudioGraph(mediaElement).catch(() => {});
      this._applyAudioFallback(mediaElement);

      if (this._speakerEnabled) {
        try {
          mediaElement.muted = false;
          const playPromise = mediaElement.play?.();
          if (playPromise?.catch) playPromise.catch(() => {});
        } catch (err) {}
      }
      return true;
    };

    requestAnimationFrame(() => {
      if (runSync()) return;
      setTimeout(() => { runSync(); }, 250);
      setTimeout(() => { runSync(); }, 800);
    });
  }

  _setSpeakerEnabled(enabled) {
    this._speakerEnabled = Boolean(enabled);
    if (this._gridMode) {
      this.render();
      return;
    }
    const host = this.querySelector("#hikvision-video-host");
    const mediaElement = this._audioGraphElement || this._findNestedMediaElement(host);
    this._pushAudioDebug("speaker_toggle", {
      enabled: this._speakerEnabled,
      hasGraph: !!this._audioGraph,
      hasMedia: !!mediaElement,
      graphState: this._audioGraph?.context?.state || "none"
    });

    if (mediaElement) {
      this._ensureAudioGraph(mediaElement).catch(() => {});
      this._syncAudioGraphState(mediaElement);
      this._applyAudioFallback(mediaElement);

      if (this._speakerEnabled) {
        try {
          mediaElement.muted = false;
          const playPromise = mediaElement.play?.();
          if (playPromise?.catch) playPromise.catch(() => {});
        } catch (err) {}
      }
    } else {
      this._syncAudioGraphState();
      this._applyAudioFallback(null);
    }

    this.render();

    requestAnimationFrame(() => {
      const nextHost = this.querySelector("#hikvision-video-host");
      const nextMedia = this._audioGraphElement || this._findNestedMediaElement(nextHost);
      if (!nextMedia) return;
      this._ensureAudioGraph(nextMedia).catch(() => {});
      this._syncAudioGraphState(nextMedia);
      this._applyAudioFallback(nextMedia);

      if (this._speakerEnabled) {
        if (this._audioGraph?.context?.state === "suspended") {
          this._audioGraph.context.resume().catch(() => {});
        }
        try {
          nextMedia.muted = false;
          const playPromise = nextMedia.play?.();
          if (playPromise?.catch) playPromise.catch(() => {});
        } catch (err) {}
      }
    });

    setTimeout(() => {
      if (!this._speakerEnabled) return;
      const delayedHost = this.querySelector("#hikvision-video-host");
      const delayedMedia = this._audioGraphElement || this._findNestedMediaElement(delayedHost);
      if (!delayedMedia) return;
      this._ensureAudioGraph(delayedMedia).catch(() => {});
      this._syncAudioGraphState(delayedMedia);
      this._applyAudioFallback(delayedMedia);
      if (this._audioGraph?.context?.state === "suspended") {
        this._audioGraph.context.resume().catch(() => {});
      }
      try {
        delayedMedia.muted = false;
        const playPromise = delayedMedia.play?.();
        if (playPromise?.catch) playPromise.catch(() => {});
      } catch (err) {}
    }, 250);
  }

  _setVolume(value) {
    this._volume = Math.max(0, Math.min(100, Number(value) || 0));
    this._syncAudioGraphState();
    if (!this._gridMode) this._applyAudioFallback(this._audioGraphElement || this._findNestedMediaElement(this.querySelector("#hikvision-video-host")));
    const label = this.querySelector(".hik-volume-value");
    if (label) label.textContent = `${Math.round(this._volume)}%`;
  }

  _setAudioBoost(value) {
    this._audioBoost = Math.max(100, Math.min(300, Number(value) || 100));
    this._syncAudioGraphState();
    const label = this.querySelector(".hik-boost-value");
    if (label) label.textContent = `${(this._audioBoost / 100).toFixed(1)}×`;
  }

  _setMicVolume(value) {
    this._micVolume = Math.max(0, Math.min(200, Number(value) || 100));
    this._syncTalkAudioGraphState();
    const label = this.querySelector(".hik-mic-volume-value");
    if (label) label.textContent = `${Math.round(this._micVolume)}%`;
  }

  _syncTalkAudioGraphState() {
    if (!this._talkAudioGraph?.gain) return;
    this._talkAudioGraph.gain.gain.value = Math.max(0, Number(this._micVolume || 100) / 100);
  }

  async _setTalkActive(active) {
    const next = Boolean(active);

    if (!next) {
      if (!this._talkRequested && !this._talkActive) return;
      this._talkRequested = false;
      this._talkLatched = false;
      this._stopTalkbackDirect();
      this._syncAudioGraphState();
      if (!this._gridMode) this._applyAudioFallback(this._audioGraphElement || this._findNestedMediaElement(this.querySelector("#hikvision-video-host")));
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
    if (!this._gridMode) this._applyAudioFallback(this._audioGraphElement || this._findNestedMediaElement(this.querySelector("#hikvision-video-host")));
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
    const talkHandlers = talkMode === "toggle" ? "" : `data-hold-talk="true"`;
    const micState = !isWebRtc ? "Unavailable" : (this._talkRequested ? "Live" : "Ready");
    const speakerPercent = Math.round((this._audioMeterLevel || 0) * 100);
    const micPercent = Math.round((this._micMeterLevel || 0) * 100);
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

        <div class="hik-audio-console-grid">
          <div class="hik-audio-meter-card ${speakerActive ? "active" : ""}">
            <div class="hik-audio-meter-head">
              <div class="hik-audio-meter-title"><ha-icon icon="${speakerIcon}"></ha-icon><span>Speaker</span></div>
              <span class="hik-audio-meter-value">${speakerPercent}%</span>
            </div>
            <div class="hik-audio-meter-shell" title="Speaker level meter">
              <div class="hik-audio-meter-fill" data-meter="speaker" style="--hik-audio-level:${speakerPercent}%;"></div>
              <div class="hik-audio-meter-peak" data-meter="speaker" style="--hik-audio-peak:${Math.round((this._audioMeterPeak || 0) * 100)}%;"></div>
            </div>
            <div class="hik-audio-meter-caption">Output monitor · volume ${Math.round(this._volume)}% · boost ${(this._audioBoost / 100).toFixed(1)}×</div>
          </div>

          <div class="hik-audio-meter-card ${this._talkRequested ? "live" : ""} ${!isWebRtc || playbackActive ? "disabled" : ""}">
            <div class="hik-audio-meter-head">
              <div class="hik-audio-meter-title"><ha-icon icon="mdi:microphone${this._talkRequested ? '' : '-outline'}"></ha-icon><span>Mic</span></div>
              <span class="hik-audio-meter-value">${micPercent}%</span>
            </div>
            <div class="hik-audio-meter-shell" title="Microphone level meter">
              <div class="hik-audio-meter-fill mic" data-meter="mic" style="--hik-audio-level:${micPercent}%;"></div>
              <div class="hik-audio-meter-peak" data-meter="mic" style="--hik-audio-peak:${Math.round((this._micMeterPeak || 0) * 100)}%;"></div>
            </div>
            <div class="hik-audio-meter-caption">${playbackActive ? "Talk disabled during playback" : (isWebRtc ? `Push-to-talk · ${micState.toLowerCase()}` : "Talk available only in WebRTC mode")}</div>
          </div>

          <div class="hik-audio-controls-card">
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
          </div>

          <div class="hik-audio-controls-card">
            ${isWebRtc && !playbackActive ? `
              <button type="button" class="hik-btn hik-audio-btn hik-talk-btn ${this._talkRequested ? "live" : ""}" ${talkAttrs} ${talkHandlers} aria-pressed="${this._talkRequested ? "true" : "false"}">
                <ha-icon icon="mdi:microphone"></ha-icon>
                <span>${talkLabel}</span>
              </button>
              <div class="hik-audio-note compact">
                <ha-icon icon="mdi:information-outline"></ha-icon>
                <span>${muteDuringTalk ? "Speaker auto-mutes during talk to help prevent feedback." : "Speaker stays active while talking."} Talk mode: ${talkMode}.</span>
              </div>
            ` : `
              <div class="hik-audio-note fill">
                <ha-icon icon="mdi:information-outline"></ha-icon>
                <span>${playbackActive ? "Talk is disabled during playback." : "Microphone controls appear only in WebRTC mode."}</span>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  }

  renderVideo(cameraEntityId, rtspUrl, directRtspUrl, streamMode, playbackUri = "", playbackPaused = false) {
    if (this._gridMode) {
      if (this._videoCard || this._videoSignature) this._cleanupVideoCard();
      this._videoSignature = null;
      return;
    }
    const host = this.querySelector("#hikvision-video-host");
    if (!host) return;

    const requestedMode = String(streamMode || this.config.video_mode || "rtsp_direct").toLowerCase();
    const playbackMode = Boolean(playbackUri);
    const useSnapshot = !playbackMode && requestedMode === "snapshot";
    const preferredRtspUrl = playbackMode
      ? playbackUri
      : (requestedMode === "webrtc_direct" || requestedMode === "rtsp_direct"
          ? (directRtspUrl || rtspUrl)
          : (rtspUrl || directRtspUrl));
    const useWebRtc = playbackMode || (!useSnapshot && Boolean(preferredRtspUrl));
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
      this._setupWebRtcPtzBindings(this._videoCard, playbackMode);
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
          this._setupWebRtcPtzBindings(webrtcCard, playbackMode);
          this._pushDebug("video", "info", "webrtc_card_ready", "WebRTC card created successfully", { playback_mode: playbackMode, url: preferredRtspUrl || "" }, "frontend");
          this._observeMediaElement(host);
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
        this._observeMediaElement(host);
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

  _cleanupGridVideoCards() {
    if (this._gridFocusTransitionTimer) {
      clearTimeout(this._gridFocusTransitionTimer);
      this._gridFocusTransitionTimer = null;
    }
    this._gridPendingFocusChannel = null;
    if (!(this._gridVideoCards instanceof Map)) {
      this._gridVideoCards = new Map();
      return;
    }
    this._gridVideoCards.forEach((card) => {
      try {
        if (typeof card?.remove === "function") card.remove();
        else if (card?.parentNode) card.parentNode.removeChild(card);
      } catch (err) {}
    });
    this._gridVideoCards.clear();
  }

  _getMotionActiveChannels() {
    const active = [];
    for (const cam of this.cameras || []) {
      const refs = this.refsForChannel(cam.channel);
      const motionEntity = refs.motion ? this.getEntity(refs.motion) : null;
      if (motionEntity?.state === "on") active.push(String(cam.channel));
    }
    return active;
  }

  _getPriorityMotionChannel(activeChannels = []) {
    if (!Array.isArray(activeChannels) || !activeChannels.length) return "";
    return String(activeChannels[activeChannels.length - 1] || "");
  }

  _updateGridAudioFocus() {
    if (!(this._gridVideoCards instanceof Map)) return;
    this._gridVideoCards.forEach((card, channel) => {
      const media = this._findNestedMediaElement(card);
      if (!media) return;
      const isFocused = String(channel) === String(this._gridFocusChannel || "");
      try {
        media.muted = !isFocused || !this._speakerEnabled;
        media.volume = isFocused && this._speakerEnabled ? this._getVideoVolumeFraction() : 0;
        if (isFocused && this._speakerEnabled) {
          const playPromise = media.play?.();
          if (playPromise?.catch) playPromise.catch(() => {});
        }
      } catch (err) {}
    });
  }

  _resolveGridFocusChannel() {
    const now = Date.now();
    if (this._gridManualFocusUntil > now && this._gridFocusChannel != null) return String(this._gridFocusChannel);
    const active = this._getMotionActiveChannels();
    if (active.length) {
      const next = this._getPriorityMotionChannel(active);
      if (next && String(next) !== String(this._gridFocusChannel || "")) {
        this._gridPendingFocusChannel = String(next);
        if (!this._gridFocusTransitionTimer) {
          this._gridFocusTransitionTimer = setTimeout(() => {
            this._gridFocusChannel = String(this._gridPendingFocusChannel || this._gridFocusChannel || next);
            this._gridPendingFocusChannel = null;
            this._gridMotionFocusUntil = Date.now() + 12000;
            this._gridFocusTransitionTimer = null;
            this.render();
            setTimeout(() => this._updateGridAudioFocus(), 0);
          }, 1200);
        }
      } else if (next) {
        this._gridFocusChannel = String(next);
        this._gridMotionFocusUntil = now + 12000;
      }
      return String(this._gridFocusChannel || next || "");
    }
    if (this._gridFocusTransitionTimer || this._gridMotionFocusUntil > now) return String(this._gridFocusChannel || "");
    const selected = this.selectedCamera;
    return selected?.channel != null ? String(selected.channel) : "";
  }

  _renderGridView() {
    const cameras = this.cameras || [];
    const focusedChannel = this._resolveGridFocusChannel();
    const focusCam = cameras.find((cam) => String(cam.channel) === String(focusedChannel)) || cameras[0] || null;
    const secondary = cameras.filter((cam) => String(cam.channel) !== String(focusCam?.channel ?? ""));
    const renderTile = (gridCam, focused = false) => {
      const refs = this.refsForChannel(gridCam.channel);
      const motionEntity = refs.motion ? this.getEntity(refs.motion) : null;
      const onlineEntity = refs.online ? this.getEntity(refs.online) : null;
      const motionActive = motionEntity?.state === "on";
      const online = onlineEntity ? onlineEntity.state === "on" : true;
      return `
        <div class="hik-grid-tile ${focused ? "focused promoted" : "secondary"} ${motionActive ? "motion" : ""}" data-grid-focus="${this.escapeHtml(String(gridCam.channel))}" title="${this.escapeHtml(gridCam.name || `Camera ${gridCam.channel}`)}" role="button" tabindex="0">
          <div class="hik-grid-media-host" id="hik-grid-host-${this.escapeHtml(String(gridCam.channel))}"></div>
          <div class="hik-grid-tile-overlay">
            <span class="hik-video-badge live-state"><ha-icon icon="mdi:cctv"></ha-icon>${this.escapeHtml(gridCam.name || `Camera ${gridCam.channel}`)}</span>
            ${focused ? `<span class="hik-video-badge paused"><ha-icon icon="mdi:star-four-points-outline"></ha-icon>Focused</span>` : ""}
            ${(focused && this._gridManualFocusUntil > Date.now()) ? `<span class="hik-video-badge paused"><ha-icon icon="mdi:lock"></ha-icon>Locked</span>` : ""}
            ${motionActive ? `<span class="hik-video-badge recording"><ha-icon icon="mdi:motion-sensor"></ha-icon>Motion</span>` : ""}
            ${!online ? `<span class="hik-video-badge paused"><ha-icon icon="mdi:lan-disconnect"></ha-icon>Offline</span>` : ""}
          </div>
          <div class="hik-grid-tile-footer ${focused ? "focused" : ""}">
            <span>CH ${this.escapeHtml(String(gridCam.channel))}</span>
            <span>${focused ? "Primary view" : "Tap to focus"}</span>
          </div>
        </div>`;
    };
    return `
      <div class="hik-grid-view promoted" id="hik-grid-view">
        ${focusCam ? `<div class="hik-grid-primary">${renderTile(focusCam, true)}</div>` : ""}
        <div class="hik-grid-secondary-row">
          ${secondary.map((gridCam) => renderTile(gridCam, false)).join("")}
        </div>
      </div>`;
  }

  _mountGridStreams() {
    if (!this._gridMode || !this._hass) {
      this._cleanupGridVideoCards();
      return;
    }
    window.loadCardHelpers().then(async (helpers) => {
      const cameras = this.cameras || [];
      const keep = new Set();
      for (const gridCam of cameras) {
        const channel = String(gridCam.channel);
        keep.add(channel);
        const host = this.querySelector(`#hik-grid-host-${CSS.escape(channel)}`);
        if (!host) continue;
        const existing = this._gridVideoCards.get(channel);
        if (existing) {
          existing.hass = this._hass;
          if (existing.parentNode !== host) {
            host.innerHTML = "";
            host.appendChild(existing);
          }
          continue;
        }
        try {
          const card = await helpers.createCardElement({
            type: "picture-entity",
            entity: gridCam.camera_entity,
            camera_view: "live",
            show_name: false,
            show_state: false,
          });
          card.hass = this._hass;
          card.style.display = "block";
          card.style.width = "100%";
          card.style.height = "100%";
          host.innerHTML = "";
          host.appendChild(card);
          this._gridVideoCards.set(channel, card);
        } catch (err) {
          host.innerHTML = `<div class="hik-empty">Unable to load camera</div>`;
        }
      }
      Array.from(this._gridVideoCards.keys()).forEach((key) => {
        if (!keep.has(String(key))) {
          const card = this._gridVideoCards.get(key);
          try {
            if (typeof card?.remove === "function") card.remove();
            else if (card?.parentNode) card.parentNode.removeChild(card);
          } catch (err) {}
          this._gridVideoCards.delete(key);
        }
      });
      setTimeout(() => this._updateGridAudioFocus(), 120);
    }).catch(() => {});
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
    const storagePanelSupported = this._canShowStoragePanel(storage, dvr, camAttrs);
    const playbackPanelSupported = this._canShowPlaybackControls(storage, dvr, camAttrs);
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
    const ptzCapabilityMode = camAttrs.ptz_capability_mode || info.ptz_capability_mode || "-";
    const ptzImplementation = camAttrs.ptz_implementation || info.ptz_implementation || "-";
    const ptzUnsupportedReason = camAttrs.ptz_unsupported_reason || info.ptz_unsupported_reason || "";
    const streamMode = String(camAttrs.stream_mode || "rtsp_direct").toLowerCase();
    const videoMethod = camAttrs.video_method || (streamMode === "snapshot" ? "Snapshot" : streamMode === "webrtc_direct" ? "WebRTC Direct" : streamMode === "webrtc" ? "WebRTC" : streamMode === "rtsp_direct" ? "RTSP Direct" : "RTSP");
    const playbackState = this.syncPlaybackState(camAttrs);
    const playbackPresets = this.getPlaybackPresets();
    if (!playbackPresets.includes(Number(playbackState.preset))) playbackState.preset = playbackPresets[0] || 1;
    const playbackIndicator = this.formatPlaybackIndicatorState(camAttrs, playbackState);
    const playbackActive = playbackIndicator.playbackActive;
    const isWebRtc = String(streamMode || "").toLowerCase() === "webrtc_direct";
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
            ["PTZ capability", ptzCapabilityMode || "-"],
            ["PTZ implementation", ptzImplementation || "-"],
            ["PTZ unsupported reason", ptzUnsupportedReason || "-"],
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

    if (this.config.show_stream_mode_info === false && this._videoAccessoryPanel === "stream_mode") this._videoAccessoryPanel = "";
    if (!storagePanelSupported && this._videoAccessoryPanel === "storage") this._videoAccessoryPanel = "";
    if (!playbackPanelSupported) this._playbackOverlayVisible = false;
    if (this.config.debug?.enabled !== true) this._debugOverlayOpen = false;

    const streamModeAccessoryPanel = this.config.show_stream_mode_info !== false ? `
      <div class="hik-panel hik-info-card hik-video-accessory-panel">
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
          ["Muted UI", streamMode === "snapshot" ? "Managed by HA card" : "Yes"],
          ["Card helper", streamMode === "snapshot" ? "picture-entity" : "custom:webrtc-camera"],
          ["Preferred URL", streamMode === "webrtc_direct" || streamMode === "rtsp_direct" ? (directRtspUrl || "-") : (rtspUrl || directRtspUrl || "-")],
        ])}
      </div>
    ` : "";

    const storageAccessoryPanel = this.config.show_storage_info !== false ? `
      <div class="hik-panel hik-info-card hik-video-accessory-panel">
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
    ` : "";

    const videoAccessoryPanelContent = this._videoAccessoryPanel === "stream_mode"
      ? streamModeAccessoryPanel
      : this._videoAccessoryPanel === "storage"
        ? storageAccessoryPanel
        : "";

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
          .hik-expandable-panel { padding:0; overflow:hidden; }
          .hik-expandable-details { display:block; }
          .hik-expandable-summary { cursor:pointer; list-style:none; padding:14px; }
          .hik-expandable-summary::-webkit-details-marker { display:none; }
          .hik-expandable-body { padding:0 14px 14px; }
          .hik-expandable-details:not([open]) .hik-expandable-body { display:none; }
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
          .hik-motion-grid-overlay { grid-template-columns: minmax(0, 1fr); }
          .hik-webrtc-pad-wrap { min-height: 180px; }
          .hik-webrtc-stage { display:grid; gap:12px; align-content:start; }
          .hik-webrtc-note { display:grid; grid-template-columns:auto 1fr; gap:12px; align-items:start; padding:14px; border-radius:18px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.03); }
          .hik-webrtc-note ha-icon { width:22px; height:22px; color:var(--primary-color); }
          .hik-webrtc-note-title { font-weight:700; font-size:14px; }
          .hik-webrtc-note-copy { font-size:12px; color:var(--secondary-text-color); line-height:1.45; }
          .hik-webrtc-inline-actions { display:flex; justify-content:flex-start; }
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
          .hik-pad-fallback, .hik-rail.zoom.fallback { display:none !important; }
          .hik-overlay-primary-note { background:rgba(255,255,255,0.025); border-style:dashed; }
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
          .hik-info-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:14px; margin-top:14px; } .hik-video-accessory-wrap { margin-top:14px; } .hik-video-accessory-wrap > .hik-panel { margin:0; } .hik-video-accessory-panel { width:100%; }
          .hik-video-shell { position:relative; }
          .hik-merged-shell { display:grid; gap:14px; }
          .hik-video-block { --hik-ov-btn: clamp(34px, 4.2vw, 56px); --hik-ov-radius: clamp(12px, 1.2vw, 18px); --hik-ov-gap: clamp(6px, 0.8vw, 10px); --hik-ov-icon: clamp(14px, 1.7vw, 22px); position:relative; aspect-ratio:16 / 9; min-height:240px; overflow:hidden; border-radius:20px; background: radial-gradient(circle at top, rgba(255,255,255,0.06), rgba(0,0,0,0.94) 55%), #000; box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 18px 34px rgba(0,0,0,0.26); }          .hik-video-block.is-playback { box-shadow: inset 0 0 0 2px rgba(220, 36, 36, 0.85), inset 0 1px 0 rgba(255,255,255,0.04), 0 18px 34px rgba(0,0,0,0.26), 0 0 0 1px rgba(255,80,80,0.18); }
          #hikvision-video-host { width:100%; height:100%; display:block; }
          #hikvision-video-host > * { width:100%; height:100%; display:block; }
          .hik-video-ptz-overlay { position:absolute; inset:0; z-index:4; pointer-events:none; opacity:0; transform:scale(0.985); transition:opacity 180ms ease, transform 180ms ease; }
          .hik-video-block:hover .hik-video-ptz-overlay,
          .hik-video-block:focus-within .hik-video-ptz-overlay,
          .hik-video-ptz-overlay:focus-within { opacity:1; transform:scale(1); }
          .hik-video-ptz-overlay.is-disabled { opacity:0.68; }
          .hik-video-ptz-surface { position:absolute; inset:14px; pointer-events:none; }
          .hik-video-ptz-top { position:absolute; top:0; left:0; display:flex; gap:8px; }
          .hik-video-ptz-chip { min-height:30px; padding:0 12px; border-radius:999px; display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:700; color:#fff; background:rgba(12,16,22,0.42); border:1px solid rgba(255,255,255,0.14); backdrop-filter:blur(10px); box-shadow:0 10px 24px rgba(0,0,0,0.24); }
          .hik-video-ptz-chip.subtle { opacity:0.9; }
          .hik-video-ptz-chip ha-icon { --mdc-icon-size:14px; color:var(--hik-accent); }
          .hik-video-ptz-pad { position:absolute; left:16px; bottom:16px; display:grid; grid-template-columns:repeat(3,var(--hik-ov-btn)); gap:var(--hik-ov-gap); pointer-events:auto; }
          .hik-video-ptz-btn { position:relative; min-height:var(--hik-ov-btn); min-width:var(--hik-ov-btn); border:none; border-radius:var(--hik-ov-radius); cursor:pointer; display:grid; place-items:center; color:var(--primary-text-color); background:rgba(10,14,20,0.34); border:1px solid rgba(255,255,255,0.14); backdrop-filter:blur(12px) saturate(1.15); box-shadow:0 12px 26px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.08); transition:transform 120ms ease, box-shadow 150ms ease, background 150ms ease, border-color 150ms ease; }
          .hik-video-ptz-btn:hover:not(:disabled) { transform:translateY(-1px); background:rgba(14,20,28,0.48); box-shadow:0 16px 28px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.10), 0 0 0 1px rgba(255,255,255,0.05); }
          .hik-video-ptz-btn:active:not(:disabled) { transform:scale(0.94); background:rgba(255,255,255,0.14); }
          .hik-video-ptz-btn:disabled { opacity:0.42; cursor:not-allowed; box-shadow:none; }
          .hik-video-ptz-btn ha-icon { --mdc-icon-size:var(--hik-ov-icon); }
          .hik-video-ptz-btn.center { overflow:hidden; background:rgba(18,24,32,0.46); }
          .hik-video-ptz-center-core { position:absolute; inset:10px; border-radius:999px; background:radial-gradient(circle at 50% 45%, rgba(255,255,255,0.18), rgba(255,255,255,0.02) 65%); box-shadow:inset 0 0 0 1px rgba(255,255,255,0.08); }
          .hik-video-ptz-btn.center ha-icon { position:relative; color:var(--hik-accent); --mdc-icon-size:20px; }
          .hik-video-zoom-rail { position:absolute; right:16px; top:50%; transform:translateY(-50%); width:clamp(44px, 5vw, 58px); padding:clamp(6px, 0.8vw, 10px) clamp(6px, 0.7vw, 8px); border-radius:clamp(14px, 1.4vw, 20px); display:grid; gap:var(--hik-ov-gap); place-items:center; pointer-events:auto; background:rgba(10,14,20,0.30); border:1px solid rgba(255,255,255,0.12); backdrop-filter:blur(12px) saturate(1.15); box-shadow:0 12px 26px rgba(0,0,0,0.28); }
          .hik-video-zoom-btn { width:clamp(32px, 3.8vw, 42px); height:clamp(32px, 3.8vw, 42px); border:none; border-radius:clamp(10px, 1vw, 14px); cursor:pointer; display:grid; place-items:center; color:var(--primary-text-color); background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.10); transition:transform 120ms ease, background 150ms ease, box-shadow 150ms ease; }
          .hik-video-zoom-btn:hover:not(:disabled) { transform:translateY(-1px); background:rgba(255,255,255,0.12); box-shadow:0 8px 18px rgba(0,0,0,0.24); }
          .hik-video-zoom-btn:active:not(:disabled) { transform:scale(0.94); }
          .hik-video-zoom-btn:disabled { opacity:0.42; cursor:not-allowed; box-shadow:none; }
          .hik-video-zoom-btn ha-icon { --mdc-icon-size:clamp(14px, 1.5vw, 18px); color:var(--hik-accent); }
          .hik-video-zoom-track { width:6px; height:clamp(60px, 10vw, 88px); border-radius:999px; position:relative; background:rgba(255,255,255,0.10); overflow:hidden; }
          .hik-video-zoom-track span { position:absolute; left:0; right:0; top:18%; bottom:18%; border-radius:999px; background:linear-gradient(180deg, color-mix(in srgb, var(--hik-accent) 82%, #fff 8%), rgba(255,255,255,0.10)); opacity:0.9; }
          .hik-video-refocus-btn { position:absolute; left:16px; bottom:calc((var(--hik-ov-btn) * 3) + (var(--hik-ov-gap) * 3) + 18px); min-height:clamp(32px, 3.4vw, 38px); padding:0 clamp(10px, 1vw, 14px); border:none; border-radius:999px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; color:var(--primary-text-color); background:rgba(10,14,20,0.36); border:1px solid rgba(255,255,255,0.14); backdrop-filter:blur(12px) saturate(1.15); box-shadow:0 12px 26px rgba(0,0,0,0.28); pointer-events:auto; transition:transform 120ms ease, background 150ms ease, box-shadow 150ms ease; }
          .hik-video-refocus-btn:hover:not(:disabled) { transform:translateY(-1px); background:rgba(14,20,28,0.48); }
          .hik-video-refocus-btn:active:not(:disabled) { transform:scale(0.97); }
          .hik-video-refocus-btn:disabled { opacity:0.42; cursor:not-allowed; box-shadow:none; }
          .hik-video-refocus-btn ha-icon { --mdc-icon-size:16px; color:var(--hik-accent); }
          .hik-video-media-overlay { position:absolute; inset:14px 14px 14px 14px; z-index:4; pointer-events:none; }
          .hik-grid-view { position:absolute; inset:0; display:grid; grid-template-rows:minmax(0, 1fr) minmax(116px, 24%); gap:10px; padding:10px; background:rgba(0,0,0,0.18); }
          .hik-grid-view.promoted { grid-template-rows:minmax(0, 1fr) minmax(116px, 24%); }
          .hik-grid-primary { min-height:0; position:relative; }
          .hik-grid-primary .hik-grid-tile { height:100%; min-height:0; }
          .hik-grid-secondary-row { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; min-height:0; }
          .hik-grid-tile { position:relative; padding:0; margin:0; overflow:hidden; border-radius:18px; background:rgba(10,14,20,0.34); border:1px solid rgba(255,255,255,0.08); cursor:pointer; box-shadow:0 12px 26px rgba(0,0,0,0.24); min-height:120px; transition:transform 140ms ease, box-shadow 150ms ease, border-color 150ms ease; outline:none; }
          .hik-grid-tile:hover, .hik-grid-tile:focus-visible { transform:translateY(-1px); }
          .hik-grid-tile.promoted { transform:scale(1.002); }
          .hik-grid-tile.motion { animation:hikGridMotionPulse 1.5s ease-out infinite; }
          @keyframes hikGridMotionPulse {
            0% { box-shadow:0 0 0 0 rgba(255,80,80,0.38), 0 12px 26px rgba(0,0,0,0.24); }
            70% { box-shadow:0 0 0 12px rgba(255,80,80,0), 0 12px 26px rgba(0,0,0,0.24); }
            100% { box-shadow:0 0 0 0 rgba(255,80,80,0), 0 12px 26px rgba(0,0,0,0.24); }
          }
          .hik-grid-tile.promoted { min-height:0; height:100%; box-shadow:0 0 0 2px color-mix(in srgb, var(--hik-accent) 70%, white 10%), 0 16px 28px rgba(0,0,0,0.26); }
          .hik-grid-tile.secondary { min-height:120px; }
          .hik-grid-tile.focused { box-shadow:0 0 0 2px color-mix(in srgb, var(--hik-accent) 70%, white 10%), 0 12px 26px rgba(0,0,0,0.24); }
          .hik-grid-tile.motion { box-shadow:0 0 0 2px rgba(255,80,80,0.55), 0 12px 26px rgba(0,0,0,0.24); }
          .hik-grid-tile.promoted.motion { box-shadow:0 0 0 2px rgba(255,80,80,0.75), 0 16px 28px rgba(0,0,0,0.26); }
          .hik-grid-media-host { position:absolute; inset:0; display:block; }
          .hik-grid-media-host > * { width:100%; height:100%; display:block; }
          .hik-grid-media-host hui-image, .hik-grid-media-host ha-card, .hik-grid-media-host img, .hik-grid-media-host video, .hik-grid-media-host iframe { width:100% !important; height:100% !important; object-fit:cover; background:#000; }
          .hik-grid-tile-overlay { position:absolute; inset:8px 8px auto 8px; display:flex; gap:8px; flex-wrap:wrap; pointer-events:none; z-index:1; }
          .hik-grid-tile-footer { position:absolute; inset:auto 10px 10px 10px; z-index:1; display:flex; justify-content:space-between; gap:10px; align-items:center; padding:8px 10px; border-radius:12px; background:rgba(10,14,20,0.42); border:1px solid rgba(255,255,255,0.08); backdrop-filter:blur(10px); color:var(--primary-text-color); font-size:11px; font-weight:700; }
          .hik-grid-tile-footer.focused { font-size:12px; }
          .hik-video-media-topcenter { position:absolute; top:0; left:50%; transform:translateX(-50%); display:flex; gap:var(--hik-ov-gap); pointer-events:auto; align-items:center; justify-content:center; z-index:2; padding:0 8px; }          .hik-video-media-topright { position:absolute; top:0; right:0; display:flex; gap:var(--hik-ov-gap); pointer-events:auto; align-items:flex-start; flex-wrap:wrap; justify-content:flex-end; max-width:min(72%, 900px); z-index:2; }
          .hik-video-media-bottom { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); display:flex; gap:var(--hik-ov-gap); align-items:center; pointer-events:auto; flex-wrap:wrap; justify-content:center; }
          .hik-video-media-btn { min-width:clamp(34px, 3.8vw, 42px); height:clamp(34px, 3.8vw, 42px); border:none; border-radius:clamp(10px, 1vw, 14px); display:grid; place-items:center; cursor:pointer; color:var(--primary-text-color); background:rgba(10,14,20,0.38); border:1px solid rgba(255,255,255,0.14); backdrop-filter:blur(12px) saturate(1.15); box-shadow:0 12px 26px rgba(0,0,0,0.28); transition:transform 120ms ease, background 150ms ease, box-shadow 150ms ease; }          .hik-video-media-btn.is-active { background:rgba(120,16,16,0.50); border-color:rgba(255,80,80,0.34); box-shadow:0 0 0 1px rgba(255,80,80,0.14), 0 12px 26px rgba(0,0,0,0.28); }
          .hik-video-media-btn:hover:not(:disabled) { transform:translateY(-1px); background:rgba(14,20,28,0.48); }
          .hik-video-media-btn:active:not(:disabled) { transform:scale(0.95); }
          .hik-video-media-btn.live { box-shadow:0 0 0 1px rgba(255,80,80,0.45), 0 12px 26px rgba(0,0,0,0.28); background:rgba(80,16,16,0.46); }
          .hik-video-media-btn ha-icon { --mdc-icon-size:18px; color:var(--hik-accent); }
          .hik-video-audio-chip { min-height:clamp(34px, 3.8vw, 42px); padding:0 clamp(8px, 0.9vw, 12px) 0 clamp(8px, 0.8vw, 10px); border:none; border-radius:clamp(10px, 1vw, 14px); display:inline-flex; align-items:center; gap:clamp(6px, 0.8vw, 10px); cursor:pointer; color:var(--primary-text-color); background:rgba(10,14,20,0.38); border:1px solid rgba(255,255,255,0.14); backdrop-filter:blur(12px) saturate(1.15); box-shadow:0 12px 26px rgba(0,0,0,0.28); transition:transform 120ms ease, background 150ms ease, box-shadow 150ms ease, border-color 150ms ease; }
          .hik-video-audio-chip:hover:not(:disabled) { transform:translateY(-1px); background:rgba(14,20,28,0.48); }
          .hik-video-audio-chip:active:not(:disabled) { transform:scale(0.97); }
          .hik-video-audio-chip:disabled { opacity:0.45; cursor:not-allowed; box-shadow:none; }
          .hik-video-audio-chip.is-live { background:rgba(16,32,24,0.52); border-color:rgba(92, 214, 140, 0.34); box-shadow:0 0 0 1px rgba(92,214,140,0.16), 0 12px 26px rgba(0,0,0,0.28); }
          .hik-video-audio-chip-mic.is-live { background:rgba(52,20,24,0.56); border-color:rgba(255,110,110,0.34); box-shadow:0 0 0 1px rgba(255,110,110,0.16), 0 12px 26px rgba(0,0,0,0.28); }
          .hik-video-audio-icon { width:24px; height:24px; display:grid; place-items:center; }
          .hik-video-audio-icon ha-icon { --mdc-icon-size:18px; color:var(--hik-accent); }
          .hik-video-audio-meta { display:grid; gap:1px; min-width:0; text-align:left; }
          .hik-video-audio-label { font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.72; line-height:1; }
          .hik-video-audio-state { font-size:12px; font-weight:700; line-height:1.15; white-space:nowrap; }
          .hik-video-audio-waves { width:22px; height:18px; display:flex; align-items:flex-end; gap:2px; justify-content:center; }
          .hik-video-audio-waves i { width:4px; border-radius:999px; height:5px; background:rgba(255,255,255,0.34); transform-origin:center bottom; transition:background 120ms ease; }
          .hik-video-audio-chip.is-live .hik-video-audio-waves i:nth-child(1) { animation:hikAudioWave 0.9s ease-in-out infinite; }
          .hik-video-audio-chip.is-live .hik-video-audio-waves i:nth-child(2) { animation:hikAudioWave 0.9s ease-in-out 0.12s infinite; }
          .hik-video-audio-chip.is-live .hik-video-audio-waves i:nth-child(3) { animation:hikAudioWave 0.9s ease-in-out 0.24s infinite; }
          .hik-video-audio-chip.is-live .hik-video-audio-waves i { background:color-mix(in srgb, var(--hik-accent) 78%, white 14%); }
          @keyframes hikAudioWave {
            0%, 100% { height:5px; opacity:0.45; }
            50% { height:16px; opacity:1; }
          }
          .hik-video-mini-select { min-height:clamp(34px, 3.8vw, 42px); padding:clamp(4px, 0.6vw, 6px) clamp(8px, 0.8vw, 10px); border-radius:clamp(10px, 1vw, 14px); display:grid; gap:3px; background:rgba(10,14,20,0.38); border:1px solid rgba(255,255,255,0.14); backdrop-filter:blur(12px) saturate(1.15); box-shadow:0 12px 26px rgba(0,0,0,0.28); }          .hik-video-mini-select.wide { min-width:min(240px, 56vw); }
          .hik-video-mini-select span { font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.72; }
          .hik-video-mini-select select, .hik-video-mini-input { background:transparent; color:inherit; border:none; outline:none; font-size:12px; min-width:112px; }
          .hik-video-volume-rail { min-height:clamp(34px, 3.8vw, 42px); padding:0 clamp(8px, 0.8vw, 12px); border-radius:clamp(10px, 1vw, 14px); display:flex; align-items:center; gap:8px; background:rgba(10,14,20,0.38); border:1px solid rgba(255,255,255,0.14); backdrop-filter:blur(12px) saturate(1.15); box-shadow:0 12px 26px rgba(0,0,0,0.28); }          .hik-video-volume-rail.compact { min-width:160px; padding-right:10px; align-self:flex-start; }          .hik-overlay-slider-value { font-size:11px; font-weight:700; opacity:0.84; min-width:38px; text-align:right; }          .hik-video-playback-panel { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); width:min(92%, 520px); display:grid; gap:10px; padding:12px; border-radius:18px; pointer-events:auto; background:rgba(18,18,22,0.46); border:1px solid rgba(255,255,255,0.14); backdrop-filter:blur(14px) saturate(1.1); box-shadow:0 12px 26px rgba(0,0,0,0.32); }          .hik-video-playback-panel.is-recording { border-color:rgba(255,80,80,0.46); box-shadow:0 0 0 1px rgba(255,80,80,0.16), 0 12px 26px rgba(0,0,0,0.32); }          .hik-video-playback-head { display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap; }          .hik-video-playback-title { display:inline-flex; align-items:center; gap:8px; font-weight:700; }          .hik-video-playback-title ha-icon { --mdc-icon-size:16px; color:#ff6b6b; }          .hik-video-playback-state { font-size:12px; opacity:0.84; }          .hik-video-playback-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(110px, 0.45fr); gap:10px; }          .hik-video-playback-actions { display:flex; gap:var(--hik-ov-gap); justify-content:center; flex-wrap:wrap; }
          .hik-debug-terminal-overlay { position:absolute; inset:12px; z-index:12; pointer-events:none; }
          .hik-debug-terminal-overlay::before { content:""; position:absolute; inset:0; border-radius:18px; background:linear-gradient(180deg, rgba(0,0,0,0.08), rgba(0,0,0,0.24)); pointer-events:none; }
          .hik-debug-terminal-window { position:absolute; top:0; left:0; width:min(calc(100% - 12px), var(--hik-debug-overlay-width, 960px)); height:min(calc(100% - 12px), var(--hik-debug-overlay-height, 620px)); transform:translate(var(--hik-debug-overlay-x, 24px), var(--hik-debug-overlay-y, 24px)); display:grid; grid-template-rows:auto minmax(0, 1fr); border-radius:18px; overflow:hidden; pointer-events:auto; background:linear-gradient(180deg, rgba(8,12,16,0.985), rgba(10,14,20,0.97)); border:1px solid rgba(120,255,178,0.16); box-shadow:0 24px 64px rgba(0,0,0,0.58), 0 0 0 1px rgba(77,208,132,0.06); backdrop-filter:blur(14px) saturate(1.08); min-width:520px; min-height:320px; max-width:calc(100% - 12px); max-height:calc(100% - 12px); will-change:transform, width, height; }
          .hik-debug-terminal-window.is-moving, .hik-debug-terminal-window.is-resizing { user-select:none; }
          .hik-debug-terminal-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; background:linear-gradient(180deg, rgba(18,25,32,0.98), rgba(11,16,22,0.96)); border-bottom:1px solid rgba(120,255,178,0.12); cursor:move; touch-action:none; }
          .hik-debug-terminal-title { display:inline-flex; align-items:center; gap:10px; font-weight:700; letter-spacing:0.02em; }
          .hik-debug-terminal-title ha-icon { --mdc-icon-size:16px; color:#87f7b9; }
          .hik-debug-terminal-dot { width:10px; height:10px; border-radius:50%; display:inline-block; box-shadow:0 0 0 1px rgba(255,255,255,0.08) inset; }
          .hik-debug-terminal-dot.red { background:#ff5f57; }
          .hik-debug-terminal-dot.amber { background:#ffbd2e; }
          .hik-debug-terminal-dot.green { background:#28c840; }
          .hik-debug-terminal-actions { display:flex; align-items:center; gap:8px; }
          .hik-debug-terminal-body { min-height:0; overflow:auto; padding:12px; display:grid; gap:12px; background:rgba(5,8,12,0.22); }
          .hik-debug-resize-handle { position:absolute; right:0; bottom:0; width:24px; height:24px; border:none; background:transparent; cursor:nwse-resize; pointer-events:auto; }
          .hik-debug-resize-handle::before { content:""; position:absolute; right:6px; bottom:6px; width:12px; height:12px; border-right:2px solid rgba(135,247,185,0.68); border-bottom:2px solid rgba(135,247,185,0.68); opacity:0.9; }
          .hik-debug-warning-banner.is-terminal { background:rgba(80,180,120,0.06); border-color:rgba(120,255,178,0.12); }
          .hik-debug-overview.is-terminal { background:rgba(10,14,20,0.72); border:1px solid rgba(120,255,178,0.08); border-radius:14px; padding:12px; }
          .hik-debug-console-shell.is-terminal { background:rgba(6,10,14,0.74); border:1px solid rgba(120,255,178,0.1); box-shadow:none; }
          .hik-debug-toolbar.is-terminal { background:rgba(12,18,24,0.88); border-bottom:1px solid rgba(120,255,178,0.1); }
          .hik-debug-list-shell.is-terminal { min-height:260px; max-height:42vh; }
          .hik-debug-detail-pane.is-terminal { background:rgba(9,13,18,0.86); border-color:rgba(120,255,178,0.1); }
          .hik-video-volume-rail ha-icon { --mdc-icon-size:16px; color:var(--hik-accent); }
          .hik-video-volume-rail input { width:110px; }          .hik-video-volume-rail.compact input { width:86px; }
          .hik-debug-warning-banner { margin:12px 12px 0; padding:12px 14px; display:grid; grid-template-columns:auto 1fr; gap:10px; align-items:start; border-radius:14px; border:1px solid rgba(245,166,35,0.32); background:rgba(245,166,35,0.10); color:var(--primary-text-color); }
          .hik-capability-banner { margin:10px 0 0; display:grid; gap:8px; }
          .hik-capability-banner-item { padding:10px 12px; display:grid; grid-template-columns:auto 1fr; gap:10px; align-items:start; border-radius:14px; border:1px solid rgba(245,166,35,0.24); background:rgba(245,166,35,0.08); color:var(--primary-text-color); backdrop-filter: blur(10px); }
          .hik-capability-banner-item ha-icon { --mdc-icon-size:18px; color:#f5a623; margin-top:1px; }
          .hik-capability-banner-item b { display:block; font-size:12px; margin-bottom:2px; }
          .hik-capability-banner-item span { display:block; font-size:12px; opacity:0.88; line-height:1.4; }
          .hik-debug-warning-banner ha-icon { --mdc-icon-size:18px; color:#f5a623; margin-top:1px; }
          .hik-debug-warning-banner b { display:block; font-size:12px; margin-bottom:2px; }
          .hik-debug-warning-banner span { display:block; font-size:12px; opacity:0.85; line-height:1.4; }
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
          .hik-audio-panel { display:grid; gap:12px; margin-top:14px; padding:16px; border-radius:20px; border:1px solid color-mix(in srgb, var(--hik-accent) 12%, var(--divider-color)); background: linear-gradient(180deg, color-mix(in srgb, var(--card-background-color) 93%, var(--hik-accent) 7%), color-mix(in srgb, var(--card-background-color) 97%, #000 3%)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.04); }
          .hik-audio-head { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center; }
          .hik-audio-pills { display:flex; gap:8px; flex-wrap:wrap; }
          .hik-audio-console-grid { display:grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.05fr) minmax(220px, 0.9fr) minmax(220px, 0.9fr); gap:12px; align-items:stretch; }
          .hik-audio-meter-card, .hik-audio-controls-card { display:grid; gap:10px; padding:14px; border-radius:16px; border:1px solid color-mix(in srgb, var(--hik-accent) 10%, var(--divider-color)); background: color-mix(in srgb, var(--secondary-background-color) 92%, transparent); min-width:0; }
          .hik-audio-meter-card.active { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--success-color) 16%, transparent); }
          .hik-audio-meter-card.live { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--error-color) 16%, transparent); }
          .hik-audio-meter-card.disabled { opacity:0.74; }
          .hik-audio-meter-head { display:flex; justify-content:space-between; align-items:center; gap:10px; }
          .hik-audio-meter-title { display:flex; align-items:center; gap:8px; font-weight:700; }
          .hik-audio-meter-title ha-icon { --mdc-icon-size:18px; }
          .hik-audio-meter-value { font-size:12px; font-weight:800; color: var(--hik-accent); letter-spacing:0.02em; }
          .hik-audio-meter-shell { position:relative; min-height:14px; border-radius:999px; overflow:hidden; background: color-mix(in srgb, var(--secondary-background-color) 82%, #000 18%); box-shadow: inset 0 1px 2px rgba(0,0,0,0.24); }
          .hik-audio-meter-fill { position:absolute; inset:0 auto 0 0; width: var(--hik-audio-level, 0%); max-width:100%; background: linear-gradient(90deg, color-mix(in srgb, var(--success-color) 70%, #22c55e), color-mix(in srgb, var(--warning-color) 80%, #f59e0b), color-mix(in srgb, var(--error-color) 80%, #ef4444)); transition: width 90ms linear; }
          .hik-audio-meter-fill.mic { background: linear-gradient(90deg, color-mix(in srgb, var(--primary-color) 78%, #38bdf8), color-mix(in srgb, var(--warning-color) 74%, #f59e0b), color-mix(in srgb, var(--error-color) 82%, #ef4444)); }
          .hik-audio-meter-peak { position:absolute; inset:1px auto 1px 0; left: var(--hik-audio-peak, 0%); width:2px; border-radius:999px; background: rgba(255,255,255,0.92); box-shadow: 0 0 0 1px rgba(0,0,0,0.18); transform: translateX(-1px); transition: left 120ms linear; }
          .hik-audio-meter-caption { font-size:12px; opacity:0.74; }
          .hik-audio-btn { width:100%; justify-content:center; }
          .hik-talk-btn.live { background: color-mix(in srgb, var(--error-color) 20%, var(--card-background-color)); border-color: color-mix(in srgb, var(--error-color) 30%, transparent); animation: hikTalkPulse 1.4s ease-in-out infinite; }
          .hik-audio-slider { display:grid; gap:6px; min-width:0; }
          .hik-audio-slider span { display:flex; justify-content:space-between; gap:8px; font-size:12px; }
          .hik-audio-note { min-height:44px; display:flex; gap:8px; align-items:center; padding:0 12px; border-radius:12px; border:1px dashed color-mix(in srgb, var(--hik-accent) 16%, var(--divider-color)); }
          .hik-audio-note.compact { min-height:auto; padding:10px 12px; }
          .hik-audio-note.fill { height:100%; }
          .hik-debug-overview { display:grid; gap:12px; }
          .hik-debug-console-shell { margin-top:14px; border:1px solid rgba(255,255,255,0.08); border-radius:18px; background: color-mix(in srgb, var(--secondary-background-color) 88%, rgba(0,0,0,0.18)); overflow:hidden; }
          .hik-debug-dashboard { border:1px solid color-mix(in srgb, var(--hik-accent) 12%, var(--divider-color)); border-radius:24px; background:linear-gradient(180deg, color-mix(in srgb, var(--card-background-color) 95%, var(--hik-accent) 5%), color-mix(in srgb, var(--card-background-color) 90%, var(--hik-accent) 10%)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 20px 36px rgba(0,0,0,0.22); overflow:hidden; }
          .hik-debug-dashboard details { display:grid; gap:0; }
          .hik-debug-summary { cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px 18px 12px; background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.08)); }
          .hik-debug-summary::-webkit-details-marker { display:none; }
          .hik-debug-warning-banner { margin:0 14px 12px; padding:12px 14px; display:grid; grid-template-columns:auto 1fr; gap:10px; align-items:start; border-radius:16px; border:1px solid rgba(245,166,35,0.28); background:linear-gradient(180deg, rgba(245,166,35,0.12), rgba(245,166,35,0.08)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.04); color:var(--primary-text-color); }
          .hik-capability-banner { margin:10px 0 0; display:grid; gap:8px; }
          .hik-capability-banner-item { padding:10px 12px; display:grid; grid-template-columns:auto 1fr; gap:10px; align-items:start; border-radius:16px; border:1px solid rgba(245,166,35,0.24); background:linear-gradient(180deg, rgba(245,166,35,0.12), rgba(245,166,35,0.07)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.04); color:var(--primary-text-color); }
          .hik-capability-banner-item ha-icon { --mdc-icon-size:18px; color:#f5a623; margin-top:1px; }
          .hik-capability-banner-item b { display:block; font-size:12px; margin-bottom:2px; }
          .hik-capability-banner-item span { display:block; font-size:12px; opacity:0.88; line-height:1.4; }
          .hik-debug-warning-banner ha-icon { --mdc-icon-size:18px; color:#f5a623; margin-top:1px; }
          .hik-debug-warning-banner b { display:block; font-size:12px; margin-bottom:2px; }
          .hik-debug-warning-banner span { display:block; font-size:12px; opacity:0.85; line-height:1.4; }
          .hik-debug-overview { padding:0 14px 14px; display:grid; gap:12px; }
          .hik-debug-snapshot-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; }
          .hik-debug-overview .hik-pill { min-height:32px; padding:0 12px; border-radius:999px; background:rgba(12,16,22,0.28); border:1px solid rgba(255,255,255,0.08); backdrop-filter:blur(10px); box-shadow:0 8px 22px rgba(0,0,0,0.18); }
          .hik-debug-console-shell { margin:0 14px 14px; border-radius:20px; border:1px solid rgba(255,255,255,0.08); background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.10)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.03); overflow:hidden; }
          .hik-debug-toolbar { position:sticky; top:0; z-index:2; display:grid; gap:10px; padding:14px; margin:0; border-bottom:1px solid rgba(255,255,255,0.06); background:linear-gradient(180deg, rgba(12,16,22,0.72), rgba(12,16,22,0.52)); backdrop-filter:blur(14px) saturate(1.08); }
          .hik-debug-toolbar-head { display:flex; gap:10px; justify-content:space-between; align-items:center; flex-wrap:wrap; }
          .hik-debug-search-wrap { display:flex; align-items:center; gap:8px; min-width:260px; flex:1 1 320px; padding:0 14px; min-height:42px; border-radius:14px; border:1px solid rgba(255,255,255,0.10); background:rgba(10,14,20,0.36); backdrop-filter:blur(12px); box-shadow: inset 0 1px 0 rgba(255,255,255,0.04); }
          .hik-debug-search-wrap ha-icon { --mdc-icon-size:18px; opacity:0.72; color:var(--hik-accent); }
          .hik-debug-search { width:100%; border:0; outline:none; background:transparent; color:inherit; font-size:13px; }
          .hik-debug-list-shell { border-top:1px solid rgba(255,255,255,0.06); background:rgba(0,0,0,0.06); }
          .hik-debug-list-head { display:grid; grid-template-columns: 108px 110px 110px 1.2fr 2fr 84px; gap:10px; padding:12px 14px; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.7; border-bottom:1px solid rgba(255,255,255,0.06); background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.02)); position:sticky; top:0; z-index:1; backdrop-filter:blur(8px); }
          .hik-debug-feed { max-height:460px; overflow:auto; display:grid; gap:0; overscroll-behavior:contain; }
          .hik-debug-row { appearance:none; border:0; width:100%; margin:0; padding:11px 14px; display:grid; grid-template-columns: 108px 110px 110px 1.2fr 2fr 84px; gap:10px; text-align:left; color:inherit; background:linear-gradient(180deg, rgba(255,255,255,0.018), rgba(255,255,255,0.01)); border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer; transition:background 140ms ease, box-shadow 140ms ease, border-color 140ms ease, transform 140ms ease; }
          .hik-debug-row:hover { background:rgba(255,255,255,0.05); box-shadow: inset 0 1px 0 rgba(255,255,255,0.03); }
          .hik-debug-row.selected { background:linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.035)); box-shadow: inset 3px 0 0 color-mix(in srgb, var(--hik-accent) 72%, #ffffff 8%), 0 0 0 1px rgba(255,255,255,0.04); }
          .hik-debug-row.is-error { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--error-color) 60%, transparent); background:linear-gradient(180deg, rgba(255,70,70,0.05), rgba(255,255,255,0.01)); }
          .hik-debug-row.is-warn { box-shadow: inset 2px 0 0 rgba(245, 166, 35, 0.7); background:linear-gradient(180deg, rgba(245,166,35,0.05), rgba(255,255,255,0.01)); }
          .hik-debug-row.is-info { box-shadow: inset 2px 0 0 rgba(90, 169, 255, 0.55); }
          .hik-debug-row.is-debug { box-shadow: inset 2px 0 0 rgba(255,255,255,0.12); }
          .hik-debug-cell { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
          .hik-debug-event-cell { font-weight:700; }
          .hik-debug-message-cell { opacity:0.86; }
          .hik-debug-time-cell, .hik-debug-cam-cell { opacity:0.72; font-variant-numeric: tabular-nums; }
          .hik-debug-level-badge { display:inline-flex; align-items:center; justify-content:center; min-width:68px; padding:4px 8px; border-radius:999px; font-size:10px; letter-spacing:0.06em; font-weight:700; border:1px solid rgba(255,255,255,0.10); background:rgba(255,255,255,0.06); backdrop-filter:blur(8px); box-shadow:0 8px 20px rgba(0,0,0,0.14); }
          .hik-debug-level-badge.is-error { background:color-mix(in srgb, var(--error-color) 18%, rgba(10,14,20,0.26)); border-color:color-mix(in srgb, var(--error-color) 45%, transparent); }
          .hik-debug-level-badge.is-warn { background:rgba(245, 166, 35, 0.16); border-color:rgba(245, 166, 35, 0.28); }
          .hik-debug-level-badge.is-info { background:rgba(90, 169, 255, 0.14); border-color:rgba(90, 169, 255, 0.24); }
          .hik-debug-level-badge.is-debug { background:rgba(255,255,255,0.05); border-color:rgba(255,255,255,0.10); }
          .hik-debug-detail-pane { display:grid; gap:12px; padding:16px 14px 14px; border-top:1px solid rgba(255,255,255,0.06); background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.12)); }
          .hik-debug-detail-head { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap; }
          .hik-debug-detail-title { display:grid; gap:4px; }
          .hik-debug-detail-kicker { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.62; }
          .hik-debug-detail-name { font-size:15px; font-weight:700; }
          .hik-debug-classification-note { margin:8px 0 0; padding:10px 12px; border-radius:14px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.03); font-size:12px; line-height:1.45; color:rgba(255,255,255,0.88); }
          .hik-debug-detail-message { font-size:13px; line-height:1.45; opacity:0.9; padding:10px 12px; border-radius:14px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); }
          .hik-debug-nested-details > summary { cursor:pointer; font-size:12px; opacity:0.9; }
          .hik-debug-pre { margin:8px 0 0; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-size:11px; line-height:1.38; padding:12px; border-radius:14px; background:rgba(10,14,20,0.40); border:1px solid rgba(255,255,255,0.08); box-shadow: inset 0 1px 0 rgba(255,255,255,0.04); }
          .hik-debug-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:0; }
          .hik-debug-btn { border:1px solid rgba(255,255,255,0.12); background:rgba(10,14,20,0.34); color:inherit; border-radius:12px; padding:7px 12px; font-size:12px; cursor:pointer; backdrop-filter:blur(10px); box-shadow:0 8px 20px rgba(0,0,0,0.16); transition:transform 120ms ease, background 150ms ease, border-color 150ms ease; }
          .hik-debug-btn:hover { background:rgba(14,20,28,0.44); transform:translateY(-1px); }
          .hik-debug-btn.is-active { background:rgba(245,166,35,0.14); border-color:rgba(245,166,35,0.28); }
          .hik-debug-new-badge { display:inline-flex; align-items:center; min-height:32px; padding:0 11px; border-radius:999px; background:rgba(245,166,35,0.14); border:1px solid rgba(245,166,35,0.28); font-size:12px; backdrop-filter:blur(10px); }
          .hik-debug-textarea { width:100%; min-height:120px; max-height:200px; margin-top:0; padding:12px; border-radius:14px; border:1px solid rgba(255,255,255,0.10); background:rgba(10,14,20,0.42); color:inherit; font-size:11px; line-height:1.38; font-family:monospace; resize:vertical; box-sizing:border-box; white-space:pre; box-shadow: inset 0 1px 0 rgba(255,255,255,0.04); }
          .hik-debug-filter-group { display:flex; gap:8px; flex-wrap:wrap; }
          .hik-debug-chip { border:1px solid rgba(255,255,255,0.12); background:rgba(10,14,20,0.28); color:inherit; border-radius:999px; padding:6px 10px; font-size:12px; cursor:pointer; text-transform:capitalize; backdrop-filter:blur(8px); transition:background 150ms ease, border-color 150ms ease, transform 120ms ease; }
          .hik-debug-chip:hover { transform:translateY(-1px); background:rgba(14,20,28,0.38); }
          .hik-debug-chip.active { background:rgba(255,255,255,0.12); border-color:rgba(255,255,255,0.20); }
          @media (max-width: 980px) {
            .hik-debug-list-head, .hik-debug-row { grid-template-columns: 92px 92px 96px 1.15fr 1.6fr 72px; gap:8px; }
          }
          @media (max-width: 780px) {
            .hik-debug-list-head { display:none; }
            .hik-debug-feed { max-height:420px; }
            .hik-debug-row { grid-template-columns: 86px 92px 1fr 62px; grid-auto-rows:auto; }
            .hik-debug-row .hik-debug-cell:nth-child(3) { display:none; }
            .hik-debug-row .hik-debug-cell:nth-child(5) { grid-column: 1 / span 4; white-space:nowrap; }
          }
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
          @media (max-width: 1180px) {
            .hik-audio-console-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          }
          @media (max-width: 1080px) {
            .hik-grid, .hik-info-grid, .hik-stream-grid { grid-template-columns:1fr; }
          }
          @media (max-width: 700px) {
            .hik-titlebar, .hik-controls-head, .hik-console-topbar { flex-direction:column; align-items:stretch; }
            .hik-meta { grid-template-columns:1fr; }
            .hik-console-badges { width:100%; }
            .hik-motion-grid, .hik-lens-grid { grid-template-columns:1fr; }
            .hik-audio-console-grid { grid-template-columns:1fr; }
            .hik-pad { max-width:220px; }
            .hik-video-ptz-pad { left:12px; bottom:12px; }
            .hik-video-zoom-rail { right:12px; }
            .hik-video-refocus-btn { left:12px; }
            .hik-video-refocus-btn span { font-size:12px; }
            .hik-video-media-topcenter { top:6px; }
            .hik-grid-view { grid-template-rows:minmax(0, 1.4fr) auto; gap:8px; padding:8px; }
            .hik-grid-secondary-row { grid-template-columns:1fr 1fr; gap:8px; }
            .hik-grid-view.promoted { grid-template-rows:minmax(0, 1fr) minmax(96px, 28%); }
            .hik-video-media-topright { top:46px; gap:6px; max-width:calc(100% - 12px); }
            .hik-video-audio-state { font-size:11px; }
            .hik-video-volume-rail.compact { min-width:132px; }
            .hik-video-volume-rail.compact input { width:62px; }
            .hik-video-audio-waves { width:18px; }
            .hik-video-media-bottom { bottom:10px; gap:8px; width:calc(100% - 24px); }
            .hik-video-mini-select select, .hik-video-mini-input { min-width:88px; font-size:11px; }
            .hik-video-volume-rail input { width:74px; }
            .hik-video-playback-panel { width:calc(100% - 24px); bottom:10px; padding:10px; }
            .hik-video-playback-grid { grid-template-columns:1fr; } .hik-video-playback-ticker { flex-direction:column; align-items:flex-start; }
          }
        </style>
        <div class="hik-wrap">
          ${this.config.show_title !== false ? `
          <div class="hik-titlebar">
            <div>
              <div class="hik-title">${this.escapeHtml(this.config.title)}</div>
              <div class="hik-subtitle">Elite PTZ console with configurable sections, NVR overview, and storage summary</div>
            </div>
            <div class="hik-row">
              <div class="hik-pill ${online ? "good" : "warn"}">
                <ha-icon icon="${online ? "mdi:lan-connect" : "mdi:lan-disconnect"}"></ha-icon>
                ${online ? "Online" : "Offline"}
              </div>
              ${this.isDebugEnabled() ? `<div class="hik-pill warn"><ha-icon icon="mdi:bug-outline"></ha-icon>Debug impacts performance</div>` : ""}
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
                <div class="hik-video-block ${playbackActive ? "is-playback" : "is-live"}">
                  ${this._gridMode ? this._renderGridView() : `<div id="hikvision-video-host"></div>`}
                  ${(!this._gridMode && !playbackActive && !this._playbackOverlayVisible && ptz) ? `
                    <div class="hik-video-ptz-overlay ${online && !this._returningHome ? "is-ready" : "is-disabled"}" aria-label="PTZ video overlay">
                      <div class="hik-video-ptz-surface">
                        <div class="hik-video-ptz-top">
                          <div class="hik-video-ptz-chip">
                            <ha-icon icon="mdi:axis-arrow"></ha-icon>
                            <span>Live PTZ</span>
                          </div>
                          <div class="hik-video-ptz-chip subtle">
                            <ha-icon icon="mdi:speedometer"></ha-icon>
                            <span>${speed}</span>
                          </div>
                        </div>
                        <div class="hik-video-ptz-pad">
                          <div></div>
                          <button type="button" class="hik-video-ptz-btn ptz-btn up" data-pan="0" data-tilt="1" ${(!online || this._returningHome) ? 'disabled' : ''} aria-label="Move up" title="Move up">
                            <ha-icon icon="mdi:chevron-up"></ha-icon>
                          </button>
                          <div></div>
                          <button type="button" class="hik-video-ptz-btn ptz-btn left" data-pan="-1" data-tilt="0" ${(!online || this._returningHome) ? 'disabled' : ''} aria-label="Move left" title="Move left">
                            <ha-icon icon="mdi:chevron-left"></ha-icon>
                          </button>
                          <button type="button" class="hik-video-ptz-btn center" id="hik-center-overlay" ${(!online || this._returningHome) ? 'disabled' : ''} aria-label="Return home" title="Return home">
                            <span class="hik-video-ptz-center-core"></span>
                            <ha-icon icon="mdi:crosshairs-gps"></ha-icon>
                          </button>
                          <button type="button" class="hik-video-ptz-btn ptz-btn right" data-pan="1" data-tilt="0" ${(!online || this._returningHome) ? 'disabled' : ''} aria-label="Move right" title="Move right">
                            <ha-icon icon="mdi:chevron-right"></ha-icon>
                          </button>
                          <div></div>
                          <button type="button" class="hik-video-ptz-btn ptz-btn down" data-pan="0" data-tilt="-1" ${(!online || this._returningHome) ? 'disabled' : ''} aria-label="Move down" title="Move down">
                            <ha-icon icon="mdi:chevron-down"></ha-icon>
                          </button>
                          <div></div>
                        </div>
                        <div class="hik-video-zoom-rail">
                          <button type="button" class="hik-video-zoom-btn lens-btn" data-service="zoom" data-direction="1" ${(!online || this._returningHome) ? 'disabled' : ''} aria-label="Zoom in" title="Zoom in">
                            <ha-icon icon="mdi:magnify-plus"></ha-icon>
                          </button>
                          <div class="hik-video-zoom-track"><span></span></div>
                          <button type="button" class="hik-video-zoom-btn lens-btn" data-service="zoom" data-direction="-1" ${(!online || this._returningHome) ? 'disabled' : ''} aria-label="Zoom out" title="Zoom out">
                            <ha-icon icon="mdi:magnify-minus"></ha-icon>
                          </button>
                        </div>
                        <button type="button" class="hik-video-refocus-btn" id="hik-refocus-overlay" ${(!online || this._returningHome) ? 'disabled' : ''}>
                          <ha-icon icon="mdi:image-auto-adjust"></ha-icon>
                          <span>Refocus</span>
                        </button>
                      </div>
                    </div>
                  ` : ""}
                  ${this.renderPlaybackOverlay(playbackIndicator)}
                  <div class="hik-video-media-overlay">
                    <div class="hik-video-media-topcenter">
                      <button type="button" class="hik-video-media-btn" id="hik-overlay-cycle-prev" title="Previous camera" aria-label="Previous camera">
                        <ha-icon icon="mdi:chevron-left"></ha-icon>
                      </button>
                      <button type="button" class="hik-video-media-btn ${this._gridMode ? "is-active" : ""}" id="hik-overlay-grid-toggle" title="${this._gridMode ? "Exit multi-view" : "Multi-view grid"}" aria-label="${this._gridMode ? "Exit multi-view" : "Multi-view grid"}">
                        <ha-icon icon="mdi:view-grid"></ha-icon>
                      </button>
                      <button type="button" class="hik-video-media-btn" id="hik-overlay-cycle-next" title="Next camera" aria-label="Next camera">
                        <ha-icon icon="mdi:chevron-right"></ha-icon>
                      </button>
                    </div>
                    <div class="hik-video-media-topright">
                      ${(!this._gridMode && !playbackActive && !this._playbackOverlayVisible) ? `
                        <button type="button" class="hik-video-audio-chip ${this._speakerEnabled ? "is-live" : ""}" id="hik-speaker-toggle-overlay" title="${this._speakerEnabled ? "Mute speaker" : "Enable speaker"}" aria-label="${this._speakerEnabled ? "Mute speaker" : "Enable speaker"}" aria-pressed="${this._speakerEnabled ? "true" : "false"}">
                          <span class="hik-video-audio-icon">
                            <ha-icon icon="${this._speakerEnabled ? "mdi:volume-high" : "mdi:volume-off"}"></ha-icon>
                          </span>
                          <span class="hik-video-audio-meta">
                            <span class="hik-video-audio-label">Speaker</span>
                            <span class="hik-video-audio-state">${this._speakerEnabled ? "On" : "Off"}</span>
                          </span>
                          <span class="hik-video-audio-waves" aria-hidden="true"><i></i><i></i><i></i></span>
                        </button>
                        ${isWebRtc ? `
                          <button type="button" class="hik-video-audio-chip hik-video-audio-chip-mic ${this._talkHoldActive || this._talkRequested ? "is-live" : ""}" id="hik-talk-hold-overlay" title="Hold to talk" aria-label="Hold to talk" aria-pressed="${this._talkHoldActive || this._talkRequested ? "true" : "false"}">
                            <span class="hik-video-audio-icon">
                              <ha-icon icon="mdi:microphone"></ha-icon>
                            </span>
                            <span class="hik-video-audio-meta">
                              <span class="hik-video-audio-label">Mic</span>
                              <span class="hik-video-audio-state">${this._talkHoldActive || this._talkRequested ? "Live" : "Hold to talk"}</span>
                            </span>
                            <span class="hik-video-audio-waves" aria-hidden="true"><i></i><i></i><i></i></span>
                          </button>
                        ` : ""}
                        <label class="hik-video-volume-rail compact">
                          <ha-icon icon="mdi:volume-medium"></ha-icon>
                          <input id="hik-volume-overlay" type="range" min="0" max="100" step="1" value="${Math.round(this._volume)}">
                          <span class="hik-overlay-slider-value hik-volume-value">${Math.round(this._volume)}%</span>
                        </label>
                        <label class="hik-video-volume-rail compact">
                          <ha-icon icon="mdi:chart-bell-curve-cumulative"></ha-icon>
                          <input id="hik-audio-boost-overlay" type="range" min="100" max="300" step="10" value="${Math.round(this._audioBoost)}">
                          <span class="hik-overlay-slider-value hik-boost-value">${(this._audioBoost / 100).toFixed(1)}×</span>
                        </label>
                        ${isWebRtc ? `
                          <label class="hik-video-volume-rail compact">
                            <ha-icon icon="mdi:microphone-plus"></ha-icon>
                            <input id="hik-mic-volume-overlay" type="range" min="0" max="200" step="5" value="${Math.round(this._micVolume || 100)}">
                            <span class="hik-overlay-slider-value hik-mic-volume-value">${Math.round(this._micVolume || 100)}%</span>
                          </label>
                        ` : ""}
                        <button type="button" class="hik-video-media-btn" id="hik-overlay-fullscreen" title="Fullscreen" aria-label="Fullscreen">
                          <ha-icon icon="mdi:fullscreen"></ha-icon>
                        </button>
                      ` : ""}
                      ${this.config.show_stream_mode_info !== false ? `
                        <button type="button" class="hik-video-media-btn ${this._videoAccessoryPanel === "stream_mode" ? "is-active" : ""}" id="hik-overlay-stream-mode-toggle" title="${this._videoAccessoryPanel === "stream_mode" ? "Hide stream mode panel" : "Show stream mode panel"}" aria-label="${this._videoAccessoryPanel === "stream_mode" ? "Hide stream mode panel" : "Show stream mode panel"}">
                          <ha-icon icon="mdi:transit-connection-variant"></ha-icon>
                        </button>
                      ` : ""}
                      ${storagePanelSupported ? `
                        <button type="button" class="hik-video-media-btn ${this._videoAccessoryPanel === "storage" ? "is-active" : ""}" id="hik-overlay-storage-toggle" title="${this._videoAccessoryPanel === "storage" ? "Hide storage panel" : "Show storage panel"}" aria-label="${this._videoAccessoryPanel === "storage" ? "Hide storage panel" : "Show storage panel"}">
                          <ha-icon icon="mdi:harddisk"></ha-icon>
                        </button>
                      ` : ""}
                      ${this.config.debug?.enabled === true ? `
                        <button type="button" class="hik-video-media-btn ${this._debugOverlayOpen ? "is-active" : ""}" id="hik-overlay-debug-toggle" title="${this._debugOverlayOpen ? "Hide debug dashboard" : "Show debug dashboard"}" aria-label="${this._debugOverlayOpen ? "Hide debug dashboard" : "Show debug dashboard"}">
                          <ha-icon icon="mdi:bug-outline"></ha-icon>
                        </button>
                      ` : ""}
                      ${playbackPanelSupported ? `
                      <button type="button" class="hik-video-media-btn ${this._playbackOverlayVisible || playbackActive ? "is-active" : ""}" id="hik-playback-overlay-toggle" title="${this._playbackOverlayVisible || playbackActive ? "Hide playback controls" : "Show playback controls"}" aria-label="${this._playbackOverlayVisible || playbackActive ? "Hide playback controls" : "Show playback controls"}">
                        <ha-icon icon="mdi:play-box-multiple-outline"></ha-icon>
                      </button>
                      ` : ""}
                    </div>
                    ${this.renderCapabilityBanner(camAttrs, storage, dvr)}
                    ${(!this._gridMode && !playbackActive && !this._playbackOverlayVisible) ? `
                      <div class="hik-video-media-bottom">
                        <label class="hik-video-mini-select">
                          <span>Mode</span>
                          <select id="streamMode-overlay">
                            ${['snapshot','rtsp_direct','webrtc_direct'].map((mode) => `<option value="${mode}" ${String(streamMode || '').toLowerCase() === mode ? 'selected' : ''}>${mode.replace('_',' ')}</option>`).join("")}
                          </select>
                        </label>
                        <label class="hik-video-mini-select">
                          <span>Profile</span>
                          <select id="streamProfile-overlay">
                            ${["main","sub"].map((profile) => `<option value="${profile}" ${String(camAttrs.stream_profile || "").toLowerCase() === profile ? "selected" : ""}>${profile}</option>`).join("")}
                          </select>
                        </label>

                      </div>
                    ` : ""}
                    ${playbackPanelSupported && (this._playbackOverlayVisible || playbackActive) ? `
                      <div class="hik-video-playback-panel ${playbackActive ? "is-recording" : "is-standby"}">
                        <div class="hik-video-playback-head">
                          <div class="hik-video-playback-title">
                            <ha-icon icon="${playbackActive ? "mdi:record-rec" : "mdi:movie-open-play-outline"}"></ha-icon>
                            <span>${playbackActive ? "Playback mode" : "Playback controls"}</span>
                          </div>
                          <div class="hik-video-playback-state">${playbackActive ? (playbackState.paused ? "Paused" : "Playing recording") : "Ready to start recording playback"}</div>
                        </div>
                        <div class="hik-video-playback-ticker">
                          <span class="hik-video-playback-ticker-label">${playbackActive ? "Recording time" : "Selected time"}</span>
                          <span class="hik-video-playback-ticker-value">${this.escapeHtml(this._playbackTickerText() || playbackState.currentTime || "")}</span>
                        </div>
                        <div class="hik-video-playback-grid">
                          <label class="hik-video-mini-select wide">
                            <span>Start</span>
                            <input id="hik-playback-time-overlay" class="hik-video-mini-input" type="datetime-local" step="1" value="${this.escapeHtml(playbackState.currentTime || this.formatDateTimeLocal())}">
                          </label>
                          <label class="hik-video-mini-select">
                            <span>Jump</span>
                            <select id="hik-playback-preset-overlay">
                              ${playbackPresets.map((value) => `<option value="${value}" ${Number(playbackState.preset) === Number(value) ? "selected" : ""}>${this.escapeHtml(this.formatPlaybackPreset(value))}</option>`).join("")}
                            </select>
                          </label>
                          <label class="hik-video-mini-select">
                            <span>Rate</span>
                            <select id="hik-playback-rate-overlay">
                              ${[2,5,10,20].map((value) => `<option value="${value}" ${this._getPlaybackRate() === value ? "selected" : ""}>x${value}</option>`).join("")}
                            </select>
                          </label>
                          <button type="button" class="hik-video-audio-chip ${this._speakerEnabled ? "is-live" : ""}" id="hik-speaker-toggle-playback-overlay" title="${this._speakerEnabled ? "Mute speaker" : "Enable speaker"}" aria-label="${this._speakerEnabled ? "Mute speaker" : "Enable speaker"}" aria-pressed="${this._speakerEnabled ? "true" : "false"}">
                            <span class="hik-video-audio-icon">
                              <ha-icon icon="${this._speakerEnabled ? "mdi:volume-high" : "mdi:volume-off"}"></ha-icon>
                            </span>
                            <span class="hik-video-audio-meta">
                              <span class="hik-video-audio-label">Speaker</span>
                              <span class="hik-video-audio-state">${this._speakerEnabled ? "On" : "Off"}</span>
                            </span>
                            <span class="hik-video-audio-waves" aria-hidden="true"><i></i><i></i><i></i></span>
                          </button>
                          <button type="button" class="hik-video-media-btn" id="hik-overlay-fullscreen-playback" title="Fullscreen"><ha-icon icon="mdi:fullscreen"></ha-icon></button>
                        </div>
                        <div class="hik-video-playback-actions">
                          <button type="button" class="hik-video-media-btn" id="hik-playback-back-overlay" title="Back / hold to rewind"><ha-icon icon="mdi:rewind"></ha-icon></button>
                          ${playbackState.paused ? `<button type="button" class="hik-video-media-btn is-active" id="hik-playback-resume-overlay" title="Play"><ha-icon icon="mdi:play"></ha-icon></button>` : `<button type="button" class="hik-video-media-btn is-active" id="hik-playback-pause-overlay" title="Pause"><ha-icon icon="mdi:pause"></ha-icon></button>`}
                          <button type="button" class="hik-video-media-btn" id="hik-playback-forward-overlay" title="Forward / hold to fast forward"><ha-icon icon="mdi:fast-forward"></ha-icon></button>
                          <button type="button" class="hik-video-media-btn" id="hik-playback-start-overlay" title="Start playback"><ha-icon icon="mdi:calendar-play"></ha-icon></button>
                          <button type="button" class="hik-video-media-btn" id="hik-playback-stop-overlay" title="Return to live"><ha-icon icon="mdi:cctv-off"></ha-icon></button>
                        </div>
                      </div>
                    ` : ""}
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
                ${this.renderDebugOverlay(camAttrs)}
                ${this._renderVideoAccessoryPanel(videoAccessoryPanelContent)}
              </div>
            </div>

            ${this.renderControlsPanel({ online, ptz, speed, cameraAlarmBadges })}


                ${this.config.show_position_info !== false ? this.renderPTZIndicator() : ""}

                <div style="margin-top:16px;">
                  <div class="hik-sub"><ha-icon icon="mdi:bookmark-multiple-outline"></ha-icon>Presets</div>
                  <div class="hik-presets">
                    ${presets.length ? presets.map((p) => {
                      const pid = typeof p === "object" ? p.id : p;
                      const pname = typeof p === "object" ? (p.name || `Preset ${p.id}`) : `Preset ${p}`;
                      return `<button type="button" class="hik-btn hik-preset-btn preset-btn" data-preset="${pid}" ${ptz ? "" : "disabled"}>${this.escapeHtml(pname)}</div>`;
                    }).join("") : `<span class="hik-mini-note">No presets configured</span>`}
                  </div>
                </div>
            </div>
          </div>

          ${infoCards.length ? `<div class="hik-info-grid">${infoCards.join("")}</div>` : ""}
        </div>
      </ha-card>
    `;

    this._makePanelsExpandable();
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
    const debugOverlayToggle = this.querySelector("#hik-overlay-debug-toggle");
    if (debugOverlayToggle) {
      debugOverlayToggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleVideoAccessoryPanel("debug");
      });
    }
    this.querySelector("#hik-debug-overlay-minimize")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this._debugOverlayOpen) {
        this._toggleVideoAccessoryPanel("debug");
      }
    });
    this.querySelector("#hik-debug-overlay-reset")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._resetDebugOverlayRect();
    });
    if (this._debugOverlayOpen) {
      this._bindDebugOverlayInteractions();
      if (!this._debugOverlayDrag && !this._debugOverlayResize) {
        const clamped = this._clampDebugOverlayRect(this._debugOverlayRect);
        if (JSON.stringify(clamped) !== JSON.stringify(this._debugOverlayRect)) {
          this._setDebugOverlayRect(clamped, { persist: true, rerender: false });
          const overlay = this.querySelector('.hik-debug-terminal-window');
          if (overlay) {
            overlay.style.setProperty('--hik-debug-overlay-x', `${Math.round(clamped.x)}px`);
            overlay.style.setProperty('--hik-debug-overlay-y', `${Math.round(clamped.y)}px`);
            overlay.style.setProperty('--hik-debug-overlay-width', `${Math.round(clamped.width)}px`);
            overlay.style.setProperty('--hik-debug-overlay-height', `${Math.round(clamped.height)}px`);
          }
        }
      }
    }

    const streamModeOverlayToggle = this.querySelector("#hik-overlay-stream-mode-toggle");
    if (streamModeOverlayToggle) {
      streamModeOverlayToggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleVideoAccessoryPanel("stream_mode");
      });
    }

    const storageOverlayToggle = this.querySelector("#hik-overlay-storage-toggle");
    if (storageOverlayToggle) {
      storageOverlayToggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleVideoAccessoryPanel("storage");
      });
    }

    const streamModeSelect = this.querySelector("#streamMode");
    const streamModeOverlay = this.querySelector("#streamMode-overlay");
    const applyStreamMode = (value) => {
      this._hass.callService("ha_hikvision_bridge", "set_stream_mode", {
        entity_id: refs.camera,
        mode: value,
      });
    };
    if (streamModeSelect && refs.camera) {
      streamModeSelect.addEventListener("change", (e) => applyStreamMode(e.target.value));
    }
    if (streamModeOverlay && refs.camera) {
      streamModeOverlay.addEventListener("change", (e) => applyStreamMode(e.target.value));
    }

    const streamProfileSelect = this.querySelector("#streamProfile");
    const streamProfileOverlay = this.querySelector("#streamProfile-overlay");
    const applyStreamProfile = (value) => {
      this._hass.callService("ha_hikvision_bridge", "set_stream_profile", {
        entity_id: refs.camera,
        profile: value,
      });
    };
    if (streamProfileSelect && refs.camera) {
      streamProfileSelect.addEventListener("change", (e) => applyStreamProfile(e.target.value));
    }
    if (streamProfileOverlay && refs.camera) {
      streamProfileOverlay.addEventListener("change", (e) => applyStreamProfile(e.target.value));
    }

    this.querySelector("#hik-speaker-toggle")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      this._setSpeakerEnabled(!this._speakerEnabled);
    });
    this.querySelector("#hik-speaker-toggle-overlay")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._setSpeakerEnabled(!this._speakerEnabled);
    });
    this.querySelector("#hik-speaker-toggle-playback-overlay")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._setSpeakerEnabled(!this._speakerEnabled);
    });
    this.querySelector("#hik-overlay-fullscreen")?.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); this._toggleFullscreenVideo(); });
    this.querySelector("#hik-overlay-fullscreen-playback")?.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); this._toggleFullscreenVideo(); });
    this.querySelector("#hik-volume")?.addEventListener("input", (ev) => this._setVolume(ev.target.value));
    this.querySelector("#hik-volume-overlay")?.addEventListener("input", (ev) => this._setVolume(ev.target.value));
    this.querySelector("#hik-audio-boost")?.addEventListener("input", (ev) => this._setAudioBoost(ev.target.value));
    this.querySelector("#hik-audio-boost-overlay")?.addEventListener("input", (ev) => this._setAudioBoost(ev.target.value));
    this.querySelector("#hik-mic-volume-overlay")?.addEventListener("input", (ev) => this._setMicVolume(ev.target.value));

    const holdTalkBtn = this.querySelector("#hik-talk-hold");
    if (holdTalkBtn) this._bindHoldTalkButton(holdTalkBtn);
    this.querySelector("#hik-talk-toggle")?.addEventListener("click", (ev) => this._handleTalkToggle(ev));
    const holdTalkOverlayBtn = this.querySelector("#hik-talk-hold-overlay");
    if (holdTalkOverlayBtn) this._bindHoldTalkButton(holdTalkOverlayBtn);
    const bindOverlayCycle = (selector, delta) => {
      const btn = this.querySelector(selector);
      if (!btn) return;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const cams = this.cameras || [];
        if (!cams.length) return;
        const currentIndex = Math.max(0, Math.min(Number(this.selected || 0), cams.length - 1));
        const nextIndex = (currentIndex + delta + cams.length) % cams.length;
        this.selectCamera(nextIndex);
      });
    };
    bindOverlayCycle("#hik-overlay-cycle-prev", -1);
    bindOverlayCycle("#hik-overlay-cycle-next", 1);
    this.querySelector("#hik-overlay-grid-toggle")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._gridMode = !this._gridMode;
      if (!this._gridMode) {
        this._cleanupGridVideoCards();
      }
      this.render();
    });
    this.querySelectorAll("[data-grid-focus]").forEach((btn) => {
      const focusHandler = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const channel = ev.currentTarget?.getAttribute("data-grid-focus") || "";
        const cams = this.cameras || [];
        const idx = cams.findIndex((item) => String(item.channel) === String(channel));
        if (idx >= 0) {
          this.selected = idx;
          this._gridFocusChannel = String(channel);
          this._gridPendingFocusChannel = null;
          if (this._gridFocusTransitionTimer) {
            clearTimeout(this._gridFocusTransitionTimer);
            this._gridFocusTransitionTimer = null;
          }
          this._gridManualFocusUntil = Date.now() + 45000;
          this.render();
          setTimeout(() => this._updateGridAudioFocus(), 0);
        }
      };
      btn.addEventListener("click", focusHandler);
      btn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") focusHandler(ev);
      });
    });
    if (this._gridMode) {
      window.setTimeout(() => this._mountGridStreams(), 0);
    } else {
      this._cleanupGridVideoCards();
    }

    const toggleControls = () => {
      this._controlsVisible = !this._controlsVisible;
      this.render();
    };
    this.querySelector("#hik-playback-overlay-toggle")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      this._playbackOverlayVisible = !this._playbackOverlayVisible;
      this.render();
    });

    this.querySelectorAll(".hik-video-ptz-overlay .ptz-btn").forEach((btn) => {
      const pan = Number(btn.dataset.pan);
      const tilt = Number(btn.dataset.tilt);
      const source = "overlay";
      const start = (ev) => { ev.preventDefault(); this.startMove(pan, tilt, { source }); };
      const stop = () => this.stopMove({ source });
      btn.addEventListener("mousedown", start);
      btn.addEventListener("mouseup", stop);
      btn.addEventListener("mouseleave", stop);
      btn.addEventListener("touchstart", start, { passive: false });
      btn.addEventListener("touchend", stop);
      btn.addEventListener("touchcancel", stop);
    });

    this.querySelector("#hik-center-overlay")?.addEventListener("click", () => this.handleCenter());
    this.querySelectorAll(".lens-btn[data-service]").forEach((btn) => btn.addEventListener("click", () => this.callLens(btn.dataset.service, Number(btn.dataset.direction || 0), { source: btn.closest(".hik-video-ptz-overlay") ? "overlay" : "panel" })));
    this.querySelector("#hik-refocus-overlay")?.addEventListener("click", () => this.handleRefocus());
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
    this.querySelectorAll("details[data-expandable-key]").forEach((details) => {
      details.addEventListener("toggle", () => {
        this._setPanelOpenState(details.getAttribute("data-expandable-key"), details.open === true);
      });
    });
    this.querySelectorAll("[data-debug-filter]").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const target = ev.currentTarget;
      this._toggleDebugFilter(target?.getAttribute("data-debug-filter"), target?.getAttribute("data-debug-value"));
    }));
    this.querySelector("[data-debug-search]")?.addEventListener("input", (ev) => {
      this._debugSearchQuery = ev.currentTarget?.value || "";
      this.render();
    });
    this.querySelectorAll("[data-debug-select]").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._debugSelectedKey = ev.currentTarget?.getAttribute("data-debug-select") || "";
      this.render();
    }));
    this.querySelectorAll("[data-debug-entry-action]").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const container = ev.currentTarget.closest(".hik-debug-detail-pane");
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
      if (action === "copy-last-ptz-trace") {
        const trace = this._getLastTraceForCategory("ptz") || this._getLastTraceForCategory("webrtc");
        const traceText = trace.length ? trace.map((entry) => this.formatDebugEntryText(entry)).join("\n\n") : "No PTZ trace entries available.";
        this.copyDebugText(traceText);
      }
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
    this.querySelector("#hik-playback-start-overlay")?.addEventListener("click", () => this.startPlayback());
    this.querySelector("#hik-playback-stop-overlay")?.addEventListener("click", () => { this.stopPlayback(); this._playbackOverlayVisible = false; this.render(); });
    this.querySelector("#hik-playback-pause-overlay")?.addEventListener("click", () => this.pausePlayback());
    this.querySelector("#hik-playback-resume-overlay")?.addEventListener("click", () => this.resumePlayback());
    this._bindPlaybackSeekHold(this.querySelector("#hik-playback-back-overlay"), -1);
    this._bindPlaybackSeekHold(this.querySelector("#hik-playback-forward-overlay"), 1);
    this.querySelector("#hik-playback-time-overlay")?.addEventListener("change", (ev) => {
      const state = this.getPlaybackState();
      state.currentTime = ev.target.value;
    });
    this.querySelector("#hik-playback-preset-overlay")?.addEventListener("change", (ev) => {
      const state = this.getPlaybackState();
      state.preset = Number(ev.target.value || 1);
    });
    this.querySelector("#hik-playback-rate-overlay")?.addEventListener("change", (ev) => {
      this._setPlaybackRate(ev.target.value);
    });
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


/* current-ui-overlay-patch: top-center camera nav + top-right audio cluster applied on 1.2.7 */

/* grid-motion-focus phase1 patch applied on 1.2.7 */

/* grid-motion-focus phase2 promoted layout applied on 1.2.7 */

/* grid focus layout bugfix applied on 1.2.7 */

/* grid focus stability + audio sync suppression applied on 1.2.7 */

/* phase3 premium grid intelligence applied on 1.2.7 */

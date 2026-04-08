DOMAIN = "ha_hikvision_bridge"

CONF_HOST = "host"
CONF_PORT = "port"
CONF_USERNAME = "username"
CONF_PASSWORD = "password"
CONF_USE_HTTPS = "use_https"
CONF_VERIFY_SSL = "verify_ssl"
CONF_PTZ_CONTROL_PATH = "ptz_control_path"

DEFAULT_PORT_HTTP = 80
DEFAULT_PORT_HTTPS = 443
DEFAULT_RTSP_PORT = 554
DEFAULT_VERIFY_SSL = False
DEFAULT_USE_HTTPS = True
DEFAULT_PTZ_CONTROL_PATH = "direct"
PTZ_CONTROL_PATH_AUTO = "auto"
PTZ_CONTROL_PATH_DIRECT = "direct"
PTZ_CONTROL_PATH_PROXY = "proxy"
PTZ_CONTROL_PATH_OPTIONS = (
    PTZ_CONTROL_PATH_AUTO,
    PTZ_CONTROL_PATH_DIRECT,
    PTZ_CONTROL_PATH_PROXY,
)
DEFAULT_DEBUG_CATEGORIES = (
    "playback",
    "isapi",
    "websocket",
    "stream",
    "alarm",
    "ptz",
    "audio",
)

PLATFORMS = ["sensor", "binary_sensor", "camera"]
SERVICE_PTZ = "ptz"
SERVICE_GOTO_PRESET = "goto_preset"
SERVICE_FOCUS = "focus"
SERVICE_IRIS = "iris"
SERVICE_RETURN_HOME = "ptz_return_to_center"
SERVICE_ZOOM = "zoom"
SERVICE_SET_STREAM_MODE = "set_stream_mode"
SERVICE_SET_STREAM_PROFILE = "set_stream_profile"
SERVICE_PLAYBACK_SEEK = "playback_seek"
SERVICE_PLAYBACK_STOP = "playback_stop"
SERVICE_AUDIO_ENABLE = "audio_enable"
SERVICE_AUDIO_DISABLE = "audio_disable"
SERVICE_AUDIO_RECALIBRATE = "audio_recalibrate"
SERVICE_AUDIO_CAPTURE_CLIP = "audio_capture_clip"
SERVICE_AUDIO_ENABLE_CLASSIFIER = "audio_enable_classifier"
SERVICE_AUDIO_DISABLE_CLASSIFIER = "audio_disable_classifier"
SERVICE_AUDIO_SET_THRESHOLD = "audio_set_threshold"
SERVICE_AUDIO_INGEST_SAMPLES = "audio_ingest_samples"
SERVICE_AUDIO_START_STREAM = "audio_start_stream"
SERVICE_AUDIO_STOP_STREAM = "audio_stop_stream"
SERVICE_AUDIO_APPLY_CALIBRATION = "audio_apply_calibration"

STREAM_MODE_WEBRTC = "webrtc"
STREAM_MODE_RTSP = "rtsp"
STREAM_MODE_RTSP_DIRECT = "rtsp_direct"
STREAM_MODE_WEBRTC_DIRECT = "webrtc_direct"
STREAM_MODE_SNAPSHOT = "snapshot"
DEFAULT_STREAM_MODE = STREAM_MODE_RTSP_DIRECT

STREAM_PROFILE_MAIN = "main"
STREAM_PROFILE_SUB = "sub"
DEFAULT_STREAM_PROFILE = STREAM_PROFILE_SUB
STREAM_PROFILE_OPTIONS = (STREAM_PROFILE_MAIN, STREAM_PROFILE_SUB)


CONF_DEBUG_ENABLED = "debug_enabled"
CONF_DEBUG_CATEGORIES = "debug_categories"

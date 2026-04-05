# Services

This page documents the Home Assistant services registered by the integration.

!!! note
    The backend registers services under both the current domain (`ha_hikvision_bridge`) and a legacy domain for compatibility with older installs.

## PTZ

### `ha_hikvision_bridge.ptz`
Move a PTZ camera using momentary control.

```yaml
service: ha_hikvision_bridge.ptz
data:
  channel: "1"
  pan: 60
  tilt: 0
  duration: 500
```

Fields:

- `channel` — required
- `pan` — optional, integer, default `0`
- `tilt` — optional, integer, default `0`
- `duration` — optional, integer, default `500`
- `entry_id` — optional

## Preset recall

### `ha_hikvision_bridge.goto_preset`
```yaml
service: ha_hikvision_bridge.goto_preset
data:
  channel: "1"
  preset: 1
```

Fields:

- `channel` — required
- `preset` — required integer
- `entry_id` — optional

## Focus

### `ha_hikvision_bridge.focus`
```yaml
service: ha_hikvision_bridge.focus
data:
  channel: "1"
  direction: 1
  speed: 60
  duration: 500
```

## Iris

### `ha_hikvision_bridge.iris`
```yaml
service: ha_hikvision_bridge.iris
data:
  channel: "1"
  direction: 1
  speed: 60
  duration: 500
```

## Zoom

### `ha_hikvision_bridge.zoom`
```yaml
service: ha_hikvision_bridge.zoom
data:
  channel: "1"
  direction: 1
  speed: 50
  duration: 500
```

## PTZ return to center

### `ha_hikvision_bridge.ptz_return_to_center`
```yaml
service: ha_hikvision_bridge.ptz_return_to_center
data:
  channel: "1"
  state:
    pan: 2
    tilt: -1
    zoom: 0
  speed: 50
  duration: 350
  step_delay: 150
```

This service expects caller-supplied relative PTZ state and applies correction steps back toward the desired home position.

## Stream mode selection

### `ha_hikvision_bridge.set_stream_mode`
```yaml
service: ha_hikvision_bridge.set_stream_mode
data:
  entity_id: camera.front_yard
  mode: webrtc
```

## Stream profile selection

### `ha_hikvision_bridge.set_stream_profile`
```yaml
service: ha_hikvision_bridge.set_stream_profile
data:
  entity_id: camera.front_yard
  profile: main
```

## Playback seek

### `ha_hikvision_bridge.playback_seek`
```yaml
service: ha_hikvision_bridge.playback_seek
data:
  entity_id: camera.front_yard
  timestamp: "2026-04-01T14:05:00"
```

Notes:

- the timestamp is passed as a string
- the backend searches around the requested time
- if no recording is found, the entity stores an error state

## Playback stop

### `ha_hikvision_bridge.playback_stop`
```yaml
service: ha_hikvision_bridge.playback_stop
data:
  entity_id: camera.front_yard
```

## Practical notes

- service success still depends on the target device actually supporting the requested action
- on multi-recorder installs, `entry_id` can help target the right coordinator for channel-based services

# 🧠 Documentation Home

!!! note
    `ha-hikvision-bridge` is a local-first backend integration. It controls devices, exposes state, and orchestrates stream-related behavior. It does not process or transcode video.

## What this integration is

This project connects Hikvision DVRs, NVRs, and cameras to Home Assistant using ISAPI. It combines:

- coordinator-driven polling and shared state
- alarm stream ingestion for near-real-time event updates
- Home Assistant services for PTZ, presets, optics, stream mode, and playback lookup
- websocket helpers for signed stream URLs and debug events

## What it is not

- not a VMS
- not a replacement for go2rtc
- not a recording indexer
- not a cloud service

## Documentation map

### Getting started
- [Installation](installation.md)
- [Configuration](configuration.md)

### Features
- [Streaming](streaming.md)
- [Playback](playback.md)
- [PTZ](ptz.md)

### Reference
- [Services](services.md)
- [Entities](entities.md)

### Advanced
- [Architecture](architecture.md)
- [Troubleshooting](troubleshooting.md)

## Suggested first read order

1. Installation
2. Configuration
3. Playback
4. Troubleshooting

## Screenshot placeholders

Use these filenames when you add screenshots later:

- `images/setup-config-flow.png`
- `images/device-overview-entities.png`
- `images/camera-live-view.png`
- `images/playback-active-session.png`
- `images/ptz-controls-panel.png`
- `images/debug-dashboard-events.png`

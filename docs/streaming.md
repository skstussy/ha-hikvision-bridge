# Streaming

## Overview

The backend does **not** render video. It manages stream-related state, mode selection, and URL/signing helpers that a frontend can consume.

## Supported stream modes

The current constants define these modes:

- `webrtc`
- `rtsp`
- `rtsp_direct`
- `webrtc_direct`
- `snapshot`

The default stream mode constant is currently `rtsp_direct`.

## Stream profiles

The backend tracks two logical profiles:

- `main`
- `sub`

Per-camera stream sensors expose details such as:

- selected profile
- available stream profiles
- stream IDs
- codec
- resolution
- bitrate mode
- RTSP URLs
- audio flags

## WebRTC integration path

The websocket module provides commands that sign stream URLs for Home Assistant frontend use. This is what enables a companion dashboard/card to request an authorized stream path without embedding the raw route directly.

!!! note
    This integration helps orchestrate WebRTC access, but it still depends on your overall Home Assistant/go2rtc environment to actually deliver the media pipeline.

## Snapshot mode

Snapshot is supported as a stream mode option in the backend constants and entity behavior. Whether it is useful in practice depends on the frontend and device path being used.

## What this page should make clear

- the backend chooses and exposes stream state
- the frontend decides how to present it
- media transport success still depends on your real stream infrastructure

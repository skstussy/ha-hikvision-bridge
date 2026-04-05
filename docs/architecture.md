# Architecture

## Core design

The backend follows a coordinator-centric Home Assistant pattern.

### Main components

#### Coordinator
The coordinator is the shared state owner. It handles:

- initial refresh
- periodic polling
- camera and NVR data aggregation
- stream/profile state tracking
- alarm state updates
- debug event collection

#### Controller / ISAPI logic
The controller is responsible for device-side actions and request flows such as:

- PTZ commands
- preset recall
- zoom / focus / iris actions
- playback search requests
- stream and device metadata retrieval

#### Camera entities
Camera entities are playback-aware and stream-mode-aware. They are the bridge between coordinator data and frontend consumption.

#### Sensor and binary sensor entities
These expose parsed device state to Home Assistant.

#### Websocket handlers
The websocket module adds:

- signed WebRTC URL helpers
- debug event retrieval
- debug event subscription

## Data flow

```text
Hikvision device
   ↓
ISAPI client / controller
   ↓
Coordinator shared state
   ↓
Entities and services
```

## Event flow

```text
Alarm stream
   ↓
Coordinator alarm state
   ↓
Binary sensor updates
```

## Playback flow

```text
playback_seek service
   ↓
coordinator search_playback_uri()
   ↓
controller recording search
   ↓
playbackURI returned
   ↓
camera entity playback state updated
```

## Boundaries of responsibility

This integration does:

- control Hikvision features through ISAPI
- expose device state to Home Assistant
- track stream and playback-related state
- provide websocket helpers for frontend consumers

This integration does not:

- transcode video
- act as a standalone media server
- maintain a local recording catalog
- guarantee uniform behavior across every Hikvision firmware family

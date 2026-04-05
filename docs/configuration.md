# Configuration

## Config flow inputs

The config flow is built around the following connection settings:

- **host**
- **port**
- **username**
- **password**
- **use HTTPS**
- **verify SSL**

These values map directly to the backend transport configuration used by the ISAPI client and controller.

## Default behavior

The backend defaults are geared toward recorder-style deployments:

- HTTPS is enabled by default
- SSL verification defaults to disabled
- RTSP defaults remain recorder-friendly

## What the backend assumes

Some parts of the current implementation are still assumption-based rather than fully discovered at runtime.

### Channel handling
The integration uses camera/channel data from coordinator refreshes, but some logic still assumes recorder-style numbering and a bounded channel set.

### Playback track mapping
Playback searches map channels to **main-stream track IDs** (`101`, `201`, `301`, etc.). This is intentional in the current implementation and matches many NVR recording layouts where the sub-stream is not recorded.

### Stream profiles
The backend tracks stream profile selection per camera and exposes profile-aware stream sensor attributes. The default stream profile constant is set to `sub`, while playback logic still relies on main-stream mapping for recording lookups.

## Security notes

!!! warning
    The active ISAPI client path uses Basic Auth. Credentials may also be present in generated RTSP-style URLs depending on your stream path configuration.

## After configuration

Once connected, the coordinator populates shared state used by:

- camera entities
- camera info sensors
- camera stream sensors
- NVR system/storage sensors
- alarm and health binary sensors

## Debug-related behavior

If your UI consumes the debug websocket APIs, the backend can also stream structured debug events for playback, stream, websocket, PTZ, alarm, and ISAPI categories.

# Troubleshooting

## 1. Setup succeeds but entities are missing

Check the following:

- the device is reachable from Home Assistant
- the credentials are correct
- ISAPI access is available on the specific recorder/camera path you are targeting
- your hardware actually exposes the relevant feature set

## 2. PTZ does not move

Possible causes:

- PTZ is not actually supported on that channel
- PTZ only works through a proxy path on that recorder
- frontend controls are sending the wrong channel/state assumptions
- the camera reports support inconsistently

## 3. Playback lookup returns nothing

Check:

- recordings really exist for that time
- the requested time is correct
- the recorder stores recordings on the main stream, not the sub-stream

!!! warning
    The current backend maps playback lookups to main-stream recorder-style track IDs.

## 4. Playback lookup works but playback does not render

Separate the problem into two layers:

### Lookup layer
- did the backend return a playback URI?
- did the camera entity enter playback state?
- was an error stored?

### Rendering layer
- can your frontend/card consume the returned playback URI?
- is your stream path compatible with the selected playback mode?

## 5. WebRTC problems

Check your broader pipeline:

- Home Assistant stream setup
- go2rtc availability and config
- websocket URL signing flow in the frontend

## 6. Alarm sensors do not change

Possible causes:

- alarm stream connection failed
- the recorder is not emitting the event type you expect
- your model/firmware names the event differently

## 7. Useful debug workflow

When diagnosing issues, gather:

- Home Assistant logs
- backend debug dashboard output
- the service call used
- the target channel/entity ID
- whether the issue is live view, playback lookup, rendering, or PTZ

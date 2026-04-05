# Entities

The integration creates entities across three Home Assistant platforms:

- `camera`
- `sensor`
- `binary_sensor`

## Camera entities

A camera entity is created for each discovered camera/channel.

The camera entity is the main control and playback-aware object. It handles:

- live-view stream behavior
- selected stream mode
- selected stream profile
- playback URI state
- playback active state
- playback errors

## Camera sensors

### Camera Info
The **Info** sensor exposes camera metadata such as:

- channel number
- IP address and management port
- username/proxy details if known from device data
- model / serial / firmware
- PTZ support flags
- RTSP URLs and stream IDs

### Camera Stream
The **Stream** sensor exposes stream metadata such as:

- selected profile
- available profiles
- stream ID and stream name
- codec
- resolution
- frame-rate-related fields
- RTSP and direct RTSP URLs
- audio flags where available

## NVR sensors

### NVR System Info
This sensor exposes recorder-level information including:

- model / serial / firmware
- boot time
- online status
- alarm stream state
- active alarm count
- disk summary fields

### NVR Storage Info
This sensor summarizes:

- disk mode
- work mode
- disk count
- healthy / failed disk counts
- total / used / free capacity
- raw HDD list payload

### HDD sensors
A separate HDD sensor is created for each disk discovered in storage data.

## Binary sensors

### Recorder-level
- NVR Online
- Alarm Stream Connected
- Disk Full
- Disk Error
- Alarm Input sensors for each discovered alarm input

### Camera-level
- Online
- PTZ Supported
- Motion Alarm
- Video Loss Alarm
- Intrusion Alarm
- Line Crossing Alarm
- Tamper Alarm

## Important variability note

!!! warning
    The exact entity set depends on the device model, recorder topology, firmware behavior, and what the coordinator can successfully retrieve from the device.

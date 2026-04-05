# PTZ and Lens Control

## Supported service surface

The backend exposes services for:

- pan / tilt movement
- preset recall
- zoom
- focus
- iris
- return-to-home correction

## PTZ service model

The `ptz` service is momentary. You provide a channel plus pan/tilt values and a duration. The backend sends the movement and then stops after the requested duration.

## Presets

Preset recall is exposed through `goto_preset`.

## Zoom, focus, and iris

These are each exposed as their own services with:

- `channel`
- `direction`
- `speed`
- `duration`

## Return to center / home behavior

`ptz_return_to_center` is not magic auto-calibration. It uses tracked relative PTZ counters supplied in the service payload and applies correction steps using the configured speed, duration, and inter-step delay.

!!! note
    This is a pragmatic correction flow, not a true absolute-positioning model.

## Hardware realities

!!! warning
    PTZ support reported by a Hikvision device does not always match real-world behavior. Some systems expose partial support, proxy-only support, or inconsistent capability information.

## Binary sensor support

The integration also creates a per-camera **PTZ Supported** binary sensor to reflect the backend's current understanding of PTZ availability.

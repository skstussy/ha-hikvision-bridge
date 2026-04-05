# Playback

## Overview

Playback is implemented as a **search-and-start** flow rather than a native scrubber.

A Home Assistant service call asks the backend to search for recordings near a requested timestamp. If the device returns a matching clip, the backend stores the returned `playbackURI` on the camera entity and marks playback as active.

## Playback service flow

```text
User action or automation
   ↓
ha_hikvision_bridge.playback_seek
   ↓
Coordinator search for playback URI
   ↓
ISAPI recording search request
   ↓
Device returns playbackURI
   ↓
Camera entity enters playback state
```

## ISAPI search route

The controller uses:

```text
POST /ISAPI/ContentMgmt/search
```

The request is time-window based, and the current implementation searches around the requested timestamp rather than relying on a permanent local recording index.

## Current track mapping behavior

!!! warning
    Playback currently maps the requested channel to a main-stream track ID using recorder-style numbering (`101`, `201`, `301`, etc.).

This is important because many Hikvision recorder setups only retain recordings on the main stream.

## Entity-side playback state

When playback is started, the camera entity stores playback-related state such as:

- playback active flag
- playback URI
- requested time
- playback error, if any
- clip start time
- clip end time

## Stopping playback

`ha_hikvision_bridge.playback_stop` clears the active playback state and returns the entity to live-view behavior.

## What playback does not currently do

- no recording index cache
- no sub-stream playback selection
- no native continuous scrub timeline inside the backend
- no guarantee that every recorder firmware returns clips in exactly the same XML structure

## Operational guidance

!!! tip
    If playback lookup succeeds but playback does not actually render in your UI, separate the problem into two parts: recording lookup vs. frontend playback/rendering.

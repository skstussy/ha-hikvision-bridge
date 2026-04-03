ptz:
  name: PTZ Move
  description: Move the PTZ camera using momentary control.
  fields:
    channel:
      name: Channel
      description: DVR PTZ channel number
      required: true
      example: 1
    pan:
      name: Pan
      description: Pan speed or direction value
      required: false
      example: 60
    tilt:
      name: Tilt
      description: Tilt speed or direction value
      required: false
      example: 0
    duration:
      name: Duration
      description: Movement duration in milliseconds
      required: false
      example: 500

goto_preset:
  name: Go to preset
  description: Move the PTZ camera to a preset.
  fields:
    channel:
      name: Channel
      description: DVR PTZ channel number
      required: true
      example: 1
    preset:
      name: Preset
      description: Preset number
      required: true
      example: 1

focus:
  name: Focus
  description: Adjust focus using the InputProxy focus endpoint.
  fields:
    channel:
      name: Channel
      description: Camera channel number
      required: true
      example: 1
    direction:
      name: Direction
      description: Use 1 for focus up or -1 for focus down
      required: false
      example: 1
    speed:
      name: Speed
      description: Focus value from 1 to 100
      required: false
      example: 60
    duration:
      name: Duration
      description: Focus drive duration in milliseconds before sending a stop command
      required: false
      example: 350

iris:
  name: Iris
  description: Adjust iris using the InputProxy iris endpoint.
  fields:
    channel:
      name: Channel
      description: Camera channel number
      required: true
      example: 1
    direction:
      name: Direction
      description: Use 1 for iris up or -1 for iris down
      required: false
      example: 1
    speed:
      name: Speed
      description: Iris value from 1 to 100
      required: false
      example: 60
    duration:
      name: Duration
      description: Iris drive duration in milliseconds before sending a stop command
      required: false
      example: 350

ptz_return_to_center:
  name: Return PTZ to home
  description: Move the camera back toward its user-defined home position using tracked relative PTZ counters.
  fields:
    channel:
      name: Channel
      description: DVR PTZ channel number
      required: true
      example: 1
    state:
      name: State
      description: Relative PTZ counter state such as pan, tilt, and zoom
      required: true
      example:
        pan: 2
        tilt: -1
        zoom: 0
    speed:
      name: Speed
      description: PTZ move speed used for each correction step
      required: false
      example: 60
    duration:
      name: Duration
      description: Duration in milliseconds for each correction step
      required: false
      example: 350
    step_delay:
      name: Step delay
      description: Delay in milliseconds between correction steps
      required: false
      example: 150

zoom:
  name: Zoom
  description: Zoom the selected PTZ camera in or out using momentary control.
  fields:
    channel:
      name: Channel
      description: DVR PTZ channel number
      required: true
      example: 1
    direction:
      name: Direction
      description: Use 1 for zoom in and -1 for zoom out
      required: false
      example: 1
    speed:
      name: Speed
      description: Zoom speed from 1 to 100
      required: false
      example: 50
    duration:
      name: Duration
      description: Zoom duration in milliseconds
      required: false
      example: 350

playback_seek:
  name: Start recording playback
  description: Search NVR recordings and start playback from a requested date and time.
  fields:
    entity_id:
      name: Camera entity
      description: Camera entity that should be used for the playback search
      required: true
      example: camera.front_yard
    timestamp:
      name: Requested time
      description: Local date and time to start playback from, for example 2026-04-01T14:05:00
      required: true
      example: "2026-04-01T14:05:00"

playback_stop:
  name: Stop recording playback
  description: Stop recording playback and return the card to the live view.
  fields:
    entity_id:
      name: Camera entity
      description: Camera entity currently in playback mode
      required: true
      example: camera.front_yard

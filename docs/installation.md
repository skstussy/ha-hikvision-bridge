# Installation

## Requirements

- A working Home Assistant installation
- A Hikvision DVR, NVR, or camera reachable from Home Assistant
- ISAPI access enabled on the target device or recorder proxy path
- Valid credentials

!!! note
    This integration is local-first. There is no cloud dependency in the backend design.

## Option 1 — HACS

1. Open **HACS**
2. Go to **Integrations**
3. Open **Custom repositories**
4. Add:

```text
https://github.com/skstussy/ha-hikvision-bridge
```

5. Choose category **Integration**
6. Install the repository
7. Restart Home Assistant

## Option 2 — Manual install

Copy the integration directory into your Home Assistant config:

```text
custom_components/ha_hikvision_bridge/
```

Then restart Home Assistant.

## Add the integration

After restart:

1. Go to **Settings → Devices & Services**
2. Click **Add Integration**
3. Search for **HA Hikvision Bridge**
4. Enter the required connection details

## What happens on first setup

On a successful setup, the integration:

1. creates the coordinator
2. performs the first refresh
3. registers services
4. starts the alarm stream worker
5. forwards setup to the `sensor`, `binary_sensor`, and `camera` platforms

## Known setup realities

!!! warning
    Entity availability depends on what your hardware and firmware actually expose. Different Hikvision models can behave differently even when the API family looks similar.

!!! tip
    If setup succeeds but the result looks incomplete, check the troubleshooting page before assuming the integration failed.

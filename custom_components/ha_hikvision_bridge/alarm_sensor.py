
from homeassistant.components.binary_sensor import BinarySensorEntity

class HikvisionAlarmBinarySensor(BinarySensorEntity):
    def __init__(self, name):
        self._attr_name = name
        self._state = False

    def update_from_event(self, event):
        if event["state"] == "active":
            self._state = True
        else:
            self._state = False

    @property
    def is_on(self):
        return self._state

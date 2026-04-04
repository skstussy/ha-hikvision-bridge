class DebugManager:
    def __init__(self):
        self._listeners = []
        self._events = []

    def register_listener(self, callback):
        self._listeners.append(callback)

    def push(self, event):
        self._events.append(event)
        for cb in list(self._listeners):
            try:
                cb(event)
            except Exception:
                pass

    def get_events(self):
        return self._events[-300:]


import asyncio
import aiohttp

class HikvisionAlarmStream:
    def __init__(self, host, auth):
        self.url = f"http://{host}/ISAPI/Event/notification/alertStream"
        self.auth = auth
        self.listeners = []

    def register_listener(self, callback):
        self.listeners.append(callback)

    async def start(self):
        session = aiohttp.ClientSession(auth=self.auth)
        async with session.get(self.url) as resp:
            async for line in resp.content:
                decoded = line.decode(errors="ignore")
                if "<EventNotificationAlert>" in decoded:
                    for cb in self.listeners:
                        cb(decoded)

def parse_event(xml):
    def extract(tag):
        start = xml.find(f"<{tag}>") + len(tag) + 2
        end = xml.find(f"</{tag}>")
        return xml[start:end] if start > -1 and end > -1 else None

    return {
        "type": extract("eventType"),
        "state": extract("eventState"),
        "channel": extract("channelID")
    }

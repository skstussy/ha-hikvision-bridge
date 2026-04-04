from __future__ import annotations

from homeassistant.util import dt as dt_util

from .ptz import HikvisionPTZ


class HikvisionController:
    def __init__(self, hass, config):
        self.hass = hass
        self.config = config
        self.api = None
        self.channels = []

    async def initialize(self):
        self.api = HikvisionPTZ(**self.config)
        await self.api.test_connection()
        self.channels = list(range(1, 9))

    async def ptz(self, channel, command, speed):
        return await self.api.ptz(channel, command, speed)

    async def stop(self, channel):
        return await self.api.stop(channel)


    async def search_playback(self, channel, timestamp):
        from datetime import timedelta
        track_id = int(channel)
        if track_id >= 100:
            track_id = track_id // 100
        track_id = (track_id * 100) + 1
        start = dt_util.as_utc(timestamp - timedelta(seconds=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
        end = dt_util.as_utc(timestamp + timedelta(seconds=30)).strftime("%Y-%m-%dT%H:%M:%SZ")

        body = f"""<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <searchID>11111111-1111-1111-1111-111111111111</searchID>
    <trackIDList><trackID>{track_id}</trackID></trackIDList>
    <timeSpanList>
        <timeSpan>
            <startTime>{start}</startTime>
            <endTime>{end}</endTime>
        </timeSpan>
    </timeSpanList>
    <maxResults>5</maxResults>
    <searchResultPosition>0</searchResultPosition>
</CMSearchDescription>"""

        resp = await self.api.client.post("/ISAPI/ContentMgmt/search", body)
        if not resp:
            return None

        import re
        m = re.search(r"<playbackURI>(.*?)</playbackURI>", resp)
        return m.group(1) if m else None

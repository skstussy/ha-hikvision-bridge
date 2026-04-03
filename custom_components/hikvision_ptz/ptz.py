from __future__ import annotations

from .isapi import HikvisionISAPI


class HikvisionPTZ:
    def __init__(self, host, username, password, port=80, use_https=False, verify_ssl=False):
        self.api = HikvisionISAPI(host, username, password, port, use_https, verify_ssl)

    async def test_connection(self):
        return await self.api.get_device_info()

    async def ptz(self, channel, command, speed):
        return await self.api.ptz_control(channel, command, speed)

    async def stop(self, channel):
        return await self.api.ptz_stop(channel)

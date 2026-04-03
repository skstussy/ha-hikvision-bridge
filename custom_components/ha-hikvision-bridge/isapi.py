import asyncio
import aiohttp
from .const import DEFAULT_TIMEOUT

class ISAPIClient:
    def __init__(self, host, username, password, port=80, use_https=False, verify_ssl=False):
        self.base = f"{'https' if use_https else 'http'}://{host}:{port}"
        self.auth = aiohttp.BasicAuth(username, password)
        self.verify_ssl = verify_ssl

    async def _request(self, method, path, data=None):
        url = f"{self.base}{path}"

        timeout = aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT)

        for attempt in range(3):
            try:
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.request(
                        method,
                        url,
                        data=data,
                        auth=self.auth,
                        ssl=self.verify_ssl
                    ) as resp:

                        text = await resp.text()

                        if resp.status in (200, 201):
                            return text

                        if resp.status == 403:
                            raise Exception("Auth failed (403)")

            except asyncio.TimeoutError:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.5)

        return None

    async def get(self, path):
        return await self._request("GET", path)

    async def put(self, path, data):
        return await self._request("PUT", path, data)


    async def post(self, path, data):
        return await self._request("POST", path, data)

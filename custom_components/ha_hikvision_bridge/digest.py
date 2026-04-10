from __future__ import annotations

import hashlib
import os
from urllib.parse import urlsplit


class DigestAuth:
    def __init__(self, username: str, password: str) -> None:
        self.username = username
        self.password = password
        self.realm: str | None = None
        self.nonce: str | None = None
        self.qop = "auth"
        self.algorithm = "MD5"
        self.opaque: str | None = None
        self.stale = False
        self.nc = 0

    def _md5(self, value: str) -> str:
        return hashlib.md5(value.encode("utf-8")).hexdigest()

    def parse(self, header: str) -> None:
        parts: dict[str, str] = {}
        header = (header or "").replace("Digest ", "", 1)
        for item in header.split(","):
            if "=" not in item:
                continue
            key, value = item.strip().split("=", 1)
            parts[key] = value.strip().strip('"')
        self.realm = parts.get("realm")
        self.nonce = parts.get("nonce")
        self.qop = parts.get("qop", "auth").split(",")[0].strip()
        self.algorithm = parts.get("algorithm", "MD5")
        self.opaque = parts.get("opaque")
        self.stale = str(parts.get("stale", "")).lower() == "true"

    def ready(self) -> bool:
        return bool(self.realm and self.nonce)

    def reset(self) -> None:
        self.realm = None
        self.nonce = None
        self.opaque = None
        self.qop = "auth"
        self.algorithm = "MD5"
        self.stale = False
        self.nc = 0

    def build(self, method: str, uri: str) -> str:
        if not self.ready():
            raise ValueError("Digest challenge not initialized")

        if uri.startswith("http://") or uri.startswith("https://"):
            parsed = urlsplit(uri)
            uri = parsed.path or "/"
            if parsed.query:
                uri = f"{uri}?{parsed.query}"

        self.nc += 1
        nc_value = f"{self.nc:08x}"
        cnonce = self._md5(os.urandom(8).hex())

        ha1 = self._md5(f"{self.username}:{self.realm}:{self.password}")
        ha2 = self._md5(f"{method.upper()}:{uri}")
        response = self._md5(
            f"{ha1}:{self.nonce}:{nc_value}:{cnonce}:{self.qop}:{ha2}"
        )

        parts = [
            f'username="{self.username}"',
            f'realm="{self.realm}"',
            f'nonce="{self.nonce}"',
            f'uri="{uri}"',
            f'response="{response}"',
            f'qop={self.qop}',
            f'nc={nc_value}',
            f'cnonce="{cnonce}"',
        ]
        if self.opaque:
            parts.append(f'opaque="{self.opaque}"')
        if self.algorithm:
            parts.append(f'algorithm={self.algorithm}')
        return "Digest " + ", ".join(parts)

    async def async_get_authorization(
        self,
        session,
        method: str,
        uri: str,
        *,
        body: str | bytes | None = None,
        verify_ssl: bool = False,
    ) -> str:
        if self.ready():
            return self.build(method, uri)

        async with session.request(
            method,
            uri,
            data=body,
            ssl=verify_ssl,
            allow_redirects=False,
        ) as resp:
            www_auth = resp.headers.get("WWW-Authenticate", "")
            if resp.status != 401 or not www_auth:
                raise ValueError(
                    f"Digest challenge request failed with status {resp.status}"
                )
            self.parse(www_auth)

        if not self.ready():
            raise ValueError("Digest challenge not initialized")
        return self.build(method, uri)

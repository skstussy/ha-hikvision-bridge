from __future__ import annotations

import asyncio
import logging

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_DEBUG_CATEGORIES,
    CONF_DEBUG_ENABLED,
    CONF_HOST,
    CONF_PASSWORD,
    CONF_PORT,
    CONF_USERNAME,
    CONF_USE_HTTPS,
    CONF_VERIFY_SSL,
    DEFAULT_DEBUG_CATEGORIES,
    DEFAULT_PORT_HTTP,
    DEFAULT_PORT_HTTPS,
    DEFAULT_USE_HTTPS,
    DEFAULT_VERIFY_SSL,
    DOMAIN,
)
from .digest import DigestAuth

_LOGGER = logging.getLogger(__name__)


def _normalize_categories(raw_value) -> list[str]:
    if isinstance(raw_value, str):
        values = [item.strip().lower() for item in raw_value.split(",")]
    elif isinstance(raw_value, (list, tuple, set)):
        values = [str(item).strip().lower() for item in raw_value]
    else:
        values = []
    return [item for item in values if item]


def _build_connection_schema(defaults: dict | None = None) -> vol.Schema:
    defaults = defaults or {}
    use_https_default = defaults.get(CONF_USE_HTTPS, DEFAULT_USE_HTTPS)
    default_port = defaults.get(
        CONF_PORT,
        DEFAULT_PORT_HTTPS if use_https_default else DEFAULT_PORT_HTTP,
    )
    return vol.Schema(
        {
            vol.Required(CONF_HOST, default=defaults.get(CONF_HOST, "")): str,
            vol.Required(CONF_PORT, default=default_port): int,
            vol.Required(CONF_USERNAME, default=defaults.get(CONF_USERNAME, "")): str,
            vol.Required(CONF_PASSWORD, default=defaults.get(CONF_PASSWORD, "")): str,
            vol.Optional(CONF_USE_HTTPS, default=use_https_default): bool,
            vol.Optional(
                CONF_VERIFY_SSL,
                default=defaults.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL),
            ): bool,
        }
    )


class HikvisionFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    @staticmethod
    def async_get_options_flow(config_entry):
        return HikvisionOptionsFlow(config_entry)

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            ok = await self._test_connection(user_input)
            if ok:
                await self.async_set_unique_id(
                    f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}"
                )
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=f"Hikvision DVR ({user_input[CONF_HOST]})",
                    data=user_input,
                )
            errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user",
            data_schema=_build_connection_schema(),
            errors=errors,
        )

    async def async_step_reconfigure(self, user_input=None):
        entry = self._get_reconfigure_entry()
        errors = {}

        if user_input is not None:
            ok = await self._test_connection(user_input)
            if ok:
                await self.async_set_unique_id(
                    f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}"
                )
                self._abort_if_unique_id_mismatch(reason="already_configured")

                return self.async_update_reload_and_abort(
                    entry,
                    unique_id=self.unique_id,
                    title=f"Hikvision DVR ({user_input[CONF_HOST]})",
                    data_updates=user_input,
                )
            errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_build_connection_schema(dict(entry.data)),
            errors=errors,
        )

    async def _test_connection(self, data):
        session = async_get_clientsession(self.hass)
        digest = DigestAuth(data[CONF_USERNAME], data[CONF_PASSWORD])
        scheme = "https" if data[CONF_USE_HTTPS] else "http"
        path = "/ISAPI/System/deviceInfo?JumpChildDev=true"
        url = f"{scheme}://{data[CONF_HOST]}:{data[CONF_PORT]}{path}"
        headers = {"Content-Type": "application/xml"}

        try:
            _LOGGER.debug("Testing Hikvision connection to %s", url)
            resp = await asyncio.wait_for(
                session.get(url, headers=headers, ssl=data[CONF_VERIFY_SSL]),
                timeout=10,
            )
            if resp.status == 401:
                www_auth = resp.headers.get("WWW-Authenticate", "")
                if not www_auth:
                    return False
                digest.parse(www_auth)
                headers["Authorization"] = digest.build("GET", path)
                resp.release()
                resp = await asyncio.wait_for(
                    session.get(url, headers=headers, ssl=data[CONF_VERIFY_SSL]),
                    timeout=10,
                )
            body = await resp.text()
            if resp.status != 200:
                _LOGGER.error(
                    "Config flow test failed. URL=%s Status=%s Body=%s",
                    url,
                    resp.status,
                    body,
                )
                return False
            return True
        except asyncio.TimeoutError:
            _LOGGER.error("Timeout connecting to %s", url)
            return False
        except Exception as err:
            _LOGGER.exception("Unexpected error testing %s: %s", url, err)
            return False


class HikvisionOptionsFlow(config_entries.OptionsFlow):
    def __init__(self, config_entry):
        self.config_entry = config_entry

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            categories = _normalize_categories(
                user_input.get(CONF_DEBUG_CATEGORIES, "")
            )
            return self.async_create_entry(
                title="",
                data={
                    CONF_DEBUG_ENABLED: bool(
                        user_input.get(CONF_DEBUG_ENABLED, False)
                    ),
                    CONF_DEBUG_CATEGORIES: categories,
                },
            )

        current_categories = self.config_entry.options.get(
            CONF_DEBUG_CATEGORIES, list(DEFAULT_DEBUG_CATEGORIES)
        )
        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_DEBUG_ENABLED,
                    default=self.config_entry.options.get(
                        CONF_DEBUG_ENABLED, False
                    ),
                ): bool,
                vol.Optional(
                    CONF_DEBUG_CATEGORIES,
                    default=", ".join(current_categories),
                ): str,
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)

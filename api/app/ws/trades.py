"""Real-time trade event channel.

Dedicated WebSocket fanout for order lifecycle events (fill, cancel, error)
separate from the main quote/snapshot channel in [`manager`][.manager]. Kept
deliberately small: a single in-memory set of live WebSocket connections and
three typed broadcast helpers invoked from order-placement / fill / error
code paths.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Set

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class TradesChannel:
    def __init__(self) -> None:
        self._connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.add(websocket)
        logger.info("trades ws client connected (%d total)", len(self._connections))

    def disconnect(self, websocket: WebSocket) -> None:
        self._connections.discard(websocket)
        logger.info("trades ws client disconnected (%d total)", len(self._connections))

    async def broadcast(self, message: Dict[str, Any]) -> None:
        if not self._connections:
            return
        payload = json.dumps(message)
        dead: list[WebSocket] = []
        for ws in self._connections:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._connections.discard(ws)

    async def broadcast_fill(self, trade: Dict[str, Any]) -> None:
        await self.broadcast({"type": "fill", "data": trade})

    async def broadcast_cancel(self, order: Dict[str, Any]) -> None:
        await self.broadcast({"type": "cancel", "data": order})

    async def broadcast_error(self, error: Dict[str, Any]) -> None:
        await self.broadcast({"type": "error", "data": error})

    @property
    def connection_count(self) -> int:
        return len(self._connections)


trades_channel = TradesChannel()

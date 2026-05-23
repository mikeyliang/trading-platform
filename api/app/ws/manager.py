import asyncio
import json
import logging
from typing import Dict, Set
from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        self._connections: Dict[str, WebSocket] = {}
        self._subscriptions: Dict[str, Set[str]] = {}  # client_id -> set of symbols

    async def connect(self, client_id: str, websocket: WebSocket):
        await websocket.accept()
        self._connections[client_id] = websocket
        self._subscriptions[client_id] = set()
        logger.info(f"client {client_id} connected ({len(self._connections)} total)")

    def disconnect(self, client_id: str):
        self._connections.pop(client_id, None)
        self._subscriptions.pop(client_id, None)
        logger.info(f"client {client_id} disconnected")

    async def send(self, client_id: str, message: dict):
        ws = self._connections.get(client_id)
        if ws:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                self.disconnect(client_id)

    async def broadcast(self, message: dict):
        if not self._connections:
            return
        payload = json.dumps(message)
        dead = []
        for cid, ws in self._connections.items():
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(cid)
        for cid in dead:
            self.disconnect(cid)

    async def broadcast_bar(self, symbol: str, bar: dict):
        await self.broadcast({"type": "bar", "symbol": symbol, "data": bar})

    async def broadcast_quote(self, symbol: str, quote: dict):
        await self.broadcast({"type": "quote", "symbol": symbol, "data": quote})

    async def broadcast_signal(self, symbol: str, signal: str, strategy: str, price: float):
        await self.broadcast({
            "type": "signal",
            "symbol": symbol,
            "signal": signal,
            "strategy": strategy,
            "price": price,
        })

    async def broadcast_order(self, order: dict):
        await self.broadcast({"type": "order", "data": order})

    async def broadcast_position(self, position: dict):
        await self.broadcast({"type": "position", "data": position})

    @property
    def connection_count(self) -> int:
        return len(self._connections)


manager = ConnectionManager()

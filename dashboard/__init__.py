"""Backend (FastAPI router + media server) for the wallpaper-engine plugin.

``media_server`` is import-safe on its own: it pulls in nothing from Hermes and
nothing from FastAPI, so it can be exercised without a gateway.
"""

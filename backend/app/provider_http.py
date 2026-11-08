"""HTTP configuration shared by the stateless provider entrypoints."""
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


def provider_app(title):
    app = FastAPI(title=title)
    origins = [value.strip() for value in os.environ.get("BROWSER_ALLOWED_ORIGINS", "").split(",") if value.strip()]
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
    return app

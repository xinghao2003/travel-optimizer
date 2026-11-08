"""Local ASGI assembly of the two independently deployable provider functions."""
from api.flights import app as flights
from api.transit import app as transit
from app.provider_http import provider_app

app = provider_app("Wayfinder local provider functions")
app.include_router(flights.router)
app.include_router(transit.router)

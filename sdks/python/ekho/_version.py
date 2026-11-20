"""The Python SDK's own version (pyproject.toml ``version``).

Its own module so ``client.py`` can send it on heartbeats (#97) without
importing the package ``__init__`` (which imports the client). Python SDK
releases are versioned separately from the Ekho relay.
"""

__version__ = "0.1.0"

"""Load the item/location table (data/tfe.toml) shared with the Rust mod.

Works both from a folder and from inside an .apworld zip: pkgutil.get_data
resolves package data through the zip importer as well.
"""
import tomllib
from importlib import resources

with resources.files(__package__).joinpath("data/tfe.toml").open("rb") as f:
    _TABLE = tomllib.load(f)

GAME = _TABLE["game"]
ITEMS = _TABLE["item"]
LOCATIONS = _TABLE["location"]

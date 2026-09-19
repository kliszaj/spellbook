# Moxfield Snapshots

These are card-name and quantity snapshots captured from the public Moxfield
URLs in `../deck-analysis-calibration.json`. They make the deck-analysis
calibration corpus repeatable without relying on Moxfield's undocumented API.

Capture or refresh one public deck with:

```powershell
$env:VIRTUAL_ENV = "$env:TEMP\spellbook-calibration-venv"
& "$env:VIRTUAL_ENV\Scripts\python.exe" scripts\snapshot_moxfield_fixtures.py --id pako-haldan-voltron
```

Some public pages expose only a short Game Changers subset to automated page
reads. The snapshot tool rejects those incomplete results; it must not be
worked around by saving the partial list as a deck fixture.

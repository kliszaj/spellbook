#!/usr/bin/env python3
"""Capture user-provided public Moxfield decklists as local calibration fixtures."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
from collections import OrderedDict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from playwright.async_api import BrowserContext, Page, async_playwright


ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "fixtures" / "deck-analysis-calibration.json"
SNAPSHOT_DIR = ROOT / "fixtures" / "moxfield-snapshots"
CARD_ROW_PATTERN = re.compile(r"^(?P<quantity>\d+)\s+(?P<name>.+?)$")
EDGE_CANDIDATES = (
    Path(os.environ.get("PROGRAMFILES(X86)", r"C:\\Program Files (x86)"))
    / "Microsoft"
    / "Edge"
    / "Application"
    / "msedge.exe",
    Path(os.environ.get("PROGRAMFILES", r"C:\\Program Files"))
    / "Google"
    / "Chrome"
    / "Application"
    / "chrome.exe",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--id",
        dest="fixture_ids",
        action="append",
        help="Fixture id to capture. Repeat to capture more than one.",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Show the browser while capturing. Useful for diagnosing a changed page layout.",
    )
    return parser.parse_args()


def browser_executable() -> str | None:
    configured = os.environ.get("MOXFIELD_BROWSER")
    if configured:
        path = Path(configured)
        if not path.is_file():
            raise RuntimeError(f"MOXFIELD_BROWSER does not exist: {path}")
        return str(path)

    for candidate in EDGE_CANDIDATES:
        if candidate.is_file():
            return str(candidate)

    return None


def selected_fixtures(fixture_ids: list[str] | None) -> list[dict[str, Any]]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    fixtures = [
        fixture
        for fixture in manifest["fixtures"]
        if str(fixture["source"]).startswith("https://moxfield.com/decks/")
    ]

    if not fixture_ids:
        return fixtures

    wanted = set(fixture_ids)
    selected = [fixture for fixture in fixtures if fixture["id"] in wanted]
    missing = wanted - {fixture["id"] for fixture in selected}
    if missing:
        raise RuntimeError(f"Unknown or non-Moxfield fixture id(s): {', '.join(sorted(missing))}")
    return selected


async def extract_cards(page: Page, source: str) -> tuple[str, list[dict[str, Any]]]:
    await page.goto(source, wait_until="domcontentloaded", timeout=45_000)
    card_links = page.locator('a[href*="/cards/"]')
    try:
        await card_links.first.wait_for(state="visible", timeout=45_000)
    except Exception as error:
        title = await page.title()
        body = (await page.locator("body").inner_text()).strip().replace("\n", " ")
        preview = re.sub(r"\s+", " ", body)[:300]
        raise RuntimeError(
            f"Moxfield did not expose card links (page title: {title!r}; body: {preview!r})"
        ) from error

    await page.wait_for_timeout(750)
    article = page.locator("article").first
    root = article if await article.count() else page.locator("body")

    result = await root.evaluate(
        """(element) => ({
          title: document.title,
          rows: Array.from(element.querySelectorAll('a[href*="/cards/"]')).map((link) => ({
            name: link.textContent.trim().replace(/\\s+/g, ' '),
            row: (link.closest('li')?.innerText || '').trim().replace(/\\s+/g, ' '),
          })),
        })"""
    )

    cards: OrderedDict[str, int] = OrderedDict()
    for row in result["rows"]:
        name = row["name"]
        match = CARD_ROW_PATTERN.match(row["row"])
        quantity = int(match.group("quantity")) if match else 1
        if not name or quantity < 1:
            continue
        cards[name] = cards.get(name, 0) + quantity

    if len(cards) < 50:
        sample = "; ".join(
            f"{name} ({quantity})" for name, quantity in list(cards.items())[:8]
        )
        raise RuntimeError(
            f"Only extracted {len(cards)} unique cards from {source}: {sample}. "
            "Moxfield may have served an incomplete page or changed its layout."
        )

    return result["title"], [
        {"name": name, "quantity": quantity} for name, quantity in cards.items()
    ]


async def snapshot_fixture(context: BrowserContext, fixture: dict[str, Any]) -> Path:
    page = await context.new_page()
    await page.set_viewport_size({"width": 1440, "height": 1100})
    try:
        title, cards = await extract_cards(page, fixture["source"])
    finally:
        await page.close()

    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = SNAPSHOT_DIR / f"{fixture['id']}.json"
    output = {
        "schemaVersion": 1,
        "fixtureId": fixture["id"],
        "source": fixture["source"],
        "capturedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "pageTitle": title,
        "uniqueCards": len(cards),
        "totalCards": sum(card["quantity"] for card in cards),
        "cards": cards,
    }
    output_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    return output_path


async def main() -> int:
    args = parse_args()
    fixtures = selected_fixtures(args.fixture_ids)
    executable = browser_executable()

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=not args.headed,
            executable_path=executable,
        )
        try:
            for fixture in fixtures:
                context = await browser.new_context(
                    locale="en-US",
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/138.0.0.0 Safari/537.36"
                    ),
                )
                try:
                    output_path = await snapshot_fixture(context, fixture)
                finally:
                    await context.close()
                print(f"Captured {fixture['id']} -> {output_path.relative_to(ROOT)}")
        finally:
            await browser.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as error:
        print(f"Snapshot failed: {error}", file=sys.stderr)
        raise SystemExit(1)


from playwright.sync_api import Page, expect, sync_playwright
import time

def verify_redesign(page: Page):
    """
    Verifies that the ultra-modern design is applied by checking CSS variables
    and taking a screenshot of the landing page.
    """
    # 1. Navigate to the frontend
    page.goto("http://localhost:3002")

    # 2. Wait for the auth container to be visible
    auth_container = page.locator("#auth-container")
    expect(auth_container).to_be_visible(timeout=10000)

    # 3. Verify ultra-modern CSS variables are present on the body
    # We check for the background color which should come from --um-bg or the gradient
    # Since computed styles are hard to check for gradients easily without evaluation,
    # we will check if the 'ultra-modern.css' file is loaded by checking a specific style
    # that we know we added, e.g., the font-family "Inter" or the body background.

    # Evaluate the font-family of the body
    font_family = page.evaluate("window.getComputedStyle(document.body).fontFamily")
    print(f"Body font family: {font_family}")

    # We expect 'Inter' to be in the font family stack
    assert "Inter" in font_family or "system-ui" in font_family

    # 4. Check that the hero title exists and has the correct text class
    hero_title = page.locator(".hero-title")
    expect(hero_title).to_be_visible()

    # 5. Take a screenshot of the redesign
    # We wait a moment for any animations or fonts to load
    time.sleep(2)
    page.screenshot(path="/home/jules/verification/redesign_verification.png", full_page=True)
    print("Screenshot taken at /home/jules/verification/redesign_verification.png")

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            verify_redesign(page)
        finally:
            browser.close()

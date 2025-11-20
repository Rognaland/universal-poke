
from playwright.sync_api import Page, expect, sync_playwright
import time

def verify_multiplayer_menu(page: Page):
    # 1. Navigate to localhost:3002
    page.goto("http://localhost:3002")

    # 2. Wait for page load and check for connect button (indicates app loaded)
    try:
        expect(page.get_by_role("button", name="Refresh account list")).to_be_visible(timeout=10000)
    except:
        print("Refresh account list button not found. Trying to proceed anyway (maybe auto-connected?)")

    # 3. Mock login if needed (click "Continue" if account picker appears)
    # Actually, the default state shows "Refresh account list" and "Sign in".
    # We need to simulate a login to see the main menu.
    # Since we can't easily mock the extension, we might need to rely on the app state.
    # However, we can check if we can inject some state to show the menu.

    # Inject localStorage to simulate login
    page.evaluate("localStorage.setItem('up.address', '0x1234567890123456789012345678901234567890')")
    page.evaluate("localStorage.setItem('up.username', 'TestUser')")
    page.reload()

    # Wait for Post-Login Menu
    # The menu should appear if we have cached credentials (see main.js initApp)
    # Wait for "Choose Your Game" text
    try:
        expect(page.get_by_text("Choose Your Game")).to_be_visible(timeout=15000)
        print("Login successful, menu visible.")
    except:
        # If automatic login didn't work, we might be stuck.
        # Let's try to manually trigger the menu display via console for testing purposes
        page.evaluate("document.getElementById('auth-container').style.display = 'none'")
        page.evaluate("document.getElementById('postlogin-menu').style.display = 'flex'")
        print("Forced menu display.")

    # 4. Click "Multiplayer Games" button
    # Find button with text "Multiplayer Poker"
    multiplayer_btn = page.locator(".menu-btn").filter(has_text="Multiplayer Poker")
    if multiplayer_btn.count() > 0:
        multiplayer_btn.first.click()
        print("Clicked Multiplayer Poker button.")

        # 5. Verify Multiplayer Menu content
        # Wait for "Host Game" button to be visible
        host_game_btn = page.locator("button").filter(has_text="Host Game")
        try:
            expect(host_game_btn).to_be_visible(timeout=5000)
            print("SUCCESS: Multiplayer menu buttons found.")
        except:
            print("FAILURE: Multiplayer menu buttons missing.")

        # Take screenshot of Multiplayer Menu
        time.sleep(1) # Wait for transition
        page.screenshot(path="verification/multiplayer_menu_fixed.png")
    else:
        print("FAILURE: Multiplayer button not visible in main menu.")
        page.screenshot(path="verification/main_menu_fail.png")

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            verify_multiplayer_menu(page)
        except Exception as e:
            print(f"Error: {e}")
            page.screenshot(path="verification/error.png")
        finally:
            browser.close()

from playwright.sync_api import sync_playwright
import time

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()

    try:
        # Correct port from logs is 3002
        page.goto("http://localhost:3002")

        # Wait for initial load
        page.wait_for_load_state("networkidle")

        # Take a screenshot of the initial state
        page.screenshot(path="verification/initial_load.png")

        # Check for the button
        btn = page.query_selector("#btn-pay-buyin")
        if btn:
            print("SUCCESS: 'Pay Buy-in' button found in DOM.")
        else:
            print("FAILURE: 'Pay Buy-in' button NOT found in DOM.")

        # Force it visible for screenshot
        # We also show the panel-waiting so the button is visible in context
        page.evaluate("document.getElementById('panel-waiting').style.display = 'block';")
        page.evaluate("document.getElementById('btn-pay-buyin').style.display = 'inline-block';")

        page.screenshot(path="verification/pay_buyin_button.png")

    except Exception as e:
        print(f"Error: {e}")

    browser.close()

with sync_playwright() as playwright:
    run(playwright)

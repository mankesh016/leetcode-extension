# LeetCode Daily Problem — Extension 🔥

LeetCode's daily-challenge calendar marks a day red the moment you miss it —
even if you go back and solve that problem later. This extension turns that
day into a green checkmark once you've actually solved it, so your calendar
reflects reality instead of just punishing you forever for one bad day.

- 🔵 Blue checkmark — solved on time (LeetCode's own default, untouched)
- 🔴 Red dot — still unsolved
- 🟢 Green checkmark — solved late, but solved

<p align="center">
  <img src="assets/demo.gif" width="90%" alt="Animation: LeetCode's calendar with red missed-day dots, which the extension turns into green checkmarks for days solved late" />
</p>

## How to use it

1. Download/unzip this extension folder
2. Go to `chrome://extensions`
3. Turn on **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder
5. Open or refresh any leetcode.com page — the calendar widget (in the
   sidebar of the problem set page, or the floating calendar button on
   smaller screens) updates within a second or two

That's it — no login, no config, no options page. It uses your existing
LeetCode session in the browser.

Just solved a missed problem? Click the **⟳** button next to the
calendar's arrows to refresh straight away.

## How it works

Everything runs in one content script (`content.js`) on leetcode.com. There's
no server and no background worker.

```
page load / page change / Prev, Next or Today click / tab comes to the front
        │
        ▼  (waits 500 ms for the page to settle; one pass at a time)
   1. Find every calendar on the page (sidebar and/or popup) and keep the
      visible ones. Add the ⟳ button next to each one's arrows.
   2. Look for red "missed" dots.
        └─ none? → stop. No network request.
   3. Find out who's signed in (one `userStatus` request per page load).
        └─ request failed? → use the last known account to show cached
           ticks, but don't fetch or save anything.
   4. Load that account's saved solved days.
   5. Red dot on a day already known to be solved → green checkmark.
      No network request.
   6. Red dots left in a month? Fetch that month's challenges only if:
        • you clicked ⟳, or
        • the tab is visible, AND the month wasn't checked in the last
          12 hours, AND requests aren't paused after a failure.
   7. Save every solved day in the response, note when the month was
      checked, and turn solved red dots into green checkmarks.
```

**Which month is shown?** The calendar has no month label, so the extension
counts your Prev, Next and Today clicks. Each calendar keeps its own month.

**The green checkmark** is LeetCode's own blue checkmark, copied and
recoloured green, so it matches exactly. It's drawn on top of the day, so
LeetCode's page isn't changed underneath. The ⟳ button floats beside the
arrows and doesn't move anything on the page.

### Requests

- All requests go to `https://leetcode.com/graphql` (GraphQL), using your
  existing LeetCode login.
- Solved days are saved forever, because a solved day can't become
  unsolved. Seeing them again needs no request.
- Days that are still red are re-checked at most once every 12 hours per
  month, or whenever you click ⟳.
- Only the tab you're looking at sends requests automatically. With
  10 LeetCode tabs open, the background tabs stay quiet and use what the
  visible tab saved.
- If LeetCode blocks or rate-limits a request, the extension retries after
  30 seconds, 1 minute and 5 minutes, then stops until the page is reloaded.
  ⟳ always tries again. Days already saved as solved keep their green
  checkmarks the whole time.

### Privacy

- Talks only to leetcode.com. No analytics, no other servers.
- Stores only solved dates, when each month was last checked and your
  LeetCode user ID, in your browser (`chrome.storage.local`).
- Each LeetCode account gets its own saved data, so switching accounts in
  the same browser never mixes them.
- Permissions: `storage`, plus access to `leetcode.com`.

### Debugging

On leetcode.com, open DevTools and run:

- `__lcDotFixerTest()` — lists the calendars found, their months and red
  dots, the retry state, the signed-in user and the raw response for the
  shown month.
- `__lcDotFixerCache()` — shows what's saved for your account.

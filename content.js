// LeetCode Streak Dot Fixer
// Turns the red "missed" dot on the daily-challenge calendar into a green
// checkmark once you've solved that day's problem late. On-time blue
// checkmarks are untouched.
//
// Solved dates are cached per LeetCode account (chrome.storage.local, keyed
// by userId) since a solved date can never become unsolved again. Each month
// also remembers when it was last fetched: a month's remaining red days are
// re-checked automatically at most once per MONTH_TTL_MS. The ⟳ button next
// to the calendar arrows re-checks right away.

(function () {
  const GRAPHQL_URL = "https://leetcode.com/graphql";

  const MONTH_TTL_MS = 12 * 60 * 60 * 1000;
  // After a failed request, retry automatically after each of these delays,
  // then stop until the page is reloaded or the user clicks ⟳.
  const RETRY_DELAYS_MS = [30 * 1000, 60 * 1000, 5 * 60 * 1000];

  // NOTE: field names below are inferred from LeetCode's documented
  // `activeDailyCodingChallengeQuestion` query pattern. Run the
  // window.__lcDotFixerTest() helper in the console (see bottom of this
  // file) to confirm this shape before relying on it.
  const CHALLENGES_QUERY = `
    query dailyCodingChallengeV2($year: Int!, $month: Int!) {
      dailyCodingChallengeV2(year: $year, month: $month) {
        challenges {
          date
          userStatus
          question {
            titleSlug
            status
          }
        }
      }
    }
  `;

  // NOTE: also inferred/unverified — confirm with window.__lcDotFixerTest()
  // before trusting userId as a cache key on a real logged-in session.
  const USER_STATUS_QUERY = `
    query userStatus {
      userStatus {
        userId
        username
        isSignedIn
      }
    }
  `;

  // Throws on anything that isn't a clean GraphQL answer: network errors,
  // non-2xx statuses (403/429) and HTML block pages (res.json() throws).
  async function graphql(query, variables) {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    return json.data;
  }

  // The month's challenges, or null if the request failed.
  async function fetchMonthChallenges(year, month) {
    try {
      const data = await graphql(CHALLENGES_QUERY, { year, month });
      const challenges = data?.dailyCodingChallengeV2?.challenges;
      if (!Array.isArray(challenges)) throw new Error("unexpected response shape");
      return challenges;
    } catch (e) {
      console.warn("[LC Dot Fixer] challenge fetch failed:", e);
      return null;
    }
  }

  // Every date in the month that's solved (ever), regardless of on-time status.
  function solvedDates(challenges) {
    return challenges.filter((c) => c.question?.status === "ac").map((c) => c.date);
  }

  // ---- Retry backoff for blocked/failed requests ----
  //
  // On a failure, automatic requests pause and one retry is scheduled after
  // the next delay in RETRY_DELAYS_MS. When those run out, automatic
  // requests stop for the rest of the page's life. A manual ⟳ click always
  // tries once, and any successful fetch resets everything.

  const backoff = { failures: 0, timer: null, gaveUp: false };

  // Automatic requests also only go out from the tab the user is looking
  // at. With 10 LeetCode tabs open, background tabs stay quiet; each one
  // re-checks when it's brought to the front, and by then another tab has
  // usually refreshed the shared cache already. A retry that comes due in
  // a background tab waits until the tab is visible.
  function canAutoFetch() {
    return document.visibilityState === "visible" && !backoff.timer && !backoff.gaveUp;
  }

  function onRequestFailure() {
    if (backoff.gaveUp || backoff.timer) return;
    if (backoff.failures >= RETRY_DELAYS_MS.length) {
      backoff.gaveUp = true;
      console.warn("[LC Dot Fixer] requests keep failing; automatic retries stopped. Click ⟳ to try again.");
      return;
    }
    const delay = RETRY_DELAYS_MS[backoff.failures++];
    backoff.timer = setTimeout(() => {
      backoff.timer = null;
      run();
    }, delay);
  }

  function onRequestSuccess() {
    clearTimeout(backoff.timer);
    backoff.failures = 0;
    backoff.timer = null;
    backoff.gaveUp = false;
  }

  // ---- chrome.storage.local helpers ----

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => resolve(result || {}));
      } catch (e) {
        console.warn("[LC Dot Fixer] storage.get failed:", e);
        resolve({});
      }
    });
  }

  function storageSet(items) {
    try {
      chrome.storage.local.set(items);
    } catch (e) {
      console.warn("[LC Dot Fixer] storage.set failed:", e);
    }
  }

  // ---- Per-account identity (so the cache never crosses accounts) ----
  //
  // The userId is asked for once per page load. If that request fails, we
  // fall back to the last userId seen in this browser so cached ticks still
  // show, but nothing is fetched or written for an unconfirmed user.

  const LAST_USER_KEY = "lcDotFixer_lastUserId";
  let confirmedUserId; // undefined = not asked yet, null = signed out, string = userId

  async function resolveUser(allowNetwork) {
    if (confirmedUserId !== undefined) return { userId: confirmedUserId, confirmed: true };
    if (allowNetwork) {
      try {
        const us = (await graphql(USER_STATUS_QUERY))?.userStatus;
        confirmedUserId = us && us.isSignedIn && us.userId ? String(us.userId) : null;
        if (confirmedUserId) storageSet({ [LAST_USER_KEY]: confirmedUserId });
        return { userId: confirmedUserId, confirmed: true };
      } catch (e) {
        console.warn("[LC Dot Fixer] userStatus fetch failed:", e);
        onRequestFailure();
      }
    }
    const last = (await storageGet([LAST_USER_KEY]))[LAST_USER_KEY] || null;
    return { userId: last, confirmed: false };
  }

  // ---- Per-account cache (chrome.storage.local) ----
  //
  // solved:  { "YYYY-MM-DD": true }   kept forever
  // checked: { "YYYY-MM": timestamp } when that month was last fetched

  function solvedKey(userId) {
    return `lcDotFixer_solved_${userId}`;
  }

  function checkedKey(userId) {
    return `lcDotFixer_checked_${userId}`;
  }

  let memState = null; // { userId, solved, checked } for the current account
  // Signed out: same shape, kept in memory only for this page.
  const anonState = { userId: null, solved: {}, checked: {} };

  async function getUserState(userId) {
    if (memState && memState.userId === userId) return memState;
    const r = await storageGet([solvedKey(userId), checkedKey(userId)]);
    memState = { userId, solved: r[solvedKey(userId)] || {}, checked: r[checkedKey(userId)] || {} };
    return memState;
  }

  // Merge with what's stored before writing, so two open LeetCode tabs
  // don't overwrite each other's additions.
  async function persistUserState(state) {
    const sk = solvedKey(state.userId);
    const ck = checkedKey(state.userId);
    const stored = await storageGet([sk, ck]);
    Object.assign(state.solved, stored[sk] || {}, state.solved);
    for (const [ym, t] of Object.entries(stored[ck] || {})) {
      state.checked[ym] = Math.max(state.checked[ym] || 0, t);
    }
    storageSet({ [sk]: state.solved, [ck]: state.checked });
  }

  function isMonthFresh(state, ym) {
    const t = state.checked[ym];
    return Boolean(t) && Date.now() - t < MONTH_TTL_MS;
  }

  // ---- Finding calendar widgets ----
  //
  // LeetCode can render more than one calendar at once: the sidebar widget
  // on wide screens, and a popup opened from the floating calendar button
  // on narrow screens. On narrow screens the sidebar widget can stay in the
  // DOM while hidden, so we must not just take the first match. We find
  // every widget through its Prev/Next arrows and only scan the visible
  // ones.

  const PREV_SELECTOR = '[aria-label="prev" i], [aria-label="previous" i]';
  const NEXT_SELECTOR = '[aria-label="next" i]';
  const NAV_SELECTOR = `${PREV_SELECTOR}, ${NEXT_SELECTOR}`;

  const DAY_RE = /^\d{1,2}$/;
  const WEEKDAY_RE = /^(S|M|T|W|F|Su|Mo|Tu|We|Th|Fr|Sa|Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/i;

  function leafTexts(el) {
    return Array.from(el.querySelectorAll("*"))
      .filter((e) => e.children.length === 0)
      .map((e) => e.textContent.trim());
  }

  // A calendar has a weekday header row (S M T W T F S) or at least a week's
  // worth of day numbers. This is strict enough to skip a "Day 6" header or
  // a problem-list pager's Prev/Next buttons.
  function looksLikeCalendarContainer(el) {
    if (!el.querySelectorAll) return false;
    const texts = leafTexts(el);
    if (texts.filter((t) => WEEKDAY_RE.test(t)).length >= 7) return true;
    return new Set(texts.filter((t) => DAY_RE.test(t))).size >= 7;
  }

  function findCalendarAncestor(el) {
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      if (looksLikeCalendarContainer(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  const anchorToContainer = new WeakMap(); // nav button -> container (or null)

  // Every calendar widget in the DOM, visible or not. If one container is
  // nested in another, only the outermost one is returned.
  function getAllCalendarContainers() {
    const found = new Set();
    for (const anchor of document.querySelectorAll(NAV_SELECTOR)) {
      let c = anchorToContainer.get(anchor);
      if (c === undefined || (c && !c.isConnected)) {
        c = findCalendarAncestor(anchor);
        anchorToContainer.set(anchor, c);
      }
      if (c) found.add(c);
    }
    const list = Array.from(found);
    return list.filter((c) => !list.some((o) => o !== c && o.contains(c)));
  }

  function isVisible(el) {
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  }

  // ---- Displayed-month tracking, per calendar widget ----
  //
  // The widget has no "Month Year" label to read, so we track clicks on its
  // Prev/Next/Today controls. Each widget (sidebar, popup) keeps its own
  // month. A newly mounted widget starts at the current month, just like
  // LeetCode's own state.
  //
  // Known limitation: if a widget changes month without a click we can see,
  // it drifts until the page is reloaded or the widget is mounted again.

  const displayedMonths = new WeakMap(); // container -> Date (1st of the month)

  function getDisplayedDate(root) {
    return displayedMonths.get(root) || new Date();
  }

  function isDisabledControl(el) {
    return el.disabled || el.getAttribute("aria-disabled") === "true" || getComputedStyle(el).cursor === "not-allowed";
  }

  document.addEventListener(
    "click",
    (e) => {
      const prevBtn = e.target.closest(PREV_SELECTOR);
      const nextBtn = e.target.closest(NEXT_SELECTOR);
      const todayBtn =
        e.target.closest('[aria-label="Today"]') ||
        (e.target.closest("button, a")?.textContent.trim() === "Today" ? e.target.closest("button, a") : null);
      const control = prevBtn || nextBtn || todayBtn;
      if (!control || isDisabledControl(control)) return;

      const root = getAllCalendarContainers().find((c) => c.contains(control));
      if (!root) return;

      const cur = getDisplayedDate(root);
      const now = new Date();
      if (prevBtn) {
        displayedMonths.set(root, new Date(cur.getFullYear(), cur.getMonth() - 1, 1));
      } else if (nextBtn) {
        const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
        // There are no daily challenges in future months, so the widget can't go there.
        if (next <= now) displayedMonths.set(root, next);
      } else {
        displayedMonths.delete(root);
      }
      schedule();
    },
    true, // capture phase, so this still fires even if LeetCode's own handler stops propagation
  );

  // ---- Day cells ----

  // Day numbers (1-31) shown directly in `el`, as its own text or as a
  // childless element. Our own check overlay is ignored.
  function dayNumbersIn(el) {
    const nums = [];
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE && DAY_RE.test(n.textContent.trim())) nums.push(parseInt(n.textContent, 10));
    }
    for (const e of el.querySelectorAll("*")) {
      if (e.children.length === 0 && !e.closest(".lcdf-check") && DAY_RE.test(e.textContent.trim())) {
        nums.push(parseInt(e.textContent.trim(), 10));
      }
    }
    return nums.filter((d) => d >= 1 && d <= 31);
  }

  // Heuristic detector for the small red "missed" dot elements.
  // Adjust the size/color thresholds here if it doesn't match on your DOM.
  function isRedDot(el) {
    if (!(el instanceof HTMLElement)) return false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w === 0 || h === 0 || w > 10 || h > 10) return false;
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const [r, g, b] = m.slice(1).map(Number);
    return r > 150 && g < 100 && b < 100;
  }

  // Walk up from a dot to the smallest ancestor that holds exactly one day
  // number: that's the day cell. If we reach one holding several numbers,
  // we've gone past the cell (into a week row) and give up.
  function findCell(dot, root) {
    let node = dot.parentElement;
    for (let i = 0; i < 5 && node && node !== root; i++) {
      const nums = dayNumbersIn(node);
      if (nums.length === 1) return { cell: node, day: nums[0] };
      if (nums.length > 1) return null;
      node = node.parentElement;
    }
    return null;
  }

  function dateStrFor(root, day) {
    const d = getDisplayedDate(root);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // The date a cell shows right now, or null if it isn't a single-day cell.
  function cellDate(root, cell) {
    const nums = dayNumbersIn(cell);
    return nums.length === 1 ? dateStrFor(root, nums[0]) : null;
  }

  function hasRedDot(cell) {
    return Array.from(cell.querySelectorAll("*")).some(isRedDot);
  }

  // ---- Styles ----

  const GREEN = "#2cbb5d";

  function injectStyles() {
    if (document.getElementById("lcdf-style")) return;
    const style = document.createElement("style");
    style.id = "lcdf-style";
    style.textContent = `
      .lcdf-cell { color: transparent !important; }
      .lcdf-cell > :not(.lcdf-check) { visibility: hidden !important; }
      .lcdf-rel { position: relative !important; }
      .lcdf-check {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        color: ${GREEN}; pointer-events: none; visibility: visible !important;
      }
      .lcdf-check > svg { max-width: 100%; max-height: 100%; }
      :where(.lcdf-refresh) {
        display: inline-flex; align-items: center; justify-content: center;
        background: transparent; border: 0; padding: 0; color: inherit; cursor: pointer;
      }
      .lcdf-refresh {
        position: absolute !important; margin: 0 !important;
        width: auto !important; height: auto !important;
        transform: translateY(-50%); z-index: 1;
      }
      .lcdf-pos { position: relative; }
      .lcdf-refresh.lcdf-spinning svg { animation: lcdf-spin 0.8s linear infinite; }
      .lcdf-refresh.lcdf-failed { color: #ef4743 !important; }
      @keyframes lcdf-spin { to { transform: rotate(360deg); } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- Green checkmark ----
  //
  // A day solved late gets LeetCode's own blue "solved on time" check icon,
  // cloned and recolored green. The icon is drawn over the cell, and the
  // cell's own number and red dot are hidden with `visibility` (not
  // removed), so React's DOM stays intact and we can still read it. If no
  // blue check is on the page to clone, we draw a similar SVG instead and
  // swap it for the clone once one appears.

  const FALLBACK_CHECK_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 11.1V12a9 9 0 1 1-5.34-8.23"/><path d="M21 5 12 14.01l-3-3"/></svg>';

  function isBlue(color) {
    const m = color && color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m) return false;
    const [r, g, b] = m.slice(1, 4).map(Number);
    if (m[4] !== undefined && Number(m[4]) === 0) return false;
    return b >= 170 && b - r >= 80 && b - g >= 20;
  }

  const COLOR_PROPS = ["color", "fill", "stroke"];

  function isBlueSvg(svg) {
    return [svg, ...svg.querySelectorAll("*")].some((el) => {
      const cs = getComputedStyle(el);
      return COLOR_PROPS.some((p) => isBlue(cs[p]));
    });
  }

  // Clone the blue check, replacing every blue color with green. The colors
  // are read from the original's computed style, so they're caught whether
  // they come from attributes, classes or an inherited `color`.
  function makeGreenClone(svg) {
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll("*")];
    const dst = [clone, ...clone.querySelectorAll("*")];
    src.forEach((el, i) => {
      const cs = getComputedStyle(el);
      for (const p of COLOR_PROPS) if (isBlue(cs[p])) dst[i].style[p] = GREEN;
    });
    const rect = svg.getBoundingClientRect();
    if (rect.width && rect.height) {
      clone.style.width = `${rect.width}px`;
      clone.style.height = `${rect.height}px`;
    }
    return clone;
  }

  let checkTemplate = null;

  // Hidden widgets are searched too: the hidden sidebar calendar can supply
  // the icon for the popup.
  function findCheckTemplate(containers) {
    if (checkTemplate) return checkTemplate;
    for (const root of containers) {
      for (const svg of root.querySelectorAll("svg")) {
        if (
          svg.closest(".lcdf-check, .lcdf-refresh") ||
          svg.closest(NAV_SELECTOR) ||
          svg.parentElement?.closest("svg")
        ) {
          continue;
        }
        if (isBlueSvg(svg)) {
          checkTemplate = makeGreenClone(svg);
          return checkTemplate;
        }
      }
    }
    return null;
  }

  function makeCheck() {
    const wrap = document.createElement("span");
    wrap.className = "lcdf-check";
    if (checkTemplate) {
      wrap.dataset.lcdfKind = "clone";
      wrap.appendChild(checkTemplate.cloneNode(true));
    } else {
      wrap.dataset.lcdfKind = "fallback";
      wrap.innerHTML = FALLBACK_CHECK_SVG;
    }
    return wrap;
  }

  function paint(cell, dateStr) {
    unpaint(cell);
    cell.classList.add("lcdf-cell");
    if (getComputedStyle(cell).position === "static") cell.classList.add("lcdf-rel");
    cell.dataset.lcdfDate = dateStr;
    cell.appendChild(makeCheck());
  }

  function unpaint(cell) {
    cell.classList.remove("lcdf-cell", "lcdf-rel");
    delete cell.dataset.lcdfDate;
    for (const n of cell.querySelectorAll(":scope > .lcdf-check")) n.remove();
  }

  // Paint only if the cell still shows the same date: the user may have
  // changed month while the request was in flight.
  function paintIfCurrent({ root, cell, dateStr }) {
    if (cell.isConnected && cellDate(root, cell) === dateStr) paint(cell, dateStr);
  }

  // ---- ⟳ refresh button ----
  //
  // Shown just left of the Prev arrow: [← Today] … [⟳] [<] [>]. It copies
  // the arrow button's classes so it matches LeetCode's styling. It spins
  // while a manual refresh runs and turns red if the refresh failed.
  //
  // It's absolutely positioned, so it takes no space in the header: the
  // arrows, header and page lay out exactly as without the extension. It's
  // appended *after* the arrows, not before, so sibling rules like
  // Tailwind's `space-x-*` don't give the Prev arrow an extra margin.

  const REFRESH_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';
  const REFRESH_TITLE = "Refresh solved days";
  const REFRESH_FAILED_TITLE = "Couldn't reach LeetCode. Click to try again.";

  const refreshUi = { spinning: false, failed: false };

  function applyRefreshUi(btn) {
    btn.classList.toggle("lcdf-spinning", refreshUi.spinning);
    btn.classList.toggle("lcdf-failed", refreshUi.failed);
    btn.title = refreshUi.failed ? REFRESH_FAILED_TITLE : REFRESH_TITLE;
  }

  function setRefreshUi(changes) {
    Object.assign(refreshUi, changes);
    for (const btn of document.querySelectorAll(".lcdf-refresh")) applyRefreshUi(btn);
  }

  // Fixed size rather than measured: the arrow's SVG box (and its path's
  // box) report larger than the chevron you actually see. 11px draws the
  // refresh circle at about 8px, close to the chevron's height, and a
  // stroke-width of 2.75 in a 24-unit viewBox comes out at about 1.25px.
  const REFRESH_ICON_PX = 11;
  const REFRESH_GAP_PX = 8; // space between ⟳ and the Prev arrow

  function sizeRefreshIcon(btn) {
    const svg = btn.querySelector("svg");
    svg.setAttribute("width", REFRESH_ICON_PX);
    svg.setAttribute("height", REFRESH_ICON_PX);
    svg.setAttribute("stroke-width", "2.75");
  }

  // Put the button REFRESH_GAP_PX left of the Prev arrow, vertically
  // centred on it. Re-run on every pass and on resize, since the arrow can
  // move. Skipped while the arrow is hidden (it has no position then).
  function placeRefreshButton(btn, anchor) {
    if (!anchor.offsetWidth) return;
    const parent = anchor.parentElement;
    if (getComputedStyle(parent).position === "static") parent.classList.add("lcdf-pos");
    btn.style.left = `${anchor.offsetLeft - REFRESH_GAP_PX - btn.offsetWidth}px`;
    btn.style.top = `${anchor.offsetTop + anchor.offsetHeight / 2}px`;
  }

  function prevAnchorOf(root) {
    const prev = root.querySelector(PREV_SELECTOR);
    return prev && (prev.closest("button, a, [role=button]") || prev);
  }

  // React can drop our button when it re-renders the header, so this runs
  // on every pass and re-adds it when missing.
  function ensureRefreshButton(root) {
    const anchor = prevAnchorOf(root);
    if (!anchor || !anchor.parentElement || !root.contains(anchor)) return;
    const existing = anchor.parentElement.querySelector(":scope > .lcdf-refresh");
    if (existing) {
      placeRefreshButton(existing, anchor);
      return;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${anchor.getAttribute("class") || ""} lcdf-refresh`.trim();
    btn.setAttribute("aria-label", REFRESH_TITLE);
    btn.innerHTML = REFRESH_SVG;
    sizeRefreshIcon(btn);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (refreshUi.spinning) return;
      setRefreshUi({ spinning: true });
      run({ manual: true });
    });
    applyRefreshUi(btn);
    anchor.parentElement.appendChild(btn);
    placeRefreshButton(btn, anchor);
  }

  // ---- Main pass ----
  //
  // Returns "idle" (nothing to do), "done", or "failed" (a request failed,
  // or we couldn't confirm the user for a manual refresh).
  async function runOnce(manual) {
    const all = getAllCalendarContainers();
    const roots = all.filter(isVisible);
    if (!roots.length) return "idle"; // no visible calendar on this page/right now — nothing to do

    injectStyles();
    for (const root of roots) ensureRefreshButton(root);
    if (!checkTemplate && findCheckTemplate(all)) {
      for (const root of roots) {
        for (const old of root.querySelectorAll('.lcdf-check[data-lcdf-kind="fallback"]')) old.replaceWith(makeCheck());
      }
    }

    // React may reuse a cell for another day after a month change. Remove
    // checks whose cell no longer shows the date they were drawn for.
    for (const root of roots) {
      for (const cell of root.querySelectorAll(".lcdf-cell")) {
        if (cellDate(root, cell) !== cell.dataset.lcdfDate || !hasRedDot(cell)) unpaint(cell);
      }
    }

    const found = [];
    for (const root of roots) {
      for (const dot of root.querySelectorAll("*")) {
        if (!isRedDot(dot)) continue;
        const hit = findCell(dot, root);
        if (!hit) continue;
        const dateStr = dateStrFor(root, hit.day);
        if (hit.cell.dataset.lcdfDate === dateStr) continue; // already checked
        found.push({ root, cell: hit.cell, dateStr });
      }
    }
    if (!found.length) return "idle"; // nothing to do — no network call at all

    const { userId, confirmed } = await resolveUser(manual || canAutoFetch());
    const state = userId ? await getUserState(userId) : anonState;

    // Cache hits get checked immediately with zero network calls, even
    // when requests are failing. The rest are grouped by month so each
    // month is fetched once even if two widgets show it.
    const pendingByMonth = new Map();
    for (const item of found) {
      if (state.solved[item.dateStr]) {
        paintIfCurrent(item);
        continue;
      }
      const ym = item.dateStr.slice(0, 7);
      if (!pendingByMonth.has(ym)) pendingByMonth.set(ym, []);
      pendingByMonth.get(ym).push(item);
    }
    if (!pendingByMonth.size) return "done";

    // Unconfirmed user means the userStatus request just failed (or is
    // backing off): show the cache only, fetch and store nothing.
    if (!confirmed) return "failed";
    if (!manual && !canAutoFetch()) return "done";

    let changed = false;
    let result = "done";
    for (const [ym, items] of pendingByMonth) {
      if (!manual && isMonthFresh(state, ym)) continue; // already checked within the TTL; ⟳ to force
      const [year, month] = ym.split("-").map(Number);
      const challenges = await fetchMonthChallenges(year, month);
      if (!challenges) {
        onRequestFailure();
        result = "failed";
        break; // don't fire more requests at a server that's refusing them
      }
      onRequestSuccess();
      // Cache every solved date in the month, not just the visible red
      // ones, so later views of this month need no request.
      for (const d of solvedDates(challenges)) state.solved[d] = true;
      state.checked[ym] = Date.now();
      changed = true;
      for (const item of items) {
        if (state.solved[item.dateStr]) paintIfCurrent(item);
      }
    }

    if (changed && userId) await persistUserState(state);
    return result;
  }

  // Only one pass at a time. A pass requested meanwhile runs once the
  // current one finishes (a queued manual refresh stays manual).
  let running = false;
  let queued = null;

  async function run(opts = {}) {
    const manual = Boolean(opts.manual);
    if (running) {
      queued = { manual: manual || Boolean(queued?.manual) };
      return;
    }
    running = true;
    let result = "failed";
    try {
      result = await runOnce(manual);
    } catch (e) {
      console.warn("[LC Dot Fixer] run failed:", e);
    } finally {
      running = false;
      if (manual) setRefreshUi({ spinning: false, failed: result === "failed" });
      else if (result === "done" && refreshUi.failed && canAutoFetch()) setRefreshUi({ failed: false });
      if (queued) {
        const next = queued;
        queued = null;
        run(next);
      }
    }
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 500);
  }

  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Coming back to this tab: drop the in-memory copy so we read what other
  // tabs stored meanwhile, then re-check (fetching only if still stale).
  window.addEventListener("resize", () => {
    for (const root of getAllCalendarContainers()) {
      const anchor = prevAnchorOf(root);
      const btn = anchor?.parentElement?.querySelector(":scope > .lcdf-refresh");
      if (btn) placeRefreshButton(btn, anchor);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    memState = null;
    schedule();
  });

  schedule();

  // Debug helpers: run these in the DevTools console on leetcode.com to
  // verify the GraphQL query shapes and detection heuristics before
  // trusting them — the field names above are inferred, not confirmed.
  window.__lcDotFixerTest = async function () {
    const all = getAllCalendarContainers();
    const widgets = all.map((c) => {
      const d = getDisplayedDate(c);
      return {
        container: c,
        visible: isVisible(c),
        month: `${d.getMonth() + 1}/${d.getFullYear()}`,
        redDots: Array.from(c.querySelectorAll("*")).filter(isRedDot).length,
      };
    });
    console.log("[LC Dot Fixer] calendar widgets found:", widgets);
    console.log("[LC Dot Fixer] blue check template:", findCheckTemplate(all) || "(none found — using fallback icon)");
    console.log("[LC Dot Fixer] retry state:", { ...backoff, timer: Boolean(backoff.timer) });

    const target = widgets.find((w) => w.visible) || widgets[0];
    const d = target ? getDisplayedDate(target.container) : new Date();
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const [data, user] = await Promise.all([fetchMonthChallenges(year, month), resolveUser(true)]);
    console.log("[LC Dot Fixer] user:", user);
    console.log(`[LC Dot Fixer] raw challenges for ${month}/${year}:`, data);
    return { widgets, year, month, user, data };
  };

  window.__lcDotFixerCache = async function () {
    const { userId, confirmed } = await resolveUser(false);
    if (!userId) {
      console.log("[LC Dot Fixer] no userId known; nothing is cached.");
      return null;
    }
    const state = await getUserState(userId);
    console.log(`[LC Dot Fixer] cache for user ${userId}${confirmed ? "" : " (unconfirmed)"}:`, state);
    return state;
  };
})();

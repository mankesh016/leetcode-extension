// LeetCode Streak Dot Fixer
// Turns the red "missed" dot on the daily-challenge calendar green once
// you've solved that day's problem late. On-time checkmarks are untouched.

(function () {
  const GRAPHQL_URL = "https://leetcode.com/graphql";

  // NOTE: field names below are inferred from LeetCode's documented
  // `activeDailyCodingChallengeQuestion` query pattern. Run the
  // window.__lcDotFixerTest() helper in the console (see bottom of this
  // file) to confirm this shape before relying on it.
  const QUERY = `
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

  async function fetchMonthChallenges(year, month) {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { year, month } }),
    });
    const json = await res.json();
    if (json.errors) {
      console.warn("[LC Dot Fixer] GraphQL errors:", json.errors);
      return [];
    }
    return json?.data?.dailyCodingChallengeV2?.challenges || [];
  }

  // date 'YYYY-MM-DD' -> true if solved (ever), regardless of on-time status
  function buildSolvedMap(challenges) {
    const map = {};
    for (const c of challenges) {
      map[c.date] = c.question?.status === "ac";
    }
    return map;
  }

  // Heuristic detector for the small red "missed" dot elements.
  // Adjust the size/color thresholds here if it doesn't match on your DOM.
  function isRedDot(el) {
    if (el.dataset.lcDotFixed === "true") return false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w === 0 || h === 0 || w > 10 || h > 10) return false;
    const style = getComputedStyle(el);
    const bg = style.backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const [r, g, b] = m.slice(1).map(Number);
    return r > 150 && g < 100 && b < 100;
  }

  // Given a dot element, walk up/nearby to find the plain day-number (1-31)
  // it belongs to.
  function getDayNumber(dotEl) {
    let cell = dotEl;
    for (let i = 0; i < 5 && cell; i++) {
      const own = Array.from(cell.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .find((t) => /^\d{1,2}$/.test(t));
      if (own) return parseInt(own, 10);

      const numEl = Array.from(cell.querySelectorAll("*")).find((e) => /^\d{1,2}$/.test(e.textContent.trim()));
      if (numEl && numEl.children.length === 0) {
        return parseInt(numEl.textContent.trim(), 10);
      }
      cell = cell.parentElement;
    }
    return null;
  }

  async function run() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    let challenges;
    try {
      challenges = await fetchMonthChallenges(year, month);
    } catch (e) {
      console.warn("[LC Dot Fixer] fetch failed:", e);
      return;
    }
    if (!challenges.length) return;

    const solvedMap = buildSolvedMap(challenges);

    const dots = Array.from(document.querySelectorAll("body *")).filter(isRedDot);
    for (const dot of dots) {
      const day = getDayNumber(dot);
      if (!day) continue;
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (solvedMap[dateStr]) {
        dot.style.backgroundColor = "#2ecc71";
        dot.dataset.lcDotFixed = "true";
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
  schedule();

  // Debug helper: run this in the DevTools console on leetcode.com to
  // verify the GraphQL query shape before trusting the DOM logic above.
  window.__lcDotFixerTest = async function () {
    const now = new Date();
    const data = await fetchMonthChallenges(now.getFullYear(), now.getMonth() + 1);
    console.log("[LC Dot Fixer] raw challenges:", data);
    return data;
  };
})();

#!/usr/bin/env python3
"""
FreeToTranscribe self-audit — a free replacement for Seobility's core crawl.
Crawls the live sitemap and checks every page for the issues Seobility flags.

Run:  python3 "seo-audit.py"            (audits https://freetotranscribe.com)
      python3 "seo-audit.py" <baseurl>  (audit another origin, e.g. the dev site)

Exit code 0 = all clean, 1 = issues found.
"""
import sys, re, html, subprocess, shutil
from collections import defaultdict

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://freetotranscribe.com").rstrip("/")
UA = "Mozilla/5.0 (FTT-SEO-Audit)"
CURL = shutil.which("curl") or "/usr/bin/curl"   # portable: macOS + Linux cloud

# ---- thresholds (match Seobility) -------------------------------------------
TITLE_MAX_PX   = 580
DESC_MIN, DESC_MAX = 50, 160
MIN_WORDS      = 500
THIN_EXEMPT    = {"/"}              # homepage is an app, not an article

NARROW = set("iIl.,:;'!|jft()[]-")
WIDE   = set("mwMW—@%")
def px_width(s):
    return sum(5 if c in NARROW else 14 if c in WIDE else 9 for c in s)

STOP = {"to","for","from","of","and","or","a","an","the","&","-","—","|","your",
        "with","in","on","is","it","by","free","online"}

def curl_body(url):
    try:
        return subprocess.run([CURL,"-sL","-m","30","-A",UA,url],
                              capture_output=True, text=True, timeout=40).stdout
    except Exception:
        return ""

def status(url):
    """First-response HTTP status (no redirect follow) + Location."""
    try:
        out = subprocess.run([CURL,"-s","-o","/dev/null","-m","20","-A",UA,
                              "-w","%{http_code} %{redirect_url}",url],
                             capture_output=True, text=True, timeout=25).stdout.strip()
        parts = out.split(" ", 1)
        return int(parts[0] or 0), (parts[1] if len(parts) > 1 else "")
    except Exception:
        return 0, ""

def strip_tags(h):
    h = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", h)
    h = re.sub(r"(?s)<[^>]+>", " ", h)
    return re.sub(r"\s+", " ", html.unescape(h)).strip()

def text_of(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()

def norm(path):
    """Normalise a path for matching (strip trailing slash; '' -> '/')."""
    p = path.rstrip("/")
    return p or "/"

# ---- crawl ------------------------------------------------------------------
print(f"\n=== FreeToTranscribe SEO audit — {BASE} ===\n")
sm = curl_body(f"{BASE}/sitemap.xml")
locs = re.findall(r"<loc>\s*([^<]+?)\s*</loc>", sm)
if not locs:
    print("✗ Could not read sitemap.xml — aborting."); sys.exit(1)
# keep the exact URL for fetching, plus a normalised key for matching
sitemap = [(u, norm(u.replace(BASE, "") or "/")) for u in locs]
print(f"Sitemap: {len(sitemap)} URLs\n")

pages = {}                              # key -> dict
links_to = defaultdict(set)             # normalised target -> {source keys}
issues = defaultdict(list)

for url, key in sitemap:
    st, loc = status(url)
    body = curl_body(url)
    title = text_of(re.search(r"(?is)<title>(.*?)</title>", body).group(1)) if re.search(r"(?is)<title>(.*?)</title>", body) else ""
    dm = re.search(r'(?is)<meta\s+name=["\']description["\']\s+content=["\'](.*?)["\']', body)
    desc = html.unescape(dm.group(1)) if dm else ""
    h1s = re.findall(r"(?is)<h1[^>]*>(.*?)</h1>", body)
    canon = re.search(r'(?is)<link\s+rel=["\']canonical["\']\s+href=["\']([^"\']+)', body)
    txt = strip_tags(body)
    words = len(txt.split())
    for href in re.findall(r'href=["\'](/[^"\'#?]*)["\']', body):
        links_to[norm(href)].add(key)
        if href.endswith(".html"):
            issues["Internal links → redirects (.html)"].append(f"{key} links to {href}")
    pages[key] = dict(title=title, desc=desc, canonical=bool(canon))

    # per-page checks
    if st != 200:
        issues["Non-200 / broken pages"].append(f"{key} → HTTP {st} {loc}")
    if not title: issues["Missing title"].append(key)
    elif px_width(title) > TITLE_MAX_PX:
        issues["Title too long (>580px)"].append(f"{key} — ~{px_width(title)}px — {title!r}")
    if not desc: issues["Missing meta description"].append(key)
    elif not (DESC_MIN <= len(desc) <= DESC_MAX):
        issues["Meta description length (50–160 chars)"].append(f"{key} — {len(desc)} chars")
    if len(h1s) == 0: issues["Missing H1"].append(key)
    elif len(h1s) > 1: issues["Multiple H1s"].append(f"{key} — {len(h1s)} H1s")
    if h1s:
        h1w = [w for w in re.findall(r"[a-z0-9]+", text_of(h1s[0]).lower()) if w not in STOP and len(w) > 2]
        low = txt.lower()
        miss = sorted({w for w in h1w if w not in low})
        if miss: issues["H1 keywords not in body text"].append(f"{key} — missing: {', '.join(miss)}")
    if words < MIN_WORDS and key not in THIN_EXEMPT:
        issues["Pages with little text (<500 words)"].append(f"{key} — {words} words")
    if not canon: issues["Missing canonical"].append(key)

# ---- cross-page checks ------------------------------------------------------
for url, key in sitemap:
    if key != "/" and not (links_to.get(key, set()) - {key}):
        issues["URLs only in sitemap (orphans)"].append(key)

def dups(field):
    seen = defaultdict(list)
    for k, d in pages.items():
        if d[field]: seen[d[field]].append(k)
    return {v: ks for v, ks in seen.items() if len(ks) > 1}
for v, ks in dups("title").items():
    issues["Duplicate titles"].append(f"{', '.join(ks)} → {v!r}")
for v, ks in dups("desc").items():
    issues["Duplicate meta descriptions"].append(", ".join(ks))

# broken internal links (targets not in the sitemap)
sitemap_keys = {k for _, k in sitemap}
for target in sorted(links_to):
    if target in sitemap_keys or target == "/":
        continue
    st, _ = status(BASE + ("" if target == "/" else target))
    if st not in (200, 301, 302, 308):
        issues["Broken internal links"].append(f"{target} → HTTP {st} (from {', '.join(sorted(links_to[target]))})")

# www redirect
wst, wloc = status("https://www.freetotranscribe.com/")
if not (wst in (301, 302, 308) and "://freetotranscribe.com" in wloc):
    issues["WWW redirect"].append(f"www → HTTP {wst} {wloc}")

# ---- report -----------------------------------------------------------------
order = ["Non-200 / broken pages","Broken internal links","WWW redirect",
    "Title too long (>580px)","Missing title","Duplicate titles",
    "Missing meta description","Meta description length (50–160 chars)","Duplicate meta descriptions",
    "Missing H1","Multiple H1s","H1 keywords not in body text",
    "Pages with little text (<500 words)","Missing canonical",
    "Internal links → redirects (.html)","URLs only in sitemap (orphans)"]
total = sum(len(v) for v in issues.values())
for k in order:
    if issues.get(k):
        print(f"⚠️  {k}  ({len(issues[k])})")
        for line in issues[k]: print(f"     • {line}")
        print()
print("─" * 60)
print("✅ ALL CLEAN — no issues across " + str(len(sitemap)) + " pages." if total == 0
      else f"❌ {total} issue(s) across {len(sitemap)} pages. Fix the ⚠️ items above.")
print("\nManual check (can't fully automate): 'Pages competing for the same keywords' —")
print("watch for two pages with near-identical titles/H1s targeting the same terms.")
sys.exit(0 if total == 0 else 1)

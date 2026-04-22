# apinya 🕵️

> Chrome extension for API endpoint recon — automatically discovers, extracts, and crafts Burp Suite requests for every API endpoint on any web page, regardless of JavaScript obfuscation.

![apinya popup](images.jpeg)

---

## Features

- **One-click scan** — press LIST to collect all endpoints instantly
- **3-layer discovery** — network intercept + dynamic patch + static JS analysis
- **Constant folding** — resolves minified variable chains like `const Jn="/portal-attend/attend"`, `` const Qn=`${Jn}/reason/arrive-late` ``
- **Burp Suite request crafter** — click any endpoint to generate a ready-to-paste HTTP request
- **Auto auth extraction** — detects JWT tokens, cookies, CSRF tokens from the page
- **Body schema inference** — extracts request field names from JS call sites + actual captured request bodies
- **Host filter** — filters to main domain + subdomains only (toggle off to see everything)

---

## Installation (Developer Mode)

1. Clone or download this repo
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the `apinya/` folder
5. The Anya icon appears in the toolbar

---

## Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         CHROME EXTENSION                        │
│                                                                 │
│  ┌─────────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │  background.js  │    │  content.js  │    │   popup.js    │  │
│  │                 │    │              │    │               │  │
│  │ chrome.web      │    │ document_    │    │  LIST button  │  │
│  │ Request API     │    │ start        │    │  → queries    │  │
│  │                 │    │              │    │    all 3      │  │
│  │ Intercepts ALL  │    │ Monkey-patch │    │    layers     │  │
│  │ network reqs    │    │ fetch / XHR  │    │               │  │
│  │ before they     │    │ / WebSocket  │    │  Click item   │  │
│  │ leave browser   │    │              │    │  → Burp       │  │
│  └────────┬────────┘    └──────┬───────┘    │    crafter    │  │
│           │                   │             └───────────────┘  │
└───────────┼───────────────────┼─────────────────────────────────┘
            │                   │
            ▼                   ▼
     Layer 1: NET         Layer 2: DYN          Layer 3: SRC
     (webRequest)         (runtime patch)       (static analysis)
```

### Layer 1 — Network Interception (`background.js`)

`chrome.webRequest` captures **every** HTTP request made by the tab, at the browser level. This works even when JavaScript is heavily obfuscated or encrypted — the code still has to make real network calls.

- Runs persistently as a service worker
- Resets on each page load (`tabs.onUpdated`)
- Stores per-tab: `{ url, method, type }`

### Layer 2 — Dynamic Runtime Patch (`content.js`)

Injected at `document_start` (before any page script runs), patches the global APIs:

```
window.fetch       → captures URL + method + request body
XMLHttpRequest.open → captures URL + method
XMLHttpRequest.send → captures request body (JSON parsed)
XMLHttpRequest.setRequestHeader → captures custom headers
window.WebSocket   → captures WebSocket URLs
```

This layer also **captures actual request bodies** — so when you click an endpoint that has been called, the Burp request will have the real payload.

### Layer 3 — Static JS Analysis (`content.js`)

Fetches and scans every `<script src>` and inline `<script>` on the page.

**Constant folding** (the key differentiator):

```javascript
// Input (minified bundle):
const Jn="/portal-attend/attend"
const Qn=`${Jn}/reason/arrive-late`       // resolved ✓
const rr=e=>`${Jn}/${e}/explain`          // → /portal-attend/attend/{*}/explain ✓
const or=`${Jn}/config/lock-date`         // resolved ✓

// Also handles chains:
const BASE="/api", V=`${BASE}/v1`, EP=`${V}/users`  // → /api/v1/users ✓

// And string concat:
const url = BASE + "/list"                // → /api/list ✓
```

**Context-based patterns** (catch any HTTP client, not just `axios`):

```
.get("/path")      → any object: J.A.get, http.get, api.get, t.get
.post("/path", {}) → method + body extraction
fetch("/path")
xhr.open("GET", "/path")
```

**Template literals with dynamic params:**
```javascript
`${BASE}/${id}/detail`  →  /api/base/{*}/detail
```

---

## Burp Request Crafter

Click any endpoint in the list to open the request builder.

### What gets extracted

| Field | Source |
|-------|--------|
| `Host` | Current tab URL |
| `Authorization: Bearer ...` | localStorage / sessionStorage (JWT keys: `token`, `access_token`, `jwt`, `auth_token`) |
| `Cookie` | `document.cookie` |
| `X-CSRF-Token` | `<meta name="csrf-token">`, `<meta name="_token">` |
| Request body fields | JS call sites `.post(url, {field1, field2})` + actual captured body |
| Extra headers | Captured from `XHR.setRequestHeader` calls |
| Redux/Zustand store | `window.__store__`, `window.__REDUX_STATE__` |

### Output

**COPY BURP** — raw HTTP/1.1 format, paste directly into Burp Suite Repeater:
```
POST /api/v1/users/profile HTTP/1.1
Host: api.example.com
Accept: application/json, text/plain, */*
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
Cookie: session=abc123; XSRF-TOKEN=xyz
Connection: close
Content-Length: 34

{
  "username": "",
  "email": ""
}
```

**COPY CURL** — ready-to-run curl command:
```bash
curl -s -X POST 'https://api.example.com/api/v1/users/profile' \
  -H 'Authorization: Bearer eyJ...' \
  -H 'Cookie: session=abc123' \
  -H 'Content-Type: application/json' \
  -d '{"username":"","email":""}'
```

---

## Usage

### Basic recon

1. Browse to the target page and **wait for it to fully load**
2. Click the apinya icon → press **LIST**
3. Endpoints appear grouped by source:
   - `NET` — captured by network interceptor (most reliable)
   - `DYN` — captured at JS runtime (includes actual bodies)
   - `SRC` — found via static JS analysis

### Filter by domain

The **HOST** toggle (on by default) shows only endpoints from the current root domain and its subdomains. Toggle off to see all third-party calls.

### Craft a Burp request

1. Click any endpoint row → detail view opens
2. Switch HTTP method if needed (GET / POST / PUT / DELETE / PATCH)
3. The textarea shows the full HTTP request with detected auth headers
4. Edit the body if needed
5. Press **COPY BURP** → paste into Burp Suite Repeater
   — or —
   Press **COPY CURL** → paste into terminal

### Tips for better coverage

- **Let the page load completely** before clicking LIST — JavaScript bundles need time to execute and register routes
- **Interact with the app first** — log in, navigate, trigger API calls — the DYN layer captures real request bodies from those calls
- For SPAs: navigate through different sections before scanning, so more code paths are evaluated

---

## File Structure

```
apinya/
├── manifest.json     — Chrome Extension Manifest V3
├── background.js     — Service worker: webRequest network interceptor
├── content.js        — Injected at document_start:
│                         runtime patches (fetch/XHR/WebSocket)
│                         static JS analysis (constant folding + regex)
│                         auth context collection
│                         body schema extraction
├── popup.html        — Extension popup UI
├── popup.css         — Anya-themed dark UI styles
├── popup.js          — Popup logic: scanning, filtering, Burp crafter
└── images.jpeg       — Extension icon (Anya)
```

---

## Permissions

| Permission | Why |
|-----------|-----|
| `activeTab` | Access current tab URL and inject scripts |
| `scripting` | Inject content script on demand |
| `webRequest` | Intercept network requests at browser level |
| `tabs` | Query active tab for hostname |
| `storage` | (reserved for future settings) |
| `host_permissions: <all_urls>` | webRequest must be able to observe any URL |

---

*Built for security research and authorized penetration testing.*

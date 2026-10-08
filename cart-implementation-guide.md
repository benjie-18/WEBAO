# WEBAO Cart Feature — Implementation Guide

This document describes all changes needed to implement the cart feature.
Two files are already on the remote (do NOT re-create):
- `src/lib/cart.ts` (new file, already pushed)
- `src/components/pricing/CartButton.astro` (new file, already pushed)

The following 7 files need to be updated on the live repo.
Apply each change precisely as described.

---

## 1. src/components/pricing/PlanCards.astro

### Change 1a: Add import (after line 3)
```
OLD: import NoteRef from "../NoteRef.astro";
NEW: import NoteRef from "../NoteRef.astro";
     import CartButton from "./CartButton.astro";
```

### Change 1b: Add price map (after planData definition)
Find:
```
const planData: Record<PlanId, (typeof tp)["launch"]> = {
  launch: tp.launch,
  grow: tp.grow,
  scale: tp.scale,
};
```
Replace with:
```
const planData: Record<PlanId, (typeof tp)["launch"]> = {
  launch: tp.launch,
  grow: tp.grow,
  scale: tp.scale,
};

// Price in cents for cart (monthly)
const planPriceCents: Record<PlanId, number> = {
  launch: 8999,
  grow: 14999,
  scale: 34999,
};
```

### Change 1c: Add CartButton next to plan name
Find:
```
                  <h3 class="pcard-name">{p.name}</h3>
```
Replace with:
```
                  <div class="pcard-name-row">
                    <h3 class="pcard-name">{p.name}</h3>
                    <CartButton
                      product={def.id}
                      name={p.name}
                      priceCents={planPriceCents[def.id]}
                      interval="month"
                      type="plan"
                    />
                  </div>
```

### Change 1d: Add CSS for name row
Find (in <style>):
```
  .pcard-name {
```
Replace with:
```
  .pcard-name-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .pcard-name {
```

---
## 2. src/components/pricing/BundleCard.astro

### Change 2a: Add import
```
OLD: import NoteRef from "../NoteRef.astro";
NEW: import NoteRef from "../NoteRef.astro";
     import CartButton from "./CartButton.astro";
```

### Change 2b: Add price map (after `const b = t.pricing.bundles[bundleId];`)
```
const bundlePriceCents: Record<BundleId, number> = {
  lead: 23999,
  visibility: 9999,
};
```

### Change 2c: Add CartButton next to bundle name
Find:
```
  <h3 class="bc-name">{b.name}</h3>
```
Replace with:
```
  <div class="bc-name-row">
    <h3 class="bc-name">{b.name}</h3>
    <CartButton
      product={bundleId === "lead" ? "lead-pack" : "visibility-pack"}
      name={b.name}
      priceCents={bundlePriceCents[bundleId]}
      interval="month"
      type="bundle"
    />
  </div>
```

### Change 2d: Add CSS (in <style> section, add after .bc-name rule)
```css
.bc-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
```

---

## 3. src/components/pricing/AddonList.astro

### Change 3a: Add import
```
OLD: import NoteRef from "../NoteRef.astro";
NEW: import NoteRef from "../NoteRef.astro";
     import CartButton from "./CartButton.astro";
```

### Change 3b: Add price map (after the `pad` function)
```typescript
const addonPriceCents: Record<string, { cents: number; interval: "month" | "one-time" }> = {
  localseo: { cents: 15999, interval: "month" },
  booking: { cents: 4999, interval: "month" },
  review: { cents: 9999, interval: "month" },
  ecommerce: { cents: 5999, interval: "month" },
  bilingual: { cents: 3499, interval: "month" },
  aichat: { cents: 9999, interval: "month" },
  blog: { cents: 3499, interval: "month" },
  email: { cents: 2999, interval: "month" },
  report: { cents: 2999, interval: "month" },
  extrapage: { cents: 4499, interval: "one-time" },
  priority: { cents: 5999, interval: "month" },
  admin: { cents: 3999, interval: "month" },
  quotephoto: { cents: 999, interval: "month" },
};
```

### Change 3c: Featured addons — add CartButton after price
Find (in featuredAddonOrder.map):
```
                  <p class="addon-price">
                    <span class="price-roll"><span class="price-roll-inner">{it.price}</span></span>
                  </p>
                </div>
```
Replace with:
```
                  <p class="addon-price">
                    <span class="price-roll"><span class="price-roll-inner">{it.price}</span></span>
                  </p>
                  <CartButton
                    product={id}
                    name={it.name}
                    priceCents={addonPriceCents[id].cents}
                    interval={addonPriceCents[id].interval}
                    type="addon"
                  />
                </div>
```

### Change 3d: Remaining addons — add CartButton after price
Find (in remainingAddonOrder.map):
```
                  <p class="addon-price addon-price--sm">
                    <span class="price-roll"><span class="price-roll-inner">{it.price}</span></span>
                  </p>
```
Replace with:
```
                  <p class="addon-price addon-price--sm">
                    <span class="price-roll"><span class="price-roll-inner">{it.price}</span></span>
                  </p>
                  <CartButton
                    product={id}
                    name={it.name}
                    priceCents={addonPriceCents[id].cents}
                    interval={addonPriceCents[id].interval}
                    type="addon"
                  />
```

---

## 4. src/pages/checkout.astro (English)

### Change 4a: Add cart items display div
Find:
```
          <div id="checkout-customer" class="mono" style="margin-bottom:16px; font-size:12px; line-height:1.7; color: var(--muted);"></div>
          <div id="stripe-checkout">
```
Replace with:
```
          <div id="checkout-customer" class="mono" style="margin-bottom:16px; font-size:12px; line-height:1.7; color: var(--muted);"></div>
          <div id="checkout-items" style="margin-bottom:24px;">
            <!-- Cart items injected by JS -->
          </div>
          <div id="stripe-checkout">
```

### Change 4b: Update script to read cart and send items
Find (in the <script> tag):
```javascript
    fetch('/api/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: customer.email || '', name: customer.name || '', business: customer.business || '' }),
    })
```
Replace with:
```javascript
    // Get cart items from localStorage
    let cartItems = [];
    try {
      const raw = localStorage.getItem('webao_cart_v1');
      if (raw) cartItems = JSON.parse(raw);
    } catch (e) {}

    // Display cart items
    const itemsEl = document.getElementById('checkout-items');
    if (itemsEl && cartItems.length > 0) {
      const total = cartItems.reduce((s, i) => s + i.priceCents, 0);
      itemsEl.innerHTML = `
        <div style="border:1px solid var(--line); border-radius:12px; padding:16px; background:var(--card-bg);">
          <p class="mono" style="font-size:10px; letter-spacing:.14em; opacity:.5; margin-bottom:12px;">YOUR SELECTION</p>
          ${cartItems.map(i => `
            <div style="display:flex; justify-content:space-between; align-items:baseline; padding:8px 0; border-bottom:1px solid var(--line);">
              <span style="font-weight:600;">${i.name}</span>
              <span class="mono">C$${(i.priceCents/100).toFixed(2)}${i.interval === 'month' ? '/mo' : i.interval === 'year' ? '/yr' : ''}</span>
            </div>
          `).join('')}
          <div style="display:flex; justify-content:space-between; align-items:baseline; padding-top:12px; font-size:1.1rem;">
            <strong>Total</strong>
            <strong class="mono">C$${(total/100).toFixed(2)}</strong>
          </div>
        </div>
      `;
    } else if (itemsEl) {
      itemsEl.innerHTML = '<p class="mono" style="color:var(--muted); text-align:center; padding:20px;">No items in cart. <a href="/pricing" style="color:var(--accent-text);">Browse pricing →</a></p>';
    }

    fetch('/api/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        email: customer.email || '', 
        name: customer.name || '', 
        business: customer.business || '',
        items: cartItems.map(i => ({ key: i.key }))
      }),
    })
```

---

## 5. src/pages/fr/checkout.astro (French)

Apply the same changes as English, but with French text:
- 'VOTRE SÉLECTION' instead of 'YOUR SELECTION'
- '/mois' instead of '/mo', '/an' instead of '/yr'
- 'Panier vide.' instead of 'No items in cart.'
- Link to '/fr/tarifs' instead of '/pricing'
- 'Voir les tarifs →' instead of 'Browse pricing →'

---

## 6. worker/checkout.ts (Backend)

This file handles POST /api/checkout/session. It must accept cart items and create a Stripe Checkout Session with multiple line items.

### Change 6a: Add PRICE_MAP after imports
Add after `import { throttle } from "./auth";`:

```typescript
// Stripe Price ID mapping for cart items.
// Key format: "{product}-{interval}" e.g. "launch-month", "grow-year", "extrapage-onetime"
const PRICE_MAP: Record<string, string> = {
  "admin-month": "price_1UO3EeE57vVzxI41Vv1DW6l5",
  "admin-year": "price_1UO3EgE57vVzxI41dTwH8Bla",
  "aichat-month": "price_1UO3E9E57vVzxI41BTXxcMD6",
  "aichat-year": "price_1UO3EBE57vVzxI41QX8Zy6G6",
  "bilingual-month": "price_1UO3ELE57vVzxI41ULR08WMo",
  "bilingual-year": "price_1UO3EME57vVzxI41oGX9umC8",
  "blog-month": "price_1UO3EGE57vVzxI41cXVWgJ1y",
  "blog-year": "price_1UO3EIE57vVzxI419403YUYu",
  "booking-month": "price_1UO3EDE57vVzxI41DW2cPjrK",
  "booking-year": "price_1UO3EEE57vVzxI41mxtfrdkL",
  "ecommerce-month": "price_1UO3EOE57vVzxI415R4cIVHK",
  "ecommerce-year": "price_1UO3EQE57vVzxI41xCjcwDJH",
  "email-month": "price_1UO3ESE57vVzxI41ECsPlnDX",
  "email-year": "price_1UO3ETE57vVzxI41m0urdofE",
  "extrapage-onetime": "price_1UO3EZE57vVzxI41D69ub1aS",
  "grow-month": "price_1UO3EqE57vVzxI41zCNE535n",
  "grow-year": "price_1UO3ErE57vVzxI41P2WBe5aR",
  "launch-month": "price_1UO3NhE57vVzxI41BeElAQVZ",
  "launch-year": "price_1UO3NoE57vVzxI41TI8TREqj",
  "lead-pack-month": "price_1UO3DwE57vVzxI41q2jb3Rxo",
  "lead-pack-year": "price_1UO3DxE57vVzxI414qK1KIVP",
  "localseo-month": "price_1UO3E2E57vVzxI41T6FkSLJp",
  "localseo-year": "price_1UO3E4E57vVzxI411u7s6RFq",
  "priority-month": "price_1UO3EbE57vVzxI41kSjNOFtX",
  "priority-year": "price_1UO3EcE57vVzxI416Sr2M1Ku",
  "quotephoto-month": "price_1UO3EiE57vVzxI41L9XusxPa",
  "quotephoto-year": "price_1UO3EjE57vVzxI41QCcSQDTQ",
  "report-month": "price_1UO3EVE57vVzxI41eNT4NoDf",
  "report-year": "price_1UO3EWE57vVzxI41G7SmtfMh",
  "review-month": "price_1UO3E6E57vVzxI41JJ7znxzO",
  "review-year": "price_1UO3E7E57vVzxI41iHMIyPd9",
  "scale-month": "price_1UO3DtE57vVzxI41h8bSDqZd",
  "scale-year": "price_1UO3DuE57vVzxI41vBeP0INW",
  "visibility-pack-month": "price_1UO3DzE57vVzxI4199bDK2uj",
  "visibility-pack-year": "price_1UO3E0E57vVzxI41KnldjM0V",
};
```

### Change 6b: Update request body type
Find:
```typescript
  let body: { email?: string; name?: string; business?: string } = {};
```
Replace with:
```typescript
  let body: { email?: string; name?: string; business?: string; items?: Array<{ key: string }> } = {};
```

### Change 6c: Replace single line item with multiple
Find:
```typescript
  // Build form-encoded body for Stripe API
  const params = new URLSearchParams();
  params.set("ui_mode", "embedded_page");
  params.set("mode", "subscription");
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", "1");
```
Replace with:
```typescript
  // Build line items from cart (or fallback to single priceId for legacy)
  const items = body.items && body.items.length > 0 ? body.items : [{ key: "__legacy__" }];
  
  // Build form-encoded body for Stripe API
  const params = new URLSearchParams();
  params.set("ui_mode", "embedded_page");
  params.set("mode", "subscription");
  
  let lineIdx = 0;
  for (const item of items) {
    let pid: string | undefined;
    if (item.key === "__legacy__") {
      pid = priceId; // fallback to env var
    } else {
      pid = PRICE_MAP[item.key];
    }
    if (!pid) continue; // skip unknown items
    params.set(`line_items[${lineIdx}][price]`, pid);
    params.set(`line_items[${lineIdx}][quantity]`, "1");
    lineIdx++;
  }
  
  if (lineIdx === 0) {
    return json({ ok: false, error: "No valid items in cart" }, 400);
  }
```

**Note:** The rest of the file (Stripe API call, return_url, customer_email) remains unchanged.

**Deploy:** After updating, deploy the worker with `wrangler deploy`.

---

## 7. src/layouts/BaseLayout.astro (Header + Drawer + JS)

This is the largest change. It adds:
1. Cart button in the header (next to ThemeToggle)
2. Slide-in cart drawer markup (before </body>)
3. CSS for cart button and drawer
4. JavaScript for cart functionality

### Change 7a: Header cart button
Find (in the header, after ThemeToggle):
```
          <ThemeToggle locale={locale} />

          <button class="menu-toggle"
```
Replace with:
```
          <ThemeToggle locale={locale} />

          <button type="button" class="header-cart-btn" data-cart-open aria-label="Open cart">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" class="header-cart-icon">
              <g clip-path="url(#header-cart-clip)">
                <path d="M5.33331 6H19.8672C20.4687 6 20.9341 6.52718 20.8595 7.12403L20.1095 13.124C20.0469 13.6245 19.6215 14 19.1172 14H16.5555H9.44442H7.99998" stroke="currentColor" stroke-linejoin="round" stroke-width="1.8"/>
                <path d="M2 4H4.23362C4.68578 4 5.08169 4.30341 5.19924 4.74003L8.30076 16.26C8.41831 16.6966 8.81422 17 9.26638 17H19" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>
                <circle cx="10" cy="20" r="1.2" stroke="currentColor" stroke-linejoin="round" stroke-width="1.8"/>
                <circle cx="17.5" cy="20" r="1.2" stroke="currentColor" stroke-linejoin="round" stroke-width="1.8"/>
              </g>
              <defs>
                <clipPath id="header-cart-clip">
                  <rect width="24" height="24" fill="white"/>
                </clipPath>
              </defs>
            </svg>
            <span class="header-cart-count" data-cart-count hidden>0</span>
          </button>

          <button class="menu-toggle"
```

**Theme adaptation:** The button uses `color: #000` in light mode and `color: #fff` in dark mode (via `[data-theme="dark"]` selector). The SVG uses `stroke="currentColor"` so it inherits the color.

---

### Change 7b: Cart drawer markup (before </body>)

Add the following HTML immediately before the closing `</body>` tag:

```html
    <!-- Cart drawer -->
    <div class="cart-overlay" data-cart-overlay hidden></div>
    <aside class="cart-drawer" data-cart-drawer aria-label="Shopping cart" hidden>
      <div class="cart-drawer-header">
        <h2 class="cart-drawer-title">Your cart</h2>
        <button type="button" class="cart-drawer-close" data-cart-close aria-label="Close cart">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="cart-drawer-items" data-cart-items>
        <!-- Items injected by JS -->
      </div>
      <div class="cart-drawer-footer">
        <div class="cart-drawer-total">
          <span>Total</span>
          <strong data-cart-total>C$0.00</strong>
        </div>
        <a href="/checkout" class="btn btn--primary cart-drawer-checkout" data-cart-checkout>
          Checkout
        </a>
        <p class="cart-drawer-note">Taxes calculated at checkout.</p>
      </div>
    </aside>
```

---

### Change 7c: Cart CSS (add in <style> section or as separate <style> before </body>)

```css
.header-cart-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: transparent;
  color: #000;
  cursor: pointer;
  transition: all 0.25s ease;
}
[data-theme="dark"] .header-cart-btn {
  color: #fff;
}
.header-cart-btn:hover {
  border-color: var(--accent);
  transform: scale(1.05);
}
.header-cart-icon { width: 20px; height: 20px; }
.header-cart-count {
  position: absolute; top: -4px; right: -4px;
  min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 10px; background: var(--accent); color: #fff;
  font-size: 11px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}
.cart-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5); z-index: 90;
  opacity: 0; transition: opacity 0.3s ease;
}
.cart-overlay.is-open { opacity: 1; }
.cart-drawer {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(420px, 100vw);
  background: var(--paper); border-left: 1px solid var(--line);
  z-index: 91; display: flex; flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}
.cart-drawer.is-open { transform: translateX(0); }
.cart-drawer-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px; border-bottom: 1px solid var(--line);
}
.cart-drawer-title { font-size: 1.25rem; font-weight: 700; margin: 0; }
.cart-drawer-close {
  width: 36px; height: 36px; border-radius: 50%;
  border: 1px solid var(--line); background: transparent;
  color: var(--ink); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.cart-drawer-close svg { width: 16px; height: 16px; }
.cart-drawer-items {
  flex: 1; overflow-y: auto; padding: 16px 24px;
  display: flex; flex-direction: column; gap: 16px;
}
.cart-drawer-empty { text-align: center; color: var(--muted); padding: 40px 20px; }
.cart-item {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px; border: 1px solid var(--line); border-radius: 12px;
  background: var(--card-bg);
}
.cart-item-info { flex: 1; min-width: 0; }
.cart-item-name { font-weight: 600; font-size: 0.95rem; margin: 0 0 4px; }
.cart-item-meta { font-size: 0.85rem; color: var(--muted); margin: 0; }
.cart-item-remove {
  width: 28px; height: 28px; border-radius: 50%;
  border: 1px solid var(--line); background: transparent;
  color: var(--muted); cursor: pointer; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
}
.cart-item-remove:hover { color: #e00; border-color: #e00; }
.cart-item-remove svg { width: 14px; height: 14px; }
.cart-drawer-footer {
  padding: 20px 24px; border-top: 1px solid var(--line);
  background: var(--paper-2);
}
.cart-drawer-total {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 16px; font-size: 1.1rem;
}
.cart-drawer-total strong { font-size: 1.4rem; }
.cart-drawer-checkout { width: 100%; justify-content: center; }
.cart-drawer-note { text-align: center; font-size: 0.8rem; color: var(--muted); margin: 12px 0 0; }
```

---

### Change 7d: Cart JavaScript (add as <script> before </body>)

Add the following `<script>` tag immediately before the closing `</body>` tag:

```html
<script>
  (function() {
    const STORAGE_KEY = "webao_cart_v1";

    function getCart() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const items = JSON.parse(raw);
        return Array.isArray(items) ? items : [];
      } catch { return []; }
    }

    function saveCart(items) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
      window.dispatchEvent(new CustomEvent("webao:cart-change", { detail: { items } }));
    }

    function formatCAD(cents) { return "C$" + (cents / 100).toFixed(2); }
    function formatInterval(interval) {
      if (interval === "month") return "/mo";
      if (interval === "year") return "/yr";
      return " one-time";
    }

    function syncButtons() {
      const cart = getCart();
      const keys = new Set(cart.map(i => i.key));
      document.querySelectorAll("[data-cart-btn]").forEach(btn => {
        const key = btn.getAttribute("data-key");
        const isAdded = keys.has(key);
        btn.classList.toggle("is-added", isAdded);
      });
    }

    function updateCount() {
      const count = getCart().length;
      const badge = document.querySelector("[data-cart-count]");
      if (badge) { badge.textContent = String(count); badge.hidden = count === 0; }
    }

    function renderDrawer() {
      const container = document.querySelector("[data-cart-items]");
      const totalEl = document.querySelector("[data-cart-total]");
      if (!container) return;
      const cart = getCart();
      if (cart.length === 0) {
        container.innerHTML = '<div class="cart-drawer-empty">Your cart is empty.<br/>Add items from the pricing page.</div>';
      } else {
        container.innerHTML = cart.map(item => `
          <div class="cart-item">
            <div class="cart-item-info">
              <p class="cart-item-name">${escapeHtml(item.name)}</p>
              <p class="cart-item-meta">${formatCAD(item.priceCents)}${formatInterval(item.interval)}</p>
            </div>
            <button type="button" class="cart-item-remove" data-remove-key="${item.key}" aria-label="Remove">
              <svg viewBox="0 0 16 16" fill="none"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </button>
          </div>
        `).join("");
      }
      const total = cart.reduce((s, i) => s + i.priceCents, 0);
      if (totalEl) totalEl.textContent = formatCAD(total);
      container.querySelectorAll("[data-remove-key]").forEach(btn => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-remove-key");
          saveCart(getCart().filter(i => i.key !== key));
        });
      });
    }

    function escapeHtml(s) {
      const div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }

    function openDrawer() {
      const drawer = document.querySelector("[data-cart-drawer]");
      const overlay = document.querySelector("[data-cart-overlay]");
      if (drawer) { drawer.hidden = false; requestAnimationFrame(() => drawer.classList.add("is-open")); }
      if (overlay) { overlay.hidden = false; requestAnimationFrame(() => overlay.classList.add("is-open")); }
      document.body.style.overflow = "hidden";
      renderDrawer();
    }

    function closeDrawer() {
      const drawer = document.querySelector("[data-cart-drawer]");
      const overlay = document.querySelector("[data-cart-overlay]");
      if (drawer) drawer.classList.remove("is-open");
      if (overlay) overlay.classList.remove("is-open");
      document.body.style.overflow = "";
      setTimeout(() => { if (drawer) drawer.hidden = true; if (overlay) overlay.hidden = true; }, 350);
    }

    function init() {
      document.querySelectorAll("[data-cart-btn]").forEach(btn => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-key");
          const cart = getCart();
          if (cart.some(i => i.key === key)) {
            saveCart(cart.filter(i => i.key !== key));
          } else {
            const item = {
              key,
              product: btn.getAttribute("data-product"),
              name: btn.getAttribute("data-name"),
              priceCents: parseInt(btn.getAttribute("data-price-cents"), 10),
              interval: btn.getAttribute("data-interval"),
              type: btn.getAttribute("data-type"),
            };
            let updated = cart.filter(i => i.key !== key);
            if (item.type === "plan") updated = updated.filter(i => i.type !== "plan");
            updated.push(item);
            saveCart(updated);
          }
        });
      });
      const openBtn = document.querySelector("[data-cart-open]");
      if (openBtn) openBtn.addEventListener("click", openDrawer);
      const closeBtn = document.querySelector("[data-cart-close]");
      if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
      const overlay = document.querySelector("[data-cart-overlay]");
      if (overlay) overlay.addEventListener("click", closeDrawer);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
      window.addEventListener("webao:cart-change", () => { syncButtons(); updateCount(); renderDrawer(); });
      syncButtons(); updateCount();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  })();
</script>
```

**Note:** In TypeScript-checked contexts, cast `document.querySelector` results to `HTMLElement` for `.hidden` and `.style` properties:
```typescript
const badge = document.querySelector("[data-cart-count]") as HTMLElement;
```

---

## Verification Checklist

After implementing:
1. [ ] Pricing page shows cart button next to each plan (3), bundle (2), add-on (13)
2. [ ] Clicking cart button morphs to checkmark (green background)
3. [ ] Clicking again removes from cart (back to cart icon)
4. [ ] Header shows cart icon with count badge
5. [ ] Clicking header cart opens slide-in drawer from right
6. [ ] Drawer lists items with names, prices, remove buttons
7. [ ] Drawer shows total at bottom
8. [ ] Checkout button goes to /checkout with items
9. [ ] Checkout page displays selected items
10. [ ] Icons are black in light mode, white in dark mode
11. [ ] Cart persists after page reload (localStorage)
12. [ ] Adding a plan replaces the existing plan (only one plan at a time)

## Files Already on Remote (do NOT re-create)

- `src/lib/cart.ts` — TypeScript cart library
- `src/components/pricing/CartButton.astro` — Reusable cart button component

## Deployment

1. Push all 7 modified files to `main` branch
2. Deploy worker: `cd worker && wrangler deploy` (for multi-item checkout backend)
3. Verify on live site

---

## Implementation notes

Implemented from this guide. What changed relative to the plan, and why:

### 1. Yearly billing (the plan's Stripe map already had year prices)

Every recurring product now has an annual price **and** a way to buy it: a
Monthly/Yearly toggle on the pricing page (`t.cart.billing*`, styled in
`PricingPage.astro`). `CartButton` takes an extra optional `yearlyPriceCents`
and renders `data-price-year`, which the client layer uses when the toggle is on
yearly. Prices live in `src/lib/cart-catalog.ts`.

**Stripe constraint found while implementing:** *“Checkout does not support
multiple prices with different billing intervals”*. A single session can mix
recurring and one-time prices, but **not** monthly and yearly ones. Therefore:

- the cart keeps a single term; switching the toggle re-prices the items already
  in it (`convertItemsToBilling`),
- `worker/checkout.ts` rejects a mixed cart with 400 instead of letting Stripe
  return an opaque error,
- a one-time-only cart is created with `mode=payment` (subscription mode
  requires at least one recurring item), and `subscription_data[description]`
  is only sent for subscriptions (`payment_intent_data[description]`
  otherwise — the old code would have errored on a payment session).

### 2. Key spelling

The cart produces `extrapage-one-time`; the guide's `PRICE_MAP` used
`extrapage-onetime`. Both resolve now (`normalizeKey`), and
`tests/cart.test.ts` asserts that every catalog key has a Stripe price and every
Stripe price has a catalog entry, so the two can't drift apart silently.

### 3. Unknown keys are rejected, not skipped

`if (!pid) continue` would charge the customer less than the cart showed. An
unknown key now returns 400 listing it, and the checkout page displays the
message.

### 4. Client layer rewritten into `src/lib/cart-ui.ts`

Same behaviour (drawer, morphing buttons, count badge, one plan at a time) plus:

- strings from `t.cart` via `data-*` attributes instead of hard-coded English,
  so `/fr` is French and money renders as `890,99 $`,
- listeners delegated from `document` and a render pass on `astro:page-load`:
  the old inline script bound on `DOMContentLoaded` only, so the cart stopped
  working after a ClientRouter navigation,
- cross-tab `storage` sync, `aria-disabled` on the checkout link when the cart is
  empty, and a test suite (jsdom) for the whole flow.

### 5. Checkout page

Renders the selection from `webao_cart_v1`, posts `items: [{ key }]`, and does
**not** open a session when the cart is empty (the plan's fallback would have
shown “No items in cart” next to a $149 payment form). The session is created
with `expand[]=line_items`; the summary is then re-rendered from Stripe's
amounts, so the page shows what will actually be charged. `/checkout/success`
empties the cart.

### 6. Still to confirm against Stripe (not verifiable from this repo)

- The amounts behind the yearly/one-time price IDs: the cart displays ten months
  for add-ons and bundles and C$890.99 / C$1,490.99 / C$3,490.99 for plans. If
  Stripe was configured differently, the checkout summary (rendered from
  Stripe) will show the real amount — adjust `cart-catalog.ts` to match.
- Deploy the Worker for the multi-item backend: `cd worker && wrangler deploy`.

### 7. Follow-up fixes (dark-mode icons, yearly toggle, /start vs /checkout)

Three defects found on the live site after the above shipped, and what was
actually wrong:

- **Cart icons stayed dark in dark mode.** `CartButton.astro` styled the icon
  with `[data-theme="dark"] .cart-btn { color: #fff }` inside a scoped
  `<style>`. Astro scopes *every* selector in the rule, so it compiled to
  `[data-astro-cid-…][data-theme=dark] .cart-btn[…]` — and `<html>`, which
  carries `data-theme`, never gets the component's cid. The rule was dead. The
  button now uses `color: var(--ink)` like the header icon; the theme tokens do
  the switching.
- **Yearly toggle did nothing.** `src/lib/cart-ui.ts` (section 4 above) was
  never imported: `BaseLayout` still shipped the guide's original inline script
  (7d), which knows nothing about `[data-billing-opt]`, is English-only and
  binds on `DOMContentLoaded`. The inline script is gone; the layout imports
  `initCart()` and the drawer carries the `t.cart` strings as `data-*`
  attributes. The toggle styles moved from `PricingPage.astro`'s scoped CSS to
  `global.css` because `/start` now renders the same toggle. The success page's
  `data-cart-clear` hook also works now (it was handled by cart-ui only).
- **`/start` and `/checkout` were two competing checkouts.** `/start` posted a
  fixed C$149/month session (`STRIPE_PRICE_ID`) that ignored the cart and
  notified the owner with `form: "start"`, which the Worker rejects (400);
  `/checkout` priced the cart but had no customer details, loaded Stripe.js as a
  deferred module while checking `window.Stripe` synchronously (so it failed on
  a fresh load), never unmounted the embedded checkout (Stripe allows one per
  page, so going back and forth broke it), and the French page didn't send
  `locale: "fr"` (English success URL). Resolution: one funnel —
  `/start` = details step (`StartPage.astro` + `src/lib/start-ui.ts`),
  `/checkout` = payment step (`CheckoutPage.astro`). Details are passed in
  `sessionStorage` (`webao-checkout`); `/checkout` refuses to open a session
  without them (back to `/start`) or without a cart (link to pricing).
  Stripe.js is loaded on demand, the checkout is unmounted on
  `astro:before-swap`, and cart changes while paying rebuild the session. The
  drawer's checkout button now goes to `/start`; the sticky "Start →" bar is
  hidden on both steps. The success page no longer claims "$149/month" when it
  has no cart to show.

Tests: `tests/start-ui.test.ts` (jsdom) covers the details step; the
integration suite drives the built `/start` and `/checkout` pages, including the
no-details and empty-cart guards.

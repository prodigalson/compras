import {
  webkit,
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Cookie,
} from "playwright";
import { loadSession, saveSession, clearSession } from "../../session.ts";
import type {
  Product,
  Cart,
  CartItem,
  DeliverySlot,
  Order,
  OrderConfirmation,
  CookieData,
  CliResult,
} from "../../types.ts";
import type { GroceryPlatform } from "../platform.ts";

const PLATFORM = "continente";
const BASE_URL = "https://www.continente.pt";
const SESSION_TTL_HOURS = 12;
const NAV_TIMEOUT = 30000;

// ─── Selectors discovered from Continente's SFCC/Demandware site ────────────

const SEL = {
  // Cookie consent (OneTrust)
  cookieAccept: '#onetrust-accept-btn-handler',

  // Login (continente.pt/login/)
  loginEmail: 'input[name="loginEmail"], input[type="email"], input#login-form-email',
  loginPassword: 'input[name="loginPassword"], input[type="password"], input#login-form-password',
  loginSubmit: 'button[type="submit"].btn-primary, button:has-text("Entrar"), form[action*="Login"] button[type="submit"]',

  // Search
  searchInput: 'input[name="q"], input[type="search"], input[placeholder*="Pesquis"]',
  searchButton: 'button[type="submit"][aria-label*="Pesquis"], button.search-button',

  // Product tiles (SFCC Demandware patterns)
  productTile: '.product-tile, [data-pid], .product, .ct-product-tile',
  productName: '.product-tile .pdp-link a, .product-tile .product-name, .ct-tile-name, [data-pid] .pdp-link',
  productPrice: '.product-tile .sales .value, .product-tile .price .value, .ct-price-value',
  addToCartBtn: 'button.add-to-cart, button[data-action="add-to-cart"], .add-to-cart-btn, button:has-text("Adicionar")',
  productImage: '.product-tile img.tile-image, .product-tile img',

  // Cart
  cartIcon: '.minicart-link, a[href*="carrinho"], .cart-icon',
  cartItem: '.card.product-info, .line-item-row, .cart-product, .ct-cart-item',
  cartItemName: '.line-item-name, .product-name a, .ct-cart-item-name',
  cartItemPrice: '.line-item-price-info .value, .unit-price .value, .ct-cart-item-price',
  cartItemQty: '.quantity-form input, select.quantity, input[name="quantity"]',
  cartItemRemove: 'button.remove-product, button.remove-btn, button:has-text("Remover")',
  cartTotal: '.grand-total .value, .order-total .value, .ct-cart-total',

  // Delivery slots
  slotContainer: '.delivery-slot, .slot-picker, .ct-slot',
  slotButton: '.slot-button, button[data-slot], .ct-slot-btn',
  slotAvailable: '.available, .slot-available, :not(.unavailable):not(.disabled)',

  // Orders
  orderItem: '.order-history-item, .order-card, .ct-order',
  orderReorderBtn: 'button:has-text("Repetir"), button:has-text("Voltar a encomendar"), a:has-text("Repetir")',

  // Checkout confirm
  confirmBtn: 'button:has-text("Confirmar"), button:has-text("Finalizar"), button.place-order',
} as const;

// ─── Cookie conversion ──────────────────────────────────────────────────────

function plCookieToCookieData(c: Cookie): CookieData {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite as string,
  };
}

function cookieDataToPlCookie(c: CookieData): Cookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: (c.sameSite as "Strict" | "Lax" | "None") ?? "Lax",
  };
}

// ─── Match scoring (language-agnostic) ──────────────────────────────────────

function computeMatchScore(query: string, product: { name: string; brand?: string }): number {
  const q = query.toLowerCase().trim();
  const name = product.name.toLowerCase();
  const brand = (product.brand ?? "").toLowerCase();
  const full = `${name} ${brand}`;

  if (name === q) return 1.0;
  if (full.includes(q)) return 0.9;

  const words = q.split(/\s+/).filter(Boolean);
  const allPresent = words.every((w) => full.includes(w));
  if (allPresent) return 0.7 + (0.1 * words.length / Math.max(words.length, full.split(/\s+/).length));

  const matched = words.filter((w) => full.includes(w));
  if (matched.length > 0) return 0.3 + (0.3 * matched.length / words.length);

  return 0.1;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class ContinenteClient implements GroceryPlatform {
  readonly platformId = PLATFORM;
  readonly displayName = "Continente";
  readonly baseUrl = BASE_URL;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private async launch(headless = true): Promise<void> {
    // Try WebKit first (better WAF evasion), fall back to Chromium
    try {
      this.browser = await webkit.launch({ headless });
    } catch {
      try {
        this.browser = await chromium.launch({ headless });
      } catch (e: unknown) {
        const msg = String(e);
        if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
          throw new Error(
            "Playwright browsers not installed. Run: bunx playwright install webkit"
          );
        }
        throw e;
      }
    }

    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      locale: "pt-PT",
      viewport: { width: 1280, height: 800 },
    });

    const session = loadSession(PLATFORM);
    if (session?.cookies?.length) {
      await this.context.addCookies(session.cookies.map(cookieDataToPlCookie));
    }

    this.page = await this.context.newPage();
  }

  private async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  private async getPage(): Promise<Page> {
    if (!this.page) throw new Error("Browser not initialized");
    return this.page;
  }

  private async persistSession(username?: string): Promise<void> {
    if (!this.context) return;
    const cookies = await this.context.cookies();
    saveSession({
      platform: PLATFORM,
      cookies: cookies.map(plCookieToCookieData),
      savedAt: new Date().toISOString(),
      username,
    });
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    try {
      const btn = await page.waitForSelector(SEL.cookieAccept, { timeout: 5000 });
      if (btn) await btn.click();
      await page.waitForTimeout(500);
    } catch {
      // No banner
    }
  }

  private async waitForPageReady(page: Page, opts?: { selector?: string }): Promise<void> {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT });
    } catch {
      // Continue anyway
    }

    if (opts?.selector) {
      try {
        await page.waitForSelector(opts.selector, { timeout: 15000 });
      } catch {
        // Target element not found, proceed anyway
      }
    }
  }

  async checkConnectivity(): Promise<{ reachable: boolean; error?: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(BASE_URL, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      return { reachable: res.ok || res.status < 500 };
    } catch {
      return {
        reachable: false,
        error: "Cannot reach continente.pt. Check your internet connection.",
      };
    }
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  async login(
    username: string,
    password: string,
    opts: { headless?: boolean } = {}
  ): Promise<{ ok: boolean; error?: string; mfaRequired?: boolean }> {
    try {
      const conn = await this.checkConnectivity();
      if (!conn.reachable) {
        return { ok: false, error: conn.error ?? "Cannot reach Continente" };
      }

      await this.launch(opts.headless ?? false);
      const page = await this.getPage();

      if (this.context) {
        await this.context.clearCookies();
      }

      await page.goto(`${BASE_URL}/login/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await this.dismissCookieBanner(page);

      // Wait for login form
      const emailField = await page.waitForSelector(SEL.loginEmail, { timeout: 15000 });
      const passField = await page.waitForSelector(SEL.loginPassword, { timeout: 5000 });

      await emailField.fill(username);
      await passField.fill(password);

      const submitBtn = await page.waitForSelector(SEL.loginSubmit, { timeout: 5000 });
      await submitBtn.click();

      // Wait for navigation after login
      try {
        await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 30000 });
      } catch {
        // Check if still on login page (credentials error)
        const currentUrl = page.url();
        if (currentUrl.includes("/login")) {
          const errorEl = await page.$('[class*="error"], [class*="alert-danger"], .invalid-feedback');
          const errorText = errorEl ? await errorEl.textContent() : null;

          // Check for CAPTCHA
          const hasCaptcha = await page.$('iframe[src*="recaptcha"], iframe[src*="captcha"], .g-recaptcha');
          if (hasCaptcha && !opts.headless) {
            console.error("\nCAPTCHA detected. Complete it in the browser window, then press Enter.\n");
            await new Promise((res) => process.stdin.once("data", res));
            try {
              await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 30000 });
            } catch {
              // Save anyway
            }
          } else if (hasCaptcha) {
            await this.close();
            return {
              ok: false,
              error: "CAPTCHA detected. Run login without --headless (default) to solve it in the browser.",
            };
          } else {
            await this.close();
            return {
              ok: false,
              error: errorText?.trim() || "Login failed. Check your credentials.",
            };
          }
        }
      }

      await page.waitForTimeout(2000);
      await this.persistSession(username);
      await this.close();
      return { ok: true };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async logout(): Promise<void> {
    clearSession(PLATFORM);
  }

  async checkSession(): Promise<{
    valid: boolean;
    username?: string;
    ageHours?: number;
  }> {
    const session = loadSession(PLATFORM);
    if (!session) return { valid: false };

    const ageHours = (Date.now() - new Date(session.savedAt).getTime()) / 1000 / 60 / 60;
    if (ageHours > SESSION_TTL_HOURS) {
      return { valid: false, ageHours };
    }

    try {
      await this.launch(true);
      const page = await this.getPage();
      await page.goto(`${BASE_URL}/area-pessoal/`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForPageReady(page);
      const url = page.url();
      await this.close();

      const isLoggedIn = !url.includes("/login");
      return { valid: isLoggedIn, username: session.username, ageHours };
    } catch {
      await this.close();
      return { valid: false };
    }
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  async search(
    query: string,
    opts: { maxResults?: number } = {}
  ): Promise<Product[]> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: compras continente login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      // Intercept API responses for product data
      const apiResponses: { url: string; data: unknown }[] = [];
      page.on("response", async (response) => {
        const url = response.url();
        if (
          url.includes("/Search-Show") ||
          url.includes("/search") ||
          url.includes("/products") ||
          url.includes("q=")
        ) {
          try {
            const ct = response.headers()["content-type"] ?? "";
            if (ct.includes("json")) {
              const data = await response.json();
              apiResponses.push({ url, data });
            }
          } catch {
            // Not JSON
          }
        }
      });

      const searchUrl = `${BASE_URL}/pesquisa/?q=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.productTile });

      const products: Product[] = [];

      // 1. Try API responses first
      for (const resp of apiResponses) {
        const extracted = this.extractProductsFromApiResponse(resp.data);
        products.push(...extracted);
      }

      // 2. DOM scraping fallback
      if (products.length === 0) {
        const domProducts = await page.evaluate((): Product[] => {
          const results: Product[] = [];
          const tiles = document.querySelectorAll('.product-tile, [data-pid], .ct-product-tile');

          tiles.forEach((tile) => {
            const pid = tile.getAttribute("data-pid") ?? "";
            const nameEl = tile.querySelector('.pdp-link a, .product-name, .ct-tile-name, a[title]');
            const name = nameEl?.textContent?.trim() || nameEl?.getAttribute("title") || "";
            if (!name) return;

            const href = nameEl?.closest("a")?.getAttribute("href") ??
                         tile.querySelector("a")?.getAttribute("href") ?? "";
            const fullUrl = href.startsWith("http") ? href : `https://www.continente.pt${href}`;

            const priceEl = tile.querySelector('.sales .value, .price .value, [content], .ct-price-value');
            const priceContent = priceEl?.getAttribute("content") ?? "";
            const priceText = priceEl?.textContent?.trim() ?? "";
            const price = parseFloat(priceContent || priceText.replace(/[^\d,\.]/g, "").replace(",", ".")) || 0;

            const perUnitEl = tile.querySelector('.price-per-unit, .unit-price');
            const pricePerUnit = perUnitEl?.textContent?.trim();

            const imgEl = tile.querySelector("img");
            const imageUrl = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-src") || undefined;

            const brandEl = tile.querySelector('.product-brand, .brand');
            const brand = brandEl?.textContent?.trim();

            results.push({
              id: pid || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32),
              name,
              brand,
              price,
              pricePerUnit,
              url: fullUrl,
              imageUrl,
              available: true,
            });
          });

          return results;
        });
        products.push(...domProducts);
      }

      // Add match scores and sort
      for (const p of products) {
        p.matchScore = computeMatchScore(query, p);
      }
      products.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));

      await this.close();
      const maxResults = opts.maxResults ?? 20;
      return products.slice(0, maxResults);
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }

  private extractProductsFromApiResponse(data: unknown): Product[] {
    const products: Product[] = [];
    if (!data || typeof data !== "object") return products;

    if (Array.isArray(data)) {
      for (const item of data) {
        const p = this.parseProductObject(item);
        if (p) products.push(p);
      }
      return products;
    }

    const obj = data as Record<string, unknown>;
    const listKeys = [
      "products", "items", "results", "content", "data",
      "productSearch", "hits", "searchResults",
    ];
    for (const key of listKeys) {
      if (Array.isArray(obj[key])) {
        for (const item of obj[key] as unknown[]) {
          const p = this.parseProductObject(item);
          if (p) products.push(p);
        }
        if (products.length > 0) return products;
      }
    }

    // SFCC nested structure: productSearch.hits
    if (obj.productSearch && typeof obj.productSearch === "object") {
      const ps = obj.productSearch as Record<string, unknown>;
      if (Array.isArray(ps.hits)) {
        for (const item of ps.hits as unknown[]) {
          const p = this.parseProductObject(item);
          if (p) products.push(p);
        }
      }
    }

    return products;
  }

  private parseProductObject(item: unknown): Product | null {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;

    const name =
      (obj.productName as string) ||
      (obj.name as string) ||
      (obj.nome as string) ||
      (obj.title as string) ||
      (obj.description as string) ||
      (obj.descricao as string);

    if (!name) return null;

    const price =
      typeof obj.price === "number"
        ? obj.price
        : typeof obj.preco === "number"
          ? obj.preco
          : parseFloat(String(obj.price ?? obj.preco ?? obj.salePrice ?? 0).replace(",", ".")) || 0;

    const id = String(
      obj.id ?? obj.pid ?? obj.productId ?? obj.sku ?? obj.codigo ??
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32)
    );

    const url =
      (obj.url as string) ||
      (obj.productUrl as string) ||
      (obj.link as string) ||
      `${BASE_URL}/produto/${id}`;

    return {
      id,
      name,
      brand: (obj.brand as string) || (obj.marca as string),
      price,
      pricePerUnit: (obj.pricePerUnit as string) || (obj.pricePerKg as string),
      unit: (obj.unit as string) || (obj.um as string),
      imageUrl: (obj.imageUrl as string) || (obj.image as string) || (obj.imagem as string),
      url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
      available: obj.available !== false && obj.disponivel !== false,
    };
  }

  // ─── Cart ──────────────────────────────────────────────────────────────────

  async addToCart(
    productUrlOrId: string,
    quantity = 1
  ): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: compras continente login");

    try {
      await this.launch(true);
      const page = await this.getPage();

      if (productUrlOrId.startsWith("http")) {
        await page.goto(productUrlOrId, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } else {
        const searchUrl = `${BASE_URL}/pesquisa/?q=${encodeURIComponent(productUrlOrId)}`;
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      }

      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.addToCartBtn });

      // Set quantity if > 1
      if (quantity > 1) {
        const qtyInput = await page.$('input[name="quantity"], select.quantity');
        if (qtyInput) {
          try {
            const tagName = await qtyInput.evaluate((el) => el.tagName.toLowerCase());
            if (tagName === "select") {
              await qtyInput.selectOption(String(quantity));
            } else {
              await qtyInput.fill(String(quantity));
            }
          } catch {
            // Continue with default qty
          }
        }
      }

      const addBtn = await page.$(SEL.addToCartBtn);
      if (!addBtn) {
        await this.close();
        return { ok: false, error: "Add to cart button not found. Product may be unavailable." };
      }

      // Listen for cart API response
      const cartResponse = page.waitForResponse(
        (res) =>
          res.request().method() === "POST" &&
          (res.url().includes("/Cart") ||
           res.url().includes("/cart") ||
           res.url().includes("/carrinho")) &&
          res.status() < 400,
        { timeout: 15000 }
      );

      await addBtn.click();

      try {
        await cartResponse;
      } catch {
        await page.waitForTimeout(5000);
      }

      await this.persistSession();
      await this.close();
      return { ok: true };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async addManyToCart(
    items: { query: string; qty?: number; pick?: string }[]
  ): Promise<{ query: string; qty: number; ok: boolean; error?: string; product?: Product }[]> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: compras continente login");

    const results: { query: string; qty: number; ok: boolean; error?: string; product?: Product }[] = [];

    await this.launch(true);
    const page = await this.getPage();

    try {
      for (const item of items) {
        const qty = item.qty ?? 1;

        try {
          const searchUrl = `${BASE_URL}/pesquisa/?q=${encodeURIComponent(item.query)}`;
          await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
          await this.dismissCookieBanner(page);
          await this.waitForPageReady(page, { selector: SEL.addToCartBtn });

          const addBtn = await page.$(SEL.addToCartBtn);
          if (!addBtn) {
            results.push({ query: item.query, qty, ok: false, error: "No products found" });
            continue;
          }

          if (qty > 1) {
            const qtyInput = await page.$('input[name="quantity"], select.quantity');
            if (qtyInput) {
              try {
                await qtyInput.fill(String(qty));
              } catch {
                // Continue with qty 1
              }
            }
          }

          await addBtn.click();
          await page.waitForTimeout(2000);
          results.push({ query: item.query, qty, ok: true });
        } catch (e: unknown) {
          results.push({ query: item.query, qty, ok: false, error: String(e) });
        }
      }

      await this.persistSession();
      await this.close();
      return results;
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }

  async getCart(): Promise<Cart> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: compras continente login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/checkout/carrinho/`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.cartItem });

      const cart = await page.evaluate((): Cart => {
        const items: CartItem[] = [];
        const cards = document.querySelectorAll(
          '.card.product-info, .line-item-row, .cart-product, .ct-cart-item, [data-pid]'
        );

        cards.forEach((card) => {
          const nameEl = card.querySelector('.line-item-name, .product-name a, .ct-cart-item-name, a[title]');
          const name = nameEl?.textContent?.trim() || nameEl?.getAttribute("title") || "";
          if (!name) return;

          const pid = card.getAttribute("data-pid") ??
                     card.querySelector("[data-pid]")?.getAttribute("data-pid") ?? "";

          const priceEl = card.querySelector('.line-item-price-info .value, .unit-price .value, .ct-cart-item-price');
          const priceText = priceEl?.textContent?.trim() ?? "0";
          const price = parseFloat(priceText.replace(/[^\d,\.]/g, "").replace(",", ".")) || 0;

          const qtyEl = card.querySelector('input[name="quantity"], select.quantity') as HTMLInputElement | null;
          const qty = qtyEl ? (parseInt(qtyEl.value) || 1) : 1;

          const subtotalEl = card.querySelector('.line-item-total-price .value, .item-total .value');
          const subtotalText = subtotalEl?.textContent?.trim() ?? "0";
          const subtotal = parseFloat(subtotalText.replace(/[^\d,\.]/g, "").replace(",", ".")) || price * qty;

          const imgEl = card.querySelector("img");
          const imageUrl = imgEl?.getAttribute("src") ?? undefined;

          const href = card.querySelector("a")?.getAttribute("href") ?? "";
          const url = href.startsWith("http") ? href : `https://www.continente.pt${href}`;

          items.push({
            id: pid || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32),
            name,
            price,
            quantity: qty,
            subtotal,
            url,
            imageUrl,
            available: true,
          });
        });

        const totalEl = document.querySelector('.grand-total .value, .order-total .value, .ct-cart-total');
        const totalText = totalEl?.textContent?.trim() ?? "0";
        const total = parseFloat(totalText.replace(/[^\d,\.]/g, "").replace(",", ".")) || 0;

        return {
          items,
          total: total || items.reduce((s, i) => s + i.subtotal, 0),
          itemCount: items.reduce((s, i) => s + i.quantity, 0),
        };
      });

      await this.close();
      return cart;
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }

  async removeFromCart(productId: string): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: compras continente login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/checkout/carrinho/`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.cartItem });

      const removed = await page.evaluate((id: string): boolean => {
        const cards = document.querySelectorAll(
          '.card.product-info, .line-item-row, .cart-product, .ct-cart-item, [data-pid]'
        );

        for (const card of cards) {
          const pid = card.getAttribute("data-pid") ??
                     card.querySelector("[data-pid]")?.getAttribute("data-pid") ?? "";
          const name = card.querySelector('.line-item-name, .product-name a')?.textContent?.trim() ?? "";

          if (pid === id || pid.includes(id) || name.toLowerCase().includes(id.toLowerCase())) {
            const removeBtn = card.querySelector(
              'button.remove-product, button.remove-btn, button[data-action="remove"]'
            ) as HTMLButtonElement | null;
            if (removeBtn) {
              removeBtn.click();
              return true;
            }
          }
        }
        return false;
      }, productId);

      if (!removed) {
        await this.close();
        return { ok: false, error: `Product "${productId}" not found in cart` };
      }

      await page.waitForTimeout(2000);
      await this.persistSession();
      await this.close();
      return { ok: true };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async updateCartItem(productId: string, quantity: number): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: compras continente login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/checkout/carrinho/`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.cartItem });

      const updated = await page.evaluate(({ id, qty }) => {
        const cards = document.querySelectorAll(
          '.card.product-info, .line-item-row, .cart-product, .ct-cart-item, [data-pid]'
        );

        for (const card of cards) {
          const pid = card.getAttribute("data-pid") ??
                     card.querySelector("[data-pid]")?.getAttribute("data-pid") ?? "";
          const name = card.querySelector('.line-item-name, .product-name a')?.textContent?.trim() ?? "";

          if (pid === id || pid.includes(id) || name.toLowerCase().includes(id.toLowerCase())) {
            const qtyInput = card.querySelector('input[name="quantity"], select.quantity') as HTMLInputElement | null;
            if (qtyInput) {
              qtyInput.value = String(qty);
              qtyInput.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
            return false;
          }
        }
        return false;
      }, { id: productId, qty: quantity });

      if (!updated) {
        await this.close();
        return { ok: false, error: `Product "${productId}" not found in cart or quantity not editable` };
      }

      await page.waitForTimeout(2000);
      await this.persistSession();
      await this.close();
      return { ok: true };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async clearCart(): Promise<{ ok: boolean; error?: string; removedCount?: number }> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: compras continente login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/checkout/carrinho/`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.cartItem });

      const removedCount = await page.evaluate((): number => {
        const deleteBtns = document.querySelectorAll(
          'button.remove-product, button.remove-btn, button[data-action="remove"]'
        );
        let count = 0;
        deleteBtns.forEach((btn) => {
          (btn as HTMLButtonElement).click();
          count++;
        });
        return count;
      });

      if (removedCount === 0) {
        await this.close();
        return { ok: true, removedCount: 0 };
      }

      await page.waitForTimeout(3000);
      await this.persistSession();
      await this.close();
      return { ok: true, removedCount };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  // ─── Delivery Slots ────────────────────────────────────────────────────────

  async getDeliverySlots(): Promise<DeliverySlot[]> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: compras continente login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      // Navigate to checkout where slots are typically shown
      await page.goto(`${BASE_URL}/checkout/`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page);

      // Try clicking a delivery schedule button if it exists
      try {
        const deliveryBtn = await page.$('button:has-text("Escolher"), button:has-text("Entrega"), .delivery-option');
        if (deliveryBtn) await deliveryBtn.click();
        await page.waitForTimeout(3000);
      } catch {
        // Continue
      }

      const slots = await page.evaluate((): DeliverySlot[] => {
        const results: DeliverySlot[] = [];

        // Look for slot elements in various formats
        const slotEls = document.querySelectorAll(
          '.delivery-slot, .slot-button, [data-slot], .ct-slot, ' +
          'button[class*="slot"], .time-slot, .delivery-time-slot'
        );

        const dayNames = ["segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo"];

        slotEls.forEach((el, idx) => {
          const text = el.textContent?.trim() ?? "";
          const ariaLabel = el.getAttribute("aria-label") ?? "";
          const fullText = `${text} ${ariaLabel}`.toLowerCase();

          // Extract date
          const dateMatch = fullText.match(/(\d{1,2})\s*(?:de\s*)?(\w+)|\d{1,2}\/\d{1,2}/);
          const date = dateMatch ? dateMatch[0] : `Slot ${idx + 1}`;

          // Extract time range
          const timeMatch = fullText.match(/(\d{1,2}[h:]\d{0,2})\s*[-–a]\s*(\d{1,2}[h:]\d{0,2})/);
          const timeRange = timeMatch ? `${timeMatch[1]}-${timeMatch[2]}` : text.trim();

          // Check availability
          const isDisabled = el.hasAttribute("disabled") ||
                            el.classList.contains("disabled") ||
                            el.classList.contains("unavailable") ||
                            el.getAttribute("aria-disabled") === "true";

          results.push({
            id: el.getAttribute("data-slot") ?? `${idx}-${timeRange}`,
            date,
            timeRange,
            available: !isDisabled,
          });
        });

        return results;
      });

      await this.close();
      return slots;
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }

  // ─── Place Order ───────────────────────────────────────────────────────────

  async placeOrder(slotId: string): Promise<CliResult<OrderConfirmation>> {
    const session = loadSession(PLATFORM);
    if (!session)
      return { ok: false, error: "Not logged in. Run: compras continente login", errorCode: "LOGIN_REQUIRED" };

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/checkout/`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page);

      // Get cart info
      const cartInfo = await page.evaluate((): { total: number; itemCount: number } => {
        const totalEl = document.querySelector('.grand-total .value, .order-total .value');
        const totalText = totalEl?.textContent?.trim() ?? "0";
        const total = parseFloat(totalText.replace(/[^\d,\.]/g, "").replace(",", ".")) || 0;
        const items = document.querySelectorAll('.product-line-item, .line-item-row');
        return { total, itemCount: items.length || 1 };
      });

      // Select the slot
      const slotClicked = await page.evaluate((id) => {
        const slot = document.querySelector(`[data-slot="${id}"], button[data-slot="${id}"]`) as HTMLElement | null;
        if (slot && !slot.hasAttribute("disabled")) {
          slot.click();
          return { clicked: true };
        }
        // Fallback: try by index
        const allSlots = document.querySelectorAll('.delivery-slot:not(.disabled), .slot-button:not(.disabled)');
        const idx = parseInt(id.split("-")[0], 10);
        if (!isNaN(idx) && allSlots[idx]) {
          (allSlots[idx] as HTMLElement).click();
          return { clicked: true };
        }
        return { clicked: false, error: "Slot not found" };
      }, slotId);

      if (!slotClicked.clicked) {
        await this.close();
        return { ok: false, error: slotClicked.error ?? "Failed to select slot", errorCode: "SLOT_UNAVAILABLE" };
      }

      await page.waitForTimeout(3000);

      // Click confirm
      const confirmBtn = await page.$(SEL.confirmBtn);
      if (confirmBtn) {
        await confirmBtn.click();
        await page.waitForTimeout(5000);
      }

      // Check for success
      const pageText = await page.textContent("body");
      const orderIdMatch = pageText?.match(/(?:encomenda|order)\s*[#:\s]*(\d{6,})/i);

      await this.persistSession();
      await this.close();

      const dayHeaders = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"];
      const [dayIdxStr, ...timeRangeParts] = slotId.split("-");
      const dayIdx = parseInt(dayIdxStr, 10);

      return {
        ok: true,
        data: {
          orderId: orderIdMatch?.[1],
          slot: {
            id: slotId,
            date: dayHeaders[dayIdx] ?? `Day ${dayIdx}`,
            timeRange: timeRangeParts.join("-"),
            available: true,
          },
          total: cartInfo.total,
          itemCount: cartInfo.itemCount,
        },
      };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e), errorCode: "ORDER_FAILED" };
    }
  }

  // ─── Reorder ───────────────────────────────────────────────────────────────

  async reorder(orderId?: string): Promise<CliResult<{
    sourceOrderId: string;
    results: { name: string; ok: boolean; error?: string }[];
    added: number;
    total: number;
  }>> {
    const session = loadSession(PLATFORM);
    if (!session)
      return { ok: false, error: "Not logged in. Run: compras continente login", errorCode: "LOGIN_REQUIRED" };

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/area-pessoal/encomendas/`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page);

      // Try native reorder button
      const reorderBtn = await page.$(SEL.orderReorderBtn);
      if (reorderBtn) {
        await reorderBtn.click();
        await page.waitForTimeout(5000);
        await this.persistSession();
        await this.close();
        return {
          ok: true,
          data: {
            sourceOrderId: orderId ?? "last",
            results: [{ name: "All items (native reorder)", ok: true }],
            added: 1,
            total: 1,
          },
        };
      }

      // Fallback: scrape order items and add individually
      const orderItems = await page.evaluate(() => {
        const items: { name: string; url: string }[] = [];
        const els = document.querySelectorAll(
          '.order-product a, .order-item a[href*="/produto"], .ct-order a'
        );
        for (const el of els) {
          const name = el.textContent?.trim() ?? "";
          const href = el.getAttribute("href") ?? "";
          if (name && href) items.push({ name, url: href.startsWith("http") ? href : `https://www.continente.pt${href}` });
        }
        return items;
      });

      if (orderItems.length === 0) {
        await this.close();
        return { ok: false, error: "No order items found to reorder", errorCode: "PRODUCT_NOT_FOUND" };
      }

      const results: { name: string; ok: boolean; error?: string }[] = [];
      for (const item of orderItems) {
        try {
          await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
          await this.waitForPageReady(page, { selector: SEL.addToCartBtn });
          const addBtn = await page.$(SEL.addToCartBtn);
          if (addBtn) {
            await addBtn.click();
            await page.waitForTimeout(2000);
            results.push({ name: item.name, ok: true });
          } else {
            results.push({ name: item.name, ok: false, error: "Add button not found" });
          }
        } catch (e: unknown) {
          results.push({ name: item.name, ok: false, error: String(e) });
        }
      }

      await this.persistSession();
      await this.close();

      const added = results.filter((r) => r.ok).length;
      return {
        ok: true,
        data: { sourceOrderId: orderId ?? "last", results, added, total: results.length },
      };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e), errorCode: "UNKNOWN" };
    }
  }

  // ─── Orders ────────────────────────────────────────────────────────────────

  async getOrders(limit = 10): Promise<Order[]> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: compras continente login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/area-pessoal/encomendas/`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page);

      const orders = await page.evaluate((): Order[] => {
        const results: Order[] = [];

        const orderEls = document.querySelectorAll(
          '.order-history-item, .order-card, .ct-order, [class*="order-item"], [class*="encomenda"]'
        );

        orderEls.forEach((el) => {
          const text = el.textContent?.trim() ?? "";
          if (!text || text.length > 500) return;

          const idMatch = text.match(/(?:encomenda|order|#)\s*[:\s]*(\d{6,})/i) ||
                          text.match(/(\d{8,})/);
          const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
          const totalMatch = text.match(/(?:total|subtotal)\s*[:\s]*([\d,\.]+)\s*€/i) ||
                             text.match(/([\d,\.]+)\s*€/);

          const statusKeywords = [
            "entregue", "em preparacao", "em entrega", "cancelada", "confirmada", "concluida",
          ];
          const status = statusKeywords.find((s) => text.toLowerCase().includes(s)) ?? "unknown";

          if (idMatch || dateMatch) {
            results.push({
              id: idMatch?.[1] ?? String(results.length + 1),
              date: dateMatch?.[1] ?? "",
              status,
              total: totalMatch ? parseFloat(totalMatch[1].replace(",", ".")) : 0,
            });
          }
        });

        return results;
      });

      await this.close();
      return orders.slice(0, limit);
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }
}

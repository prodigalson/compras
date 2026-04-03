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

const PLATFORM = "pingo-doce";
const BASE_URL = "https://www.pingodoce.pt";
const SESSION_TTL_HOURS = 12;
const NAV_TIMEOUT = 30000;

// ─── Selectors for Pingo Doce online ────────────────────────────────────────
// Pingo Doce uses Cloudflare + ASP.NET backend. Selectors need live validation.

const SEL = {
  // Cookie consent
  cookieAccept: '#onetrust-accept-btn-handler, button:has-text("Aceitar"), [data-testid="cookie-accept"]',

  // Login
  loginEmail: 'input[type="email"], input[name="email"], input[name="username"], #email',
  loginPassword: 'input[type="password"], input[name="password"], #password',
  loginSubmit: 'button[type="submit"]:has-text("Entrar"), button:has-text("Iniciar"), form button[type="submit"]',

  // Search
  searchInput: 'input[type="search"], input[name="q"], input[placeholder*="Pesquis"], input[placeholder*="procur"]',

  // Product tiles
  productTile: '[data-testid="product-card"], .product-card, .product-tile, [data-product-id]',
  productName: '.product-card .product-name, .product-tile a, [data-testid="product-name"]',
  productPrice: '.product-card .product-price, [data-testid="product-price"], .price',
  addToCartBtn: 'button:has-text("Adicionar"), button[data-testid="add-to-cart"], .add-to-cart, button:has-text("Comprar")',
  productImage: '.product-card img, [data-testid="product-image"]',

  // Cart
  cartItem: '.cart-item, .basket-item, [data-testid="cart-item"], .cart-product',
  cartItemName: '.cart-item-name, .product-name, [data-testid="cart-item-name"]',
  cartItemPrice: '.cart-item-price, .item-price, [data-testid="cart-item-price"]',
  cartItemQty: 'input[type="number"], input[name="quantity"], select.quantity',
  cartItemRemove: 'button:has-text("Remover"), button[data-testid="remove-item"], .remove-item',
  cartTotal: '.cart-total, .basket-total, [data-testid="cart-total"]',

  // Delivery slots
  slotButton: '.delivery-slot, .slot-option, [data-testid="slot"], button[data-slot]',

  // Orders
  orderItem: '.order-item, .order-card, [data-testid="order"]',
  orderReorderBtn: 'button:has-text("Repetir"), button:has-text("Voltar a encomendar")',

  // Checkout
  confirmBtn: 'button:has-text("Confirmar"), button:has-text("Finalizar"), button:has-text("Encomendar")',
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

// ─── Match scoring ──────────────────────────────────────────────────────────

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

export class PingoDoceClient implements GroceryPlatform {
  readonly platformId = PLATFORM;
  readonly displayName = "Pingo Doce";
  readonly baseUrl = BASE_URL;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private async launch(headless = true): Promise<void> {
    // Pingo Doce uses Cloudflare — try WebKit first for WAF evasion
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
      // Continue
    }

    // Extra wait for Cloudflare challenge to clear
    try {
      await page.waitForFunction(
        () => !document.querySelector('#challenge-running, .cf-challenge-running'),
        { timeout: 15000 }
      );
    } catch {
      // No challenge or timed out
    }

    if (opts?.selector) {
      try {
        await page.waitForSelector(opts.selector, { timeout: 15000 });
      } catch {
        // Continue
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
      // Cloudflare may return 403 for bots but the site is still reachable
      return { reachable: res.status !== 0 };
    } catch {
      return {
        reachable: false,
        error: "Cannot reach pingodoce.pt. Check your internet connection.",
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
      await this.launch(opts.headless ?? false);
      const page = await this.getPage();

      if (this.context) {
        await this.context.clearCookies();
      }

      // Navigate to login page
      await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.loginEmail });

      // Check for Cloudflare challenge
      const hasCfChallenge = await page.$('#challenge-running, .cf-challenge-running, #cf-challenge-running');
      if (hasCfChallenge && !opts.headless) {
        console.error("\nCloudflare challenge detected. Complete it in the browser window, then press Enter.\n");
        await new Promise((res) => process.stdin.once("data", res));
        await this.waitForPageReady(page, { selector: SEL.loginEmail });
      } else if (hasCfChallenge) {
        await this.close();
        return {
          ok: false,
          error: "Cloudflare challenge blocked access. Run login without --headless (default) to solve it.",
        };
      }

      const emailField = await page.waitForSelector(SEL.loginEmail, { timeout: 15000 });
      const passField = await page.waitForSelector(SEL.loginPassword, { timeout: 5000 });

      await emailField.fill(username);
      await passField.fill(password);

      const submitBtn = await page.waitForSelector(SEL.loginSubmit, { timeout: 5000 });
      await submitBtn.click();

      // Wait for redirect away from login
      try {
        await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 30000 });
      } catch {
        const currentUrl = page.url();
        if (currentUrl.includes("/login")) {
          const errorEl = await page.$('[class*="error"], [class*="alert"], .invalid-feedback');
          const errorText = errorEl ? await errorEl.textContent() : null;
          await this.close();
          return { ok: false, error: errorText?.trim() || "Login failed. Check your credentials." };
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
      await page.goto(`${BASE_URL}/conta/`, {
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
    if (!session) throw new Error("Not logged in. Run: compras pingo-doce login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      const apiResponses: { url: string; data: unknown }[] = [];
      page.on("response", async (response) => {
        const url = response.url();
        if (
          url.includes("/search") ||
          url.includes("/products") ||
          url.includes("/pesquisa") ||
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

      const searchUrl = `${BASE_URL}/pesquisa?q=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.productTile });

      const products: Product[] = [];

      // 1. API responses
      for (const resp of apiResponses) {
        const extracted = this.extractProductsFromApiResponse(resp.data);
        products.push(...extracted);
      }

      // 2. DOM scraping
      if (products.length === 0) {
        const domProducts = await page.evaluate((): Product[] => {
          const results: Product[] = [];
          const tiles = document.querySelectorAll(
            '[data-testid="product-card"], .product-card, .product-tile, [data-product-id]'
          );

          tiles.forEach((tile) => {
            const pid = tile.getAttribute("data-product-id") ??
                       tile.getAttribute("data-testid-id") ?? "";

            const nameEl = tile.querySelector('.product-name, [data-testid="product-name"], a[title], h3, h4');
            const name = nameEl?.textContent?.trim() || nameEl?.getAttribute("title") || "";
            if (!name) return;

            const href = tile.querySelector("a")?.getAttribute("href") ?? "";
            const fullUrl = href.startsWith("http") ? href : `https://www.pingodoce.pt${href}`;

            const priceEl = tile.querySelector('.product-price, [data-testid="product-price"], .price');
            const priceText = priceEl?.textContent?.trim() ?? "0";
            const price = parseFloat(priceText.replace(/[^\d,\.]/g, "").replace(",", ".")) || 0;

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
    const listKeys = ["products", "items", "results", "content", "data", "hits", "searchResults"];
    for (const key of listKeys) {
      if (Array.isArray(obj[key])) {
        for (const item of obj[key] as unknown[]) {
          const p = this.parseProductObject(item);
          if (p) products.push(p);
        }
        if (products.length > 0) return products;
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
    if (!session) throw new Error("Not logged in. Run: compras pingo-doce login");

    try {
      await this.launch(true);
      const page = await this.getPage();

      if (productUrlOrId.startsWith("http")) {
        await page.goto(productUrlOrId, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } else {
        const searchUrl = `${BASE_URL}/pesquisa?q=${encodeURIComponent(productUrlOrId)}`;
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      }

      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.addToCartBtn });

      if (quantity > 1) {
        const qtyInput = await page.$(SEL.cartItemQty);
        if (qtyInput) {
          try {
            await qtyInput.fill(String(quantity));
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

      const cartResponse = page.waitForResponse(
        (res) =>
          res.request().method() === "POST" &&
          (res.url().includes("/cart") ||
           res.url().includes("/basket") ||
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
    if (!session) throw new Error("Not logged in. Run: compras pingo-doce login");

    const results: { query: string; qty: number; ok: boolean; error?: string; product?: Product }[] = [];
    await this.launch(true);
    const page = await this.getPage();

    try {
      for (const item of items) {
        const qty = item.qty ?? 1;
        try {
          const searchUrl = `${BASE_URL}/pesquisa?q=${encodeURIComponent(item.query)}`;
          await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
          await this.dismissCookieBanner(page);
          await this.waitForPageReady(page, { selector: SEL.addToCartBtn });

          const addBtn = await page.$(SEL.addToCartBtn);
          if (!addBtn) {
            results.push({ query: item.query, qty, ok: false, error: "No products found" });
            continue;
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
    if (!session) throw new Error("Not logged in. Run: compras pingo-doce login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/carrinho`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.cartItem });

      const cart = await page.evaluate((): Cart => {
        const items: CartItem[] = [];
        const cards = document.querySelectorAll(
          '.cart-item, .basket-item, [data-testid="cart-item"], .cart-product'
        );

        cards.forEach((card) => {
          const nameEl = card.querySelector('.cart-item-name, .product-name, [data-testid="cart-item-name"], a[title]');
          const name = nameEl?.textContent?.trim() || nameEl?.getAttribute("title") || "";
          if (!name) return;

          const pid = card.getAttribute("data-product-id") ?? "";
          const priceEl = card.querySelector('.cart-item-price, .item-price, [data-testid="cart-item-price"]');
          const priceText = priceEl?.textContent?.trim() ?? "0";
          const price = parseFloat(priceText.replace(/[^\d,\.]/g, "").replace(",", ".")) || 0;

          const qtyEl = card.querySelector('input[type="number"], input[name="quantity"]') as HTMLInputElement | null;
          const qty = qtyEl ? (parseInt(qtyEl.value) || 1) : 1;

          const subtotalEl = card.querySelector('.item-total, .line-total');
          const subtotalText = subtotalEl?.textContent?.trim() ?? "0";
          const subtotal = parseFloat(subtotalText.replace(/[^\d,\.]/g, "").replace(",", ".")) || price * qty;

          const imgEl = card.querySelector("img");
          const href = card.querySelector("a")?.getAttribute("href") ?? "";

          items.push({
            id: pid || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32),
            name,
            price,
            quantity: qty,
            subtotal,
            url: href.startsWith("http") ? href : `https://www.pingodoce.pt${href}`,
            imageUrl: imgEl?.getAttribute("src") ?? undefined,
            available: true,
          });
        });

        const totalEl = document.querySelector('.cart-total, .basket-total, [data-testid="cart-total"]');
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
    if (!session) throw new Error("Not logged in. Run: compras pingo-doce login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/carrinho`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.cartItem });

      const removed = await page.evaluate((id: string): boolean => {
        const cards = document.querySelectorAll(
          '.cart-item, .basket-item, [data-testid="cart-item"], .cart-product'
        );
        for (const card of cards) {
          const pid = card.getAttribute("data-product-id") ?? "";
          const name = card.querySelector('.cart-item-name, .product-name')?.textContent?.trim() ?? "";
          if (pid === id || pid.includes(id) || name.toLowerCase().includes(id.toLowerCase())) {
            const removeBtn = card.querySelector(
              'button:has-text("Remover"), button[data-testid="remove-item"], .remove-item'
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
    if (!session) throw new Error("Not logged in. Run: compras pingo-doce login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/carrinho`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.cartItem });

      const updated = await page.evaluate(({ id, qty }) => {
        const cards = document.querySelectorAll(
          '.cart-item, .basket-item, [data-testid="cart-item"], .cart-product'
        );
        for (const card of cards) {
          const pid = card.getAttribute("data-product-id") ?? "";
          const name = card.querySelector('.cart-item-name, .product-name')?.textContent?.trim() ?? "";
          if (pid === id || pid.includes(id) || name.toLowerCase().includes(id.toLowerCase())) {
            const qtyInput = card.querySelector('input[type="number"], input[name="quantity"]') as HTMLInputElement | null;
            if (qtyInput) {
              qtyInput.value = String(qty);
              qtyInput.dispatchEvent(new Event("change", { bubbles: true }));
              qtyInput.dispatchEvent(new Event("input", { bubbles: true }));
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
    if (!session) throw new Error("Not logged in. Run: compras pingo-doce login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/carrinho`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page, { selector: SEL.cartItem });

      const removedCount = await page.evaluate((): number => {
        const deleteBtns = document.querySelectorAll(
          'button:has-text("Remover"), button[data-testid="remove-item"], .remove-item'
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
    if (!session) throw new Error("Not logged in. Run: compras pingo-doce login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/checkout`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page);

      try {
        const deliveryBtn = await page.$('button:has-text("Escolher"), button:has-text("Entrega")');
        if (deliveryBtn) await deliveryBtn.click();
        await page.waitForTimeout(3000);
      } catch {
        // Continue
      }

      const slots = await page.evaluate((): DeliverySlot[] => {
        const results: DeliverySlot[] = [];
        const slotEls = document.querySelectorAll(
          '.delivery-slot, .slot-option, [data-testid="slot"], button[data-slot], ' +
          'button[class*="slot"], .time-slot'
        );

        slotEls.forEach((el, idx) => {
          const text = el.textContent?.trim() ?? "";
          const ariaLabel = el.getAttribute("aria-label") ?? "";
          const fullText = `${text} ${ariaLabel}`.toLowerCase();

          const dateMatch = fullText.match(/(\d{1,2})\s*(?:de\s*)?(\w+)|\d{1,2}\/\d{1,2}/);
          const date = dateMatch ? dateMatch[0] : `Slot ${idx + 1}`;

          const timeMatch = fullText.match(/(\d{1,2}[h:]\d{0,2})\s*[-–a]\s*(\d{1,2}[h:]\d{0,2})/);
          const timeRange = timeMatch ? `${timeMatch[1]}-${timeMatch[2]}` : text.trim();

          const isDisabled = el.hasAttribute("disabled") ||
                            el.classList.contains("disabled") ||
                            el.classList.contains("unavailable");

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

  async placeOrder(slotId: string): Promise<CliResult<OrderConfirmation>> {
    const session = loadSession(PLATFORM);
    if (!session)
      return { ok: false, error: "Not logged in. Run: compras pingo-doce login", errorCode: "LOGIN_REQUIRED" };

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/checkout`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page);

      const cartInfo = await page.evaluate((): { total: number; itemCount: number } => {
        const totalEl = document.querySelector('.cart-total, .basket-total, .order-total');
        const totalText = totalEl?.textContent?.trim() ?? "0";
        const total = parseFloat(totalText.replace(/[^\d,\.]/g, "").replace(",", ".")) || 0;
        const items = document.querySelectorAll('.cart-item, .line-item');
        return { total, itemCount: items.length || 1 };
      });

      // Select slot
      const slotClicked = await page.evaluate((id) => {
        const slot = document.querySelector(`[data-slot="${id}"]`) as HTMLElement | null;
        if (slot && !slot.hasAttribute("disabled")) {
          slot.click();
          return { clicked: true };
        }
        const allSlots = document.querySelectorAll('.delivery-slot:not(.disabled), [data-testid="slot"]:not([disabled])');
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

      const confirmBtn = await page.$(SEL.confirmBtn);
      if (confirmBtn) {
        await confirmBtn.click();
        await page.waitForTimeout(5000);
      }

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
      return { ok: false, error: "Not logged in. Run: compras pingo-doce login", errorCode: "LOGIN_REQUIRED" };

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/conta/encomendas`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page);

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

      const orderItems = await page.evaluate(() => {
        const items: { name: string; url: string }[] = [];
        const els = document.querySelectorAll('.order-product a, .order-item a[href*="/produto"]');
        for (const el of els) {
          const name = el.textContent?.trim() ?? "";
          const href = el.getAttribute("href") ?? "";
          if (name && href) items.push({ name, url: href.startsWith("http") ? href : `https://www.pingodoce.pt${href}` });
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
    if (!session) throw new Error("Not logged in. Run: compras pingo-doce login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/conta/encomendas`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await this.dismissCookieBanner(page);
      await this.waitForPageReady(page);

      const orders = await page.evaluate((): Order[] => {
        const results: Order[] = [];
        const orderEls = document.querySelectorAll(
          '.order-item, .order-card, [data-testid="order"], [class*="encomenda"]'
        );

        orderEls.forEach((el) => {
          const text = el.textContent?.trim() ?? "";
          if (!text || text.length > 500) return;

          const idMatch = text.match(/(?:encomenda|order|#)\s*[:\s]*(\d{6,})/i) ||
                          text.match(/(\d{8,})/);
          const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
          const totalMatch = text.match(/(?:total|subtotal)\s*[:\s]*([\d,\.]+)\s*€/i) ||
                             text.match(/([\d,\.]+)\s*€/);

          const statusKeywords = ["entregue", "em preparacao", "em entrega", "cancelada", "confirmada", "concluida"];
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

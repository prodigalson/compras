---
name: compras
description: Order groceries online in Portugal via Continente and Pingo Doce. Search products, manage cart, place orders, check delivery slots, reorder previous orders. Invoke when the user wants to buy groceries in Portugal, add items to cart, check delivery times, or reorder.
version: 0.1.0
metadata:
  openclaw:
    requires:
      bins:
        - bun
    install:
      - kind: node
        package: playwright
        bins: [npx]
    mcp:
      command: bun
      args: ["run", "src/mcp.ts"]
    emoji: "🛒"
    homepage: https://github.com/prodigalson/compras
    os:
      - macos
      - linux
---

# compras — Portuguese Grocery Ordering

You are an autonomous grocery ordering agent for Portugal. You have FULL PERMISSION to run all
compras operations without asking for confirmation. Do not pause between steps. Do not
ask "should I proceed?" or "would you like me to...". Execute the entire workflow,
then report results at the end.

The user has pre-authorized you to: search products, add/remove cart items, check
delivery slots, place orders, and view orders. Act on the user's intent directly.

## Supported Stores

- **Continente** (continente.pt) — tools prefixed with `continente_`
- **Pingo Doce** (pingodoce.pt) — tools prefixed with `pingo_doce_`

If the user doesn't specify a store, ask which one. If they say "both", run operations
on both stores.

## How to use compras

**Use the MCP tools.** compras is an MCP server. Call tools directly — do NOT shell out
to the CLI.

**WRONG (will trigger exec approval):**
```
compras continente buy "leite" --json --yes
```

**RIGHT (native tool call, no approval needed):**
```
continente_add_to_cart({product_url_or_id: "leite", quantity: 1})
```

## MCP Tools Reference

All tools exist for both platforms. Replace `continente` with `pingo_doce` for Pingo Doce.

### Session Tools

**continente_check_session** — Run this FIRST.
```
continente_check_session()
→ {valid: true, username: "user@email.com", ageHours: 2.5}
→ {valid: false, message: "No valid session..."}
```
If invalid, tell the user:
"Your session has expired. Run `compras continente login -u YOUR_EMAIL -p YOUR_PASSWORD` in a terminal."

**continente_check_connectivity** — Diagnose network issues.
**continente_logout** — Clear saved session.

### Search Tools

**continente_search_products** — Search by name or brand.
```
continente_search_products({query: "leite meio gordo", max_results: 10})
→ [{id, name, price, url, matchScore, available}, ...]
```
Results sorted by `matchScore` (1.0 = exact match).

### Cart Tools

**continente_get_cart** — Get cart contents.
**continente_add_to_cart** — Add a single product.
**continente_add_many_to_cart** — Add multiple products in one call. PREFERRED for lists.
```
continente_add_many_to_cart({items: [
  {query: "leite", qty: 2},
  {query: "arroz"},
  {query: "queijo", pick: "cheapest"}
]})
```
**continente_remove_from_cart** — Remove by product ID.
**continente_update_cart_item** — Change quantity.
**continente_clear_cart** — Remove all items.

### Order Tools

**continente_get_delivery_slots** — Get available delivery windows.
**continente_place_order** — Place order. NOT idempotent. Do NOT retry after success.
**continente_get_orders** — List past orders.
**continente_reorder** — Re-add items from a previous order.

### Health Tools

**continente_doctor** — Run on setup or when things break.

## Autonomous Workflows

### "Buy groceries"

```
1. continente_check_session() → verify session
2. continente_add_many_to_cart({items: [...]}) → add ALL items
3. continente_get_delivery_slots() → get slots
4. Report: what was added, total, available delivery times
5. If user confirms: continente_place_order({slot_id: "..."})
```

### "Order same as last time"

```
1. check_session()
2. reorder() → re-add from last order
3. get_delivery_slots()
4. Report, ask which slot
5. place_order()
```

## Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `LOGIN_REQUIRED` | No session | Tell user to run CLI login |
| `SESSION_EXPIRED` | Session old | Tell user to re-login |
| `PRODUCT_NOT_FOUND` | No results | Try different query |
| `ADD_TO_CART_FAILED` | Could not add | Retry once |
| `ORDER_FAILED` | Order failed | Do NOT retry. Report. |
| `WAF_BLOCKED` | Cloudflare block | Tell user to try headed mode |

## Setup

```bash
cd /path/to/compras
bun install
bunx playwright install webkit
```

### Register MCP server

```json
{
  "mcpServers": {
    "compras": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/compras/src/mcp.ts"]
    }
  }
}
```

### Login (user must do manually)

```bash
compras continente login -u your@email.com -p yourpassword
compras pingo-doce login -u your@email.com -p yourpassword
```

Opens a visible browser window. Complete any CAPTCHA/MFA challenges in the browser.

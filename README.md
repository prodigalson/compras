# compras

CLI for ordering groceries online in Portugal. Supports **Continente** (continente.pt) and **Pingo Doce** (pingodoce.pt).

Search products, manage your cart, check delivery slots, and view orders — all from the terminal or as a tool for AI agents.

## Requirements

- **macOS** or **Linux**
- **[Bun](https://bun.sh)** v1.3+ runtime
- A **Continente** and/or **Pingo Doce** account with a delivery address set

## Install

```bash
# 1. Clone the repo
git clone https://github.com/prodigalson/compras.git
cd compras

# 2. Install dependencies
bun install

# 3. Install Playwright's WebKit browser engine
bunx playwright install webkit

# 4. Build the CLI wrapper
bun run build

# 5. Add to PATH (optional)
export PATH="$PWD/dist:$PATH"
```

After install, run `compras --help` to verify:

```
Usage: compras [options] [command]

CLI for ordering groceries online in Portugal

Options:
  -V, --version   output the version number
  --json          Output as JSON (for agent use)
  -y, --yes       Non-interactive mode — never prompt for confirmation
  -h, --help      display help for command

Commands:
  continente|c    Interact with Continente online grocery
  pingo-doce|pd   Interact with Pingo Doce online grocery
  help [command]  display help for command
```

## Quick Start

### 1. Log in

```bash
# Continente
compras continente login -u your@email.com -p yourpassword

# Pingo Doce
compras pingo-doce login -u your@email.com -p yourpassword
```

This opens a visible browser window (WebKit/Safari). If the site asks for CAPTCHA or MFA, complete it in the browser, then press Enter in the terminal.

Session is saved to `~/.compras/sessions/` and lasts about 12 hours.

### 2. Search for products

```bash
compras continente search "leite"
compras pingo-doce search "arroz"
```

### 3. Add to cart

```bash
# By search query (adds first result)
compras continente cart add "leite meio gordo"

# By product URL
compras continente cart add https://www.continente.pt/produto/...
```

### 4. View your cart

```bash
compras continente cart list
```

### 5. Check delivery slots

```bash
compras continente slots
```

### 6. Remove from cart

```bash
compras continente cart remove <product-id>
```

## JSON Mode (for AI agents)

Every command supports `--json` for structured output:

```bash
compras continente search "queijo" --json --limit 3
```

```json
{
  "ok": true,
  "data": [
    {
      "id": "123456",
      "name": "Queijo Flamengo Fatiado 200g",
      "price": 2.49,
      "url": "https://www.continente.pt/...",
      "available": true,
      "matchScore": 0.9
    }
  ]
}
```

Errors return `{ "ok": false, "error": "...", "errorCode": "SESSION_EXPIRED" }` with exit code 1.

## All Commands

Commands are the same for both platforms. Replace `continente` with `pingo-doce` (or use aliases `c` / `pd`).

| Command | Description |
|---------|-------------|
| `compras c login -u EMAIL -p PASS` | Log in (opens browser for MFA/CAPTCHA) |
| `compras c logout` | Clear saved session |
| `compras c status` | Check if session is valid |
| `compras c search QUERY` | Search products (`-n` for max results) |
| `compras c buy QUERY` | Search + pick + add to cart in one step |
| `compras c cart list` | Show cart contents |
| `compras c cart add URL_OR_QUERY` | Add product to cart (`-q` for quantity) |
| `compras c cart add-many --items JSON` | Add multiple products in one browser session |
| `compras c cart update ID -q QTY` | Update quantity of a cart item |
| `compras c cart remove ID` | Remove product from cart |
| `compras c cart clear` | Remove all items from cart |
| `compras c checkout` | Show cart + delivery slots in one step |
| `compras c order --slot SLOT_ID` | Place an order with a delivery slot |
| `compras c reorder` | Re-add items from most recent order |
| `compras c slots` | Show delivery time slots |
| `compras c orders` | List past orders (`-n` for limit) |
| `compras c doctor` | Check all dependencies are installed and working |

All commands accept `--json` for structured output and `-y`/`--yes` for non-interactive mode.

## How It Works

These stores don't have public APIs. This CLI uses **Playwright** with **WebKit** (Safari engine) to automate the online grocery sites:

- **WebKit, not Chromium.** Some stores' WAFs block Playwright Chromium. WebKit with a real Safari user-agent gets through.
- **Direct URL navigation.** Instead of clicking through the site, we navigate directly to search URLs, the cart page, and the orders page.
- **DOM scraping with API interception.** When available, we intercept XHR/fetch responses for product JSON before falling back to DOM scraping.
- **Cookie persistence.** Sessions are saved as Playwright cookies to `~/.compras/sessions/` and restored on each command.

## MCP Server (for AI agents)

compras includes an MCP (Model Context Protocol) server so AI agents can call grocery operations as native tool calls.

### Setup

```bash
cd /path/to/compras
bun install
bunx playwright install webkit
```

### Register with Claude Desktop / Claude Code

Add to your MCP config:

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

### Available MCP Tools

Tools are prefixed per platform: `continente_*` and `pingo_doce_*`.

| Tool | Description |
|------|-------------|
| `*_check_session` | Check if session is valid |
| `*_search_products` | Search products by name/brand |
| `*_add_to_cart` | Add single product to cart |
| `*_add_many_to_cart` | Add multiple products in one call |
| `*_get_cart` | Get cart contents |
| `*_remove_from_cart` | Remove product from cart |
| `*_update_cart_item` | Update quantity of cart item |
| `*_clear_cart` | Remove all items from cart |
| `*_get_delivery_slots` | Get delivery time slots |
| `*_place_order` | Place order with a delivery slot |
| `*_get_orders` | List past orders |
| `*_reorder` | Re-add items from a previous order |
| `*_doctor` | Health check |

### Agent workflow example

```
1. continente_check_session()                                    → verify login
2. continente_add_many_to_cart({items: [{query: "leite", qty: 2}, ...]})
3. continente_get_delivery_slots()                               → pick a slot
4. continente_place_order({slot_id: "0-09:00-10:00"})           → order
```

## Troubleshooting

**"Login failed" or CAPTCHA**
Run login without `--headless` (the default) so you can solve CAPTCHAs in the browser.

**"Not logged in"**
Run `compras continente login -u ... -p ...` again. Sessions expire after ~12 hours.

**Pingo Doce blocked by Cloudflare**
Pingo Doce uses aggressive bot protection. If headless automation fails, run login in headed mode and ensure you complete any Cloudflare challenges.

**"Add to cart button not found"**
The site may take longer to load. Retry the command.

---

## Development

```bash
bun run dev                   # Run directly without building
bun run typecheck             # Type check
bun run src/index.ts continente search "leite" --json
```

---

## Em Portugues

### O que e o compras?

**compras** e uma ferramenta de linha de comandos para fazer compras online em Portugal. Suporta **Continente** (continente.pt) e **Pingo Doce** (pingodoce.pt).

Pode pesquisar produtos, gerir o carrinho, verificar horarios de entrega e ver encomendas, tudo a partir do terminal.

### Como usar

```bash
# Iniciar sessao
compras continente login -u seu@email.com -p suapassword

# Pesquisar produtos
compras continente search "leite"

# Adicionar ao carrinho
compras continente cart add "leite meio gordo"

# Ver carrinho
compras continente cart list

# Ver horarios de entrega
compras continente slots

# Remover do carrinho
compras continente cart remove <id-produto>
```

---

## License

MIT

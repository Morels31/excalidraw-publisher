# excalidraw-publisher

Headless publishing pipeline for Obsidian notes and Excalidraw drawings using [Quartz](https://quartz.jzhao.xyz/) and Docker.

It automatically renders Excalidraw drawings into vector SVGs, syncs markdown notes, and serves a live static website.

## Important Warning

I really do not like to **SLOP** code, but i needed this, and honestly i usually care about code quality, this time i do not. Soo it's half **SLOPPED**.

## Setup

1. **Configure the environment**:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and set `VAULT_PATH`, `VAULT_SUBDIR`, and `BASE_URL`.

   > [!IMPORTANT]
   > Keep the published folder relative to your vault root (e.g. `/vault-input/<folder-name>`). For example, if you publish a subfolder called `Notes`, mount it as `/vault-input/Notes` so wikilinks like `[[Notes/...]]` resolve correctly without broken links.

2. **Create the content directories**:
   ```bash
   mkdir -p quartz-content public
   sudo chown -R 10001:10001 quartz-content public
   ```

3. **Start the service**:
   ```bash
   docker compose up -d --build
   ```

The site is served at `http://<server-ip>:8080` (`HOST_PORT` in `.env`), ready to be placed behind HAProxy or your reverse proxy.

## How it works

- **Excalidraw to SVG**: Detects drawings (both raw and compressed JSON) and renders them into self-contained SVGs with embedded fonts, images, and rasterized PDF pages.
- **Real-time watcher & cache**: Detects additions, changes, and deletions instantly, caching unchanged notes via size/mtime, with SHA-256 as a fallback.
- **Clean publishing**: Only syncs notes and web assets (`.md`, `.svg`, `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`), automatically ignoring dotfiles, `.obsidian/`, and private directories (`private/`, `templates/`).
- **Hardened containers**: The publisher runs as `10001:10001` with dropped capabilities and **no network access**; a separate nginx container serves the rendered site on port 8080 as the same user.

## Reset cache

To force a full rebuild from scratch:

```bash
docker compose down
rm -rf ./quartz-content ./public
mkdir -p quartz-content public
sudo chown -R 10001:10001 quartz-content public
docker compose up -d
```
